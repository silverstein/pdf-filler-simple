import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber } from "pdf-lib";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  CM_CODEPOINTS,
  CM_TFM_METRICS,
  CM_TFM_REFERENCE_VERSION,
  CM_WITNESS_CODEPOINTS,
} from "./type3-cm-reference.js";

const IR_NAME = "pdf-tools.extraction-ir";
const IR_VERSION = "1.4.0";
/*
 * IR_VERSION pin sweep (all must remain aligned):
 * - server/layout-extraction.js: IR_VERSION and EXTRACTION_IR_IDENTITY
 * - server/output-schemas.js: read_pdf_layout root, id_scope, and Markdown provenance
 * - server/markdown-conversion.js: supported layout identity
 * - test/read-pdf-layout.test.js, test/convert-pdf-to-markdown.test.js,
 *   test/mcp-contract.test.js, and test/pdfjs-worker-contract.test.js
 * - pdf-toolkit-mcp-share/server/layout-extraction.js and output-schemas.js
 */
const INTERNAL_SOURCE_REPLAY = Symbol("pdf-layout-internal-source-replay");
const INTERNAL_MARKDOWN_PROJECTION = Symbol("pdf-layout-internal-markdown-projection");

const RULED_RECT_PAGE_LIMIT = 512;
const RULED_RECT_AXIS_TOLERANCE = 0.5;
const RULED_RECT_MIN_SIZE = 5;
const DRAW_OPS = Object.freeze({ moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 });

/**
 * PDF.js factory directories must end with a forward slash on every platform:
 * its factory validation is literally `.endsWith("/")`, so the
 * backslash-terminated paths fileURLToPath produces on Windows fail with
 * "Invalid factory url" and take every layout operation down with them.
 * Node's fs accepts forward-slash Windows paths, so normalizing the
 * separators is sufficient and platform-neutral.
 */
export function pdfjsFactoryDirectory(nativePath) {
  const normalized = String(nativePath).replaceAll("\\", "/");
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

const PDFJS_DOCUMENT_ASSETS = Object.freeze({
  cMapUrl: pdfjsFactoryDirectory(fileURLToPath(new URL("../node_modules/pdfjs-dist/cmaps/", import.meta.url))),
  cMapPacked: true,
  standardFontDataUrl: pdfjsFactoryDirectory(fileURLToPath(new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url))),
});
const ITEM_SPACE = Object.freeze({
  origin: "top_left",
  unit: "points_1_72_in_after_user_unit",
  reference_box: "pdfjs_display_viewport",
});
const RAW_PAGE_SPACE = Object.freeze({
  basis: "pdf_default_user_space",
  unit: "pdf_user_unit",
  stage: "before_user_unit_and_page_rotation",
});
const MAX_PAINTED_RECTANGLES = 500;
const TYPE3_GLYPH_CANONICALIZER_VERSION = "pdfjs-charproc-json-v1";
const MAX_TYPE3_GLYPH_CANONICAL_NODES = 100000;
const MAX_TYPE3_GLYPH_CANONICAL_DEPTH = 32;
const MAX_TYPE3_GLYPH_CANONICAL_BYTES = 250000;

const TYPE3_RECOVERY_REGISTRY = Object.freeze([
  Object.freeze({
    id: "cmmi-pk-raster-alpha-e688a8-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 11,
    source_unicode: "\u000b",
    target_unicode: "α",
    charproc_sha256: "e688a83f98433c841694f990aabafe5245cfc9320f584d7f70da706f0eeba259",
    allow_collapsed_whitespace: true,
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 25, charproc_sha256: "780b04fa47830ca782211b86dbedfe0adec0445bdf94d538bfe7adde08ed9445" }),
      Object.freeze({ original_char_code: 26, charproc_sha256: "1500df39391626d02f9e98132f991f71899612069298e52340e12fb65590836f" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-period-2df559-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 58,
    source_unicode: ":",
    target_unicode: ".",
    charproc_sha256: "2df559091df37cc5da5c1ce3e05eebc1075c4c041b83d96a1904d2c2f21edab0",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 59, charproc_sha256: "42b5ebf435945b75e1dc1bc271bfbb4aa2dc02b8adc93cd26b4bb64dec9fde8a" }),
      Object.freeze({ original_char_code: 61, charproc_sha256: "55447dde50a97970297d189788eb154c675c41e6d2eca2836949aefadd0b1780" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-comma-42b5eb-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 59,
    source_unicode: ";",
    target_unicode: ",",
    charproc_sha256: "42b5ebf435945b75e1dc1bc271bfbb4aa2dc02b8adc93cd26b4bb64dec9fde8a",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 58, charproc_sha256: "2df559091df37cc5da5c1ce3e05eebc1075c4c041b83d96a1904d2c2f21edab0" }),
      Object.freeze({ original_char_code: 61, charproc_sha256: "55447dde50a97970297d189788eb154c675c41e6d2eca2836949aefadd0b1780" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-pi-780b04-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 25,
    source_unicode: "\u0019",
    target_unicode: "π",
    charproc_sha256: "780b04fa47830ca782211b86dbedfe0adec0445bdf94d538bfe7adde08ed9445",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 11, charproc_sha256: "e688a83f98433c841694f990aabafe5245cfc9320f584d7f70da706f0eeba259" }),
      Object.freeze({ original_char_code: 26, charproc_sha256: "1500df39391626d02f9e98132f991f71899612069298e52340e12fb65590836f" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-rho-1500df-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 26,
    source_unicode: "\u001a",
    target_unicode: "ρ",
    charproc_sha256: "1500df39391626d02f9e98132f991f71899612069298e52340e12fb65590836f",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 11, charproc_sha256: "e688a83f98433c841694f990aabafe5245cfc9320f584d7f70da706f0eeba259" }),
      Object.freeze({ original_char_code: 25, charproc_sha256: "780b04fa47830ca782211b86dbedfe0adec0445bdf94d538bfe7adde08ed9445" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-omega-81b411-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 33,
    source_unicode: "!",
    target_unicode: "ω",
    charproc_sha256: "81b41121b5e19a2aebd37331ab3584fe08221ca1afcda83f4ce8b76997177074",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 11, charproc_sha256: "e688a83f98433c841694f990aabafe5245cfc9320f584d7f70da706f0eeba259" }),
      Object.freeze({ original_char_code: 25, charproc_sha256: "780b04fa47830ca782211b86dbedfe0adec0445bdf94d538bfe7adde08ed9445" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-slash-55447d-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 61,
    source_unicode: "=",
    target_unicode: "/",
    charproc_sha256: "55447dde50a97970297d189788eb154c675c41e6d2eca2836949aefadd0b1780",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 58, charproc_sha256: "2df559091df37cc5da5c1ce3e05eebc1075c4c041b83d96a1904d2c2f21edab0" }),
      Object.freeze({ original_char_code: 59, charproc_sha256: "42b5ebf435945b75e1dc1bc271bfbb4aa2dc02b8adc93cd26b4bb64dec9fde8a" }),
    ]),
  }),
  Object.freeze({
    id: "cmsy-pk-raster-minus-fb1f6b-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-symbol",
    original_char_code: 0,
    source_unicode: "\u0000",
    target_unicode: "−",
    charproc_sha256: "fb1f6bf10138511bcefade47467b3e2f9ae691ab3dab097914be1f0f66305470",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 21, charproc_sha256: "05b4a9d88c1df64b3ac339ae6bb7ed82383b93bb08512842452db43453a28970" }),
      Object.freeze({ original_char_code: 112, charproc_sha256: "772f491fc17e6bb3bc37c17ace6be704244ab121c7180d59319726e0af4b0efc" }),
    ]),
  }),
  Object.freeze({
    id: "cmsy-pk-raster-greater-equal-05b4a9-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-symbol",
    original_char_code: 21,
    source_unicode: "\u0015",
    target_unicode: "≥",
    charproc_sha256: "05b4a9d88c1df64b3ac339ae6bb7ed82383b93bb08512842452db43453a28970",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, charproc_sha256: "fb1f6bf10138511bcefade47467b3e2f9ae691ab3dab097914be1f0f66305470" }),
      Object.freeze({ original_char_code: 112, charproc_sha256: "772f491fc17e6bb3bc37c17ace6be704244ab121c7180d59319726e0af4b0efc" }),
    ]),
  }),
  Object.freeze({
    id: "cmsy-pk-raster-square-root-772f49-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-symbol",
    original_char_code: 112,
    source_unicode: "p",
    target_unicode: "√",
    charproc_sha256: "772f491fc17e6bb3bc37c17ace6be704244ab121c7180d59319726e0af4b0efc",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, charproc_sha256: "fb1f6bf10138511bcefade47467b3e2f9ae691ab3dab097914be1f0f66305470" }),
      Object.freeze({ original_char_code: 21, charproc_sha256: "05b4a9d88c1df64b3ac339ae6bb7ed82383b93bb08512842452db43453a28970" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-omega-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 33,
    source_unicode: "!",
    target_unicode: "ω",
    charproc_sha256: "0ebf4d75e5bdb232683c871c77579bc14887f9aaa397a3c8334c220ec09af0d9",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 11, charproc_sha256: "c3d175e547d650cd0382115f3caed3b08d39f61827d10b26aad43eac6b6c4fa1" }),
      Object.freeze({ original_char_code: 25, charproc_sha256: "994283a40dea8e4890f7216ef046a865f34ef7100cc1055de62d1eba7daf8fe2" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-period-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 58,
    source_unicode: ":",
    target_unicode: ".",
    charproc_sha256: "cdf3cbb1bd7626495858ebacb74816ba82ac139458edf75c6d737f6b121b65fe",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 59, charproc_sha256: "7c69e2ebf2eec772599fae11d278adcc3c88472af6279f9801865628040d981b" }),
      Object.freeze({ original_char_code: 61, charproc_sha256: "dfa9c162caf4e99dafd16ca5d87e90f89d44c29312a2675e89aa789c5355d63e" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-slash-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 61,
    source_unicode: "=",
    target_unicode: "/",
    charproc_sha256: "dfa9c162caf4e99dafd16ca5d87e90f89d44c29312a2675e89aa789c5355d63e",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 58, charproc_sha256: "cdf3cbb1bd7626495858ebacb74816ba82ac139458edf75c6d737f6b121b65fe" }),
      Object.freeze({ original_char_code: 59, charproc_sha256: "7c69e2ebf2eec772599fae11d278adcc3c88472af6279f9801865628040d981b" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-comma-7c69e2-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 59,
    source_unicode: ";",
    target_unicode: ",",
    charproc_sha256: "7c69e2ebf2eec772599fae11d278adcc3c88472af6279f9801865628040d981b",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 58, charproc_sha256: "cdf3cbb1bd7626495858ebacb74816ba82ac139458edf75c6d737f6b121b65fe" }),
      Object.freeze({ original_char_code: 61, charproc_sha256: "dfa9c162caf4e99dafd16ca5d87e90f89d44c29312a2675e89aa789c5355d63e" }),
    ]),
  }),
  Object.freeze({
    id: "cmsy-pk-raster-minus-0c8b34-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-witness-v2",
    family: "computer-modern-math-symbol",
    original_char_code: 0,
    source_unicode: "\u0000",
    target_unicode: "−",
    charproc_sha256: "0c8b34a3281f9e8e91b2d955f952a50d187cd06c432be27c015b78570e645e9d",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 6, charproc_sha256: "b68b24c69a8802a7e57a1cabaa7c1153a0a305e5d29ba308b78d60c16a5464b7" }),
      Object.freeze({ original_char_code: 33, charproc_sha256: "6ff1e08b5364a8ce02ac2390691fdfb1f2e532bd0a1dac95d01a155bbce482fc" }),
    ]),
  }),
  Object.freeze({
    id: "cmsy-pk-raster-minus-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-symbol",
    original_char_code: 0,
    source_unicode: "\u0000",
    target_unicode: "−",
    charproc_sha256: "b32276d22e1dd4133c20888ade044d27e59f2cbdfca0901c3b9d46006ed7dee9",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 21, charproc_sha256: "b57ae2e4cf2525371916a1a4bcf0c55165b9230b1038f2d5451cdbbad5a51dcc" }),
      Object.freeze({ original_char_code: 112, charproc_sha256: "0c8ca6c662e9ca24f90a61f53206ea0719476473861471a1b04bf489b3cc37a3" }),
    ]),
  }),
  Object.freeze({
    id: "cmsy-ctan-type3-minus-v1",
    qualification: "ctan-cm-type3-labeled-reference-2026-08",
    family: "computer-modern-math-symbol",
    original_char_code: 0,
    source_unicode: "\u0000",
    target_unicode: "−",
    charproc_sha256: "f56714c48094acb5e3fdb76a62fcce203b4ed0bc60ec49f57fba5bf6ee80d91a",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 21, charproc_sha256: "b6986c1595532ddd51fad9d8148c404111da8cb112c272d66f1d0c4acaa86395" }),
      Object.freeze({ original_char_code: 112, charproc_sha256: "7d178f8e3e6ebbba7a97d5476fa81d88528b89b45fecae79124d7b497cb69973" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-period-bd8a8b-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 58,
    source_unicode: ":",
    target_unicode: ".",
    charproc_sha256: "bd8a8b68f402b7ae4df615c7fbd63e42decccc4f2dcf2cb6f56e871328466c67",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 59, charproc_sha256: "dec7c435ea1bb5cad4fb9020f992cfd9aa1c087e3b9dd144cbbe7f27f939e0f5" }),
      Object.freeze({ original_char_code: 61, charproc_sha256: "f5b035495791c897c3fdc5a86f0d8290cdd67dee1a20a33ad40663b4636eb773" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-comma-dec7c4-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 59,
    source_unicode: ";",
    target_unicode: ",",
    charproc_sha256: "dec7c435ea1bb5cad4fb9020f992cfd9aa1c087e3b9dd144cbbe7f27f939e0f5",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 58, charproc_sha256: "bd8a8b68f402b7ae4df615c7fbd63e42decccc4f2dcf2cb6f56e871328466c67" }),
      Object.freeze({ original_char_code: 61, charproc_sha256: "f5b035495791c897c3fdc5a86f0d8290cdd67dee1a20a33ad40663b4636eb773" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-slash-f5b035-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 61,
    source_unicode: "=",
    target_unicode: "/",
    charproc_sha256: "f5b035495791c897c3fdc5a86f0d8290cdd67dee1a20a33ad40663b4636eb773",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 58, charproc_sha256: "bd8a8b68f402b7ae4df615c7fbd63e42decccc4f2dcf2cb6f56e871328466c67" }),
      Object.freeze({ original_char_code: 59, charproc_sha256: "dec7c435ea1bb5cad4fb9020f992cfd9aa1c087e3b9dd144cbbe7f27f939e0f5" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-alpha-bab8ae-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 11,
    source_unicode: "\u000b",
    target_unicode: "α",
    charproc_sha256: "bab8aeb78893a19704c95538c54764abaae0cfe9d84812825f718e7687432f63",
    allow_collapsed_whitespace: true,
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 25, charproc_sha256: "3d439e1c736c51e1c18e75219c43d953b6f2c3ab588f50ceeb69f5567343492c" }),
      Object.freeze({ original_char_code: 26, charproc_sha256: "fa4a3dbc3f77e082142e29cc43e4e21aaf61fcf6ddbaefae24f1767caaea34b8" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-pi-3d439e-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 25,
    source_unicode: "\u0019",
    target_unicode: "π",
    charproc_sha256: "3d439e1c736c51e1c18e75219c43d953b6f2c3ab588f50ceeb69f5567343492c",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 11, charproc_sha256: "bab8aeb78893a19704c95538c54764abaae0cfe9d84812825f718e7687432f63" }),
      Object.freeze({ original_char_code: 26, charproc_sha256: "fa4a3dbc3f77e082142e29cc43e4e21aaf61fcf6ddbaefae24f1767caaea34b8" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-rho-fa4a3d-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 26,
    source_unicode: "\u001a",
    target_unicode: "ρ",
    charproc_sha256: "fa4a3dbc3f77e082142e29cc43e4e21aaf61fcf6ddbaefae24f1767caaea34b8",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 11, charproc_sha256: "bab8aeb78893a19704c95538c54764abaae0cfe9d84812825f718e7687432f63" }),
      Object.freeze({ original_char_code: 25, charproc_sha256: "3d439e1c736c51e1c18e75219c43d953b6f2c3ab588f50ceeb69f5567343492c" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-alpha-c3d175-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 11,
    source_unicode: "\u000b",
    target_unicode: "α",
    charproc_sha256: "c3d175e547d650cd0382115f3caed3b08d39f61827d10b26aad43eac6b6c4fa1",
    allow_collapsed_whitespace: true,
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 25, charproc_sha256: "994283a40dea8e4890f7216ef046a865f34ef7100cc1055de62d1eba7daf8fe2" }),
      Object.freeze({ original_char_code: 26, charproc_sha256: "ee4042a5a8e974c4bbcb77535105c9244e68a6d9c79181107ffab0fce453bfe0" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-pi-994283-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 25,
    source_unicode: "\u0019",
    target_unicode: "π",
    charproc_sha256: "994283a40dea8e4890f7216ef046a865f34ef7100cc1055de62d1eba7daf8fe2",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 11, charproc_sha256: "c3d175e547d650cd0382115f3caed3b08d39f61827d10b26aad43eac6b6c4fa1" }),
      Object.freeze({ original_char_code: 26, charproc_sha256: "ee4042a5a8e974c4bbcb77535105c9244e68a6d9c79181107ffab0fce453bfe0" }),
    ]),
  }),
  Object.freeze({
    id: "cmmi-pk-raster-rho-ee4042-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-italic",
    original_char_code: 26,
    source_unicode: "\u001a",
    target_unicode: "ρ",
    charproc_sha256: "ee4042a5a8e974c4bbcb77535105c9244e68a6d9c79181107ffab0fce453bfe0",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 11, charproc_sha256: "c3d175e547d650cd0382115f3caed3b08d39f61827d10b26aad43eac6b6c4fa1" }),
      Object.freeze({ original_char_code: 25, charproc_sha256: "994283a40dea8e4890f7216ef046a865f34ef7100cc1055de62d1eba7daf8fe2" }),
    ]),
  }),
  Object.freeze({
    id: "cmsy-pk-raster-greater-equal-b57ae2-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-symbol",
    original_char_code: 21,
    source_unicode: "\u0015",
    target_unicode: "≥",
    charproc_sha256: "b57ae2e4cf2525371916a1a4bcf0c55165b9230b1038f2d5451cdbbad5a51dcc",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, charproc_sha256: "b32276d22e1dd4133c20888ade044d27e59f2cbdfca0901c3b9d46006ed7dee9" }),
      Object.freeze({ original_char_code: 112, charproc_sha256: "0c8ca6c662e9ca24f90a61f53206ea0719476473861471a1b04bf489b3cc37a3" }),
    ]),
  }),
  Object.freeze({
    id: "cmsy-pk-raster-square-root-0c8ca6-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-symbol",
    original_char_code: 112,
    source_unicode: "p",
    target_unicode: "√",
    charproc_sha256: "0c8ca6c662e9ca24f90a61f53206ea0719476473861471a1b04bf489b3cc37a3",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, charproc_sha256: "b32276d22e1dd4133c20888ade044d27e59f2cbdfca0901c3b9d46006ed7dee9" }),
      Object.freeze({ original_char_code: 21, charproc_sha256: "b57ae2e4cf2525371916a1a4bcf0c55165b9230b1038f2d5451cdbbad5a51dcc" }),
    ]),
  }),
  Object.freeze({
    id: "cmsy-pk-raster-centered-dot-33077f-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-symbol",
    original_char_code: 1,
    source_unicode: "\u0001",
    target_unicode: "·",
    charproc_sha256: "33077f6f9b7f5c5631bd3cb7bbfc79b4da1fbd929b23f6e08e55c90566608c7a",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, charproc_sha256: "fb1f6bf10138511bcefade47467b3e2f9ae691ab3dab097914be1f0f66305470" }),
      Object.freeze({ original_char_code: 6, charproc_sha256: "4dedb5543e5ab5817e06920d50b7983b3febaf06c22feeb83bdbb3d8449e2c3c" }),
    ]),
  }),
  Object.freeze({
    id: "cmsy-pk-raster-less-or-equal-90da52-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-symbol",
    original_char_code: 20,
    source_unicode: "\u0014",
    target_unicode: "≤",
    charproc_sha256: "90da52fa2f67a6d3b82a7866614b7539c4e5454d2585dd223db8cb2428c6ce18",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, charproc_sha256: "fb1f6bf10138511bcefade47467b3e2f9ae691ab3dab097914be1f0f66305470" }),
      Object.freeze({ original_char_code: 1, charproc_sha256: "33077f6f9b7f5c5631bd3cb7bbfc79b4da1fbd929b23f6e08e55c90566608c7a" }),
    ]),
  }),
  Object.freeze({
    id: "cmsy-pk-raster-prime-352207-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-symbol",
    original_char_code: 48,
    source_unicode: "0",
    target_unicode: "′",
    charproc_sha256: "35220701523f8641fb0364aa66642008d3fcc04067a7a3c6b73cc2fd8b117c0c",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, charproc_sha256: "0c8b34a3281f9e8e91b2d955f952a50d187cd06c432be27c015b78570e645e9d" }),
      Object.freeze({ original_char_code: 6, charproc_sha256: "b68b24c69a8802a7e57a1cabaa7c1153a0a305e5d29ba308b78d60c16a5464b7" }),
    ]),
  }),
  Object.freeze({
    id: "cmsy-pk-raster-vertical-6ab8a7-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-symbol",
    original_char_code: 106,
    source_unicode: "j",
    target_unicode: "|",
    charproc_sha256: "6ab8a73ddd4d36b2c52a405228bde08114d463329384ad6605d5c9d5095385d0",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, charproc_sha256: "fb1f6bf10138511bcefade47467b3e2f9ae691ab3dab097914be1f0f66305470" }),
      Object.freeze({ original_char_code: 1, charproc_sha256: "33077f6f9b7f5c5631bd3cb7bbfc79b4da1fbd929b23f6e08e55c90566608c7a" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-big-left-parenthesis-eeae0f-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 0,
    source_unicode: "\u0000",
    target_unicode: "(",
    charproc_sha256: "eeae0f8c005ab72ff0fc77dda2d45be6bcca4359a98f882a1d33bf25619a6ae1",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 1, charproc_sha256: "9a0788d07694db3951c5f1b847f8d50beb1e82e0dd877cf3d75ad2b9f0de0876" }),
      Object.freeze({ original_char_code: 2, charproc_sha256: "add929da8d3840d8390cdbc6ad2746f411a6318e7c71cf97d789cac0dd24a693" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-big-right-parenthesis-9a0788-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 1,
    source_unicode: "\u0001",
    target_unicode: ")",
    charproc_sha256: "9a0788d07694db3951c5f1b847f8d50beb1e82e0dd877cf3d75ad2b9f0de0876",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, charproc_sha256: "eeae0f8c005ab72ff0fc77dda2d45be6bcca4359a98f882a1d33bf25619a6ae1" }),
      Object.freeze({ original_char_code: 2, charproc_sha256: "add929da8d3840d8390cdbc6ad2746f411a6318e7c71cf97d789cac0dd24a693" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-big-left-bracket-add929-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 2,
    source_unicode: "\u0002",
    target_unicode: "[",
    charproc_sha256: "add929da8d3840d8390cdbc6ad2746f411a6318e7c71cf97d789cac0dd24a693",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, charproc_sha256: "eeae0f8c005ab72ff0fc77dda2d45be6bcca4359a98f882a1d33bf25619a6ae1" }),
      Object.freeze({ original_char_code: 1, charproc_sha256: "9a0788d07694db3951c5f1b847f8d50beb1e82e0dd877cf3d75ad2b9f0de0876" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-big-left-bracket-24e2fb-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 2,
    source_unicode: "\u0002",
    target_unicode: "[",
    charproc_sha256: "24e2fb74862685748e4dda1996a1664497a46fb66fc842633cd13686f974cf80",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 3, charproc_sha256: "2810f1eec224c30a86c790b2b990953f0b54f28f9a32a035649784962b075cb5" }),
      Object.freeze({ original_char_code: 16, charproc_sha256: "e0188ef949df660ee321f0379d85dcde82054590708f27c0398434fbcbb9bbc3" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-big-right-bracket-a23d3c-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 3,
    source_unicode: "\u0003",
    target_unicode: "]",
    charproc_sha256: "a23d3c42be14fa95a5745ed7c8bfecb7c1f575dccfc7dcb9a64f0a7523ef914f",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, charproc_sha256: "eeae0f8c005ab72ff0fc77dda2d45be6bcca4359a98f882a1d33bf25619a6ae1" }),
      Object.freeze({ original_char_code: 1, charproc_sha256: "9a0788d07694db3951c5f1b847f8d50beb1e82e0dd877cf3d75ad2b9f0de0876" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-big-right-bracket-2810f1-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 3,
    source_unicode: "\u0003",
    target_unicode: "]",
    charproc_sha256: "2810f1eec224c30a86c790b2b990953f0b54f28f9a32a035649784962b075cb5",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 2, charproc_sha256: "24e2fb74862685748e4dda1996a1664497a46fb66fc842633cd13686f974cf80" }),
      Object.freeze({ original_char_code: 16, charproc_sha256: "e0188ef949df660ee321f0379d85dcde82054590708f27c0398434fbcbb9bbc3" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-Big-left-parenthesis-1784be-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 16,
    source_unicode: "\u0010",
    target_unicode: "(",
    charproc_sha256: "1784beab0bd30a40b0e4476f38975039ae3ab074f725b3a8b8ac7801e8c7b0c5",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, charproc_sha256: "eeae0f8c005ab72ff0fc77dda2d45be6bcca4359a98f882a1d33bf25619a6ae1" }),
      Object.freeze({ original_char_code: 1, charproc_sha256: "9a0788d07694db3951c5f1b847f8d50beb1e82e0dd877cf3d75ad2b9f0de0876" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-Big-left-parenthesis-e0188e-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 16,
    source_unicode: "\u0010",
    target_unicode: "(",
    charproc_sha256: "e0188ef949df660ee321f0379d85dcde82054590708f27c0398434fbcbb9bbc3",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 2, charproc_sha256: "24e2fb74862685748e4dda1996a1664497a46fb66fc842633cd13686f974cf80" }),
      Object.freeze({ original_char_code: 3, charproc_sha256: "2810f1eec224c30a86c790b2b990953f0b54f28f9a32a035649784962b075cb5" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-Big-right-parenthesis-fd720e-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 17,
    source_unicode: "\u0011",
    target_unicode: ")",
    charproc_sha256: "fd720e62a2ff88280ae62f59a9c3c75c64ff57767f5f6c2136e400abf6a06a4a",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, charproc_sha256: "eeae0f8c005ab72ff0fc77dda2d45be6bcca4359a98f882a1d33bf25619a6ae1" }),
      Object.freeze({ original_char_code: 1, charproc_sha256: "9a0788d07694db3951c5f1b847f8d50beb1e82e0dd877cf3d75ad2b9f0de0876" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-Big-right-parenthesis-741b0e-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 17,
    source_unicode: "\u0011",
    target_unicode: ")",
    charproc_sha256: "741b0e1ccef4470e9fc1446144de647f95d3f064c8ee0a30e932a6f0f21d5c36",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 2, charproc_sha256: "24e2fb74862685748e4dda1996a1664497a46fb66fc842633cd13686f974cf80" }),
      Object.freeze({ original_char_code: 3, charproc_sha256: "2810f1eec224c30a86c790b2b990953f0b54f28f9a32a035649784962b075cb5" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-bigg-left-parenthesis-d0c76f-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 18,
    source_unicode: "\u0012",
    target_unicode: "(",
    charproc_sha256: "d0c76fc6c61d5272b91e030c99f55649bd7a738dd57be5e5987505e317d79489",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, charproc_sha256: "eeae0f8c005ab72ff0fc77dda2d45be6bcca4359a98f882a1d33bf25619a6ae1" }),
      Object.freeze({ original_char_code: 1, charproc_sha256: "9a0788d07694db3951c5f1b847f8d50beb1e82e0dd877cf3d75ad2b9f0de0876" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-bigg-right-parenthesis-4787f4-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 19,
    source_unicode: "\u0013",
    target_unicode: ")",
    charproc_sha256: "4787f4b191732cff06605637446e648294d85d36ddbe811db3be7d3790eddd21",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, charproc_sha256: "eeae0f8c005ab72ff0fc77dda2d45be6bcca4359a98f882a1d33bf25619a6ae1" }),
      Object.freeze({ original_char_code: 1, charproc_sha256: "9a0788d07694db3951c5f1b847f8d50beb1e82e0dd877cf3d75ad2b9f0de0876" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-bigg-left-bracket-2daf02-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 20,
    source_unicode: "\u0014",
    target_unicode: "[",
    charproc_sha256: "2daf02b5e930be4e4d4cf68cb0d7fadd5f3e44238cc34e7308dd3bf39fbcf372",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, charproc_sha256: "eeae0f8c005ab72ff0fc77dda2d45be6bcca4359a98f882a1d33bf25619a6ae1" }),
      Object.freeze({ original_char_code: 1, charproc_sha256: "9a0788d07694db3951c5f1b847f8d50beb1e82e0dd877cf3d75ad2b9f0de0876" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-bigg-left-bracket-42ccb4-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 20,
    source_unicode: "\u0014",
    target_unicode: "[",
    charproc_sha256: "42ccb43e7b055f57391032b7a14079d777e45451ccb5d28b5d7ed2cbff51ea3a",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 2, charproc_sha256: "24e2fb74862685748e4dda1996a1664497a46fb66fc842633cd13686f974cf80" }),
      Object.freeze({ original_char_code: 3, charproc_sha256: "2810f1eec224c30a86c790b2b990953f0b54f28f9a32a035649784962b075cb5" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-bigg-right-bracket-50dd65-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 21,
    source_unicode: "\u0015",
    target_unicode: "]",
    charproc_sha256: "50dd658a682af9da1e5f9e3ed106d7de7cd6f7b1df172736fe38b3a21469e225",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 0, charproc_sha256: "eeae0f8c005ab72ff0fc77dda2d45be6bcca4359a98f882a1d33bf25619a6ae1" }),
      Object.freeze({ original_char_code: 1, charproc_sha256: "9a0788d07694db3951c5f1b847f8d50beb1e82e0dd877cf3d75ad2b9f0de0876" }),
    ]),
  }),
  Object.freeze({
    id: "cmex-pk-raster-bigg-right-bracket-ebfd69-v1",
    qualification: "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
    family: "computer-modern-math-extension",
    original_char_code: 21,
    source_unicode: "\u0015",
    target_unicode: "]",
    charproc_sha256: "ebfd69f0be341fbb00596c55ae708eeccc641b0174b4972f377f14ad33d35649",
    witnesses: Object.freeze([
      Object.freeze({ original_char_code: 2, charproc_sha256: "24e2fb74862685748e4dda1996a1664497a46fb66fc842633cd13686f974cf80" }),
      Object.freeze({ original_char_code: 3, charproc_sha256: "2810f1eec224c30a86c790b2b990953f0b54f28f9a32a035649784962b075cb5" }),
    ]),
  }),
  // ABSTAIN 0x52 n=2 e5fa9eb0: only 1 official witness(es) in its font
  // ABSTAIN 0x5a n=92 4a183fac: only 1 official witness(es) in its font
]);
const TYPE3_RECOVERY_BY_ID = new Map(TYPE3_RECOVERY_REGISTRY.map(entry => [entry.id, entry]));

for (const entry of TYPE3_RECOVERY_REGISTRY) {
  if (CM_CODEPOINTS[entry.family]?.[entry.original_char_code] !== entry.target_unicode) {
    throw new Error(`Type-3 registry ${entry.id} disagrees with the official Computer Modern encoding`);
  }
  const officialWitnesses = { ...CM_CODEPOINTS[entry.family], ...CM_WITNESS_CODEPOINTS[entry.family] };
  if (entry.witnesses.length < 2 || entry.witnesses.some(witness => !officialWitnesses[witness.original_char_code])) {
    throw new Error(`Type-3 registry ${entry.id} lacks two official Computer Modern witnesses`);
  }
}

function normalizeType3CanonicalValue(value, state, depth = 0) {
  if (depth > MAX_TYPE3_GLYPH_CANONICAL_DEPTH) throw new Error("Type-3 glyph program is too deeply nested");
  state.nodes += 1;
  if (state.nodes > MAX_TYPE3_GLYPH_CANONICAL_NODES) throw new Error("Type-3 glyph program is too large");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Type-3 glyph program contains a non-finite number");
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    if (value.length > MAX_TYPE3_GLYPH_CANONICAL_NODES) throw new Error("Type-3 glyph array is too large");
    return { typed: value.constructor.name, values: Array.from(value, item => normalizeType3CanonicalValue(item, state, depth + 1)) };
  }
  if (Array.isArray(value)) return value.map(item => normalizeType3CanonicalValue(item, state, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [
      key,
      normalizeType3CanonicalValue(value[key], state, depth + 1),
    ]));
  }
  throw new Error("Type-3 glyph program contains an unsupported value");
}

export function type3CharProcSha256(charProc) {
  if (!charProc || !Array.isArray(charProc.fnArray) || !Array.isArray(charProc.argsArray)) return null;
  try {
    const canonical = JSON.stringify(normalizeType3CanonicalValue({
      fnArray: charProc.fnArray,
      argsArray: charProc.argsArray,
    }, { nodes: 0 }));
    if (canonical.length > MAX_TYPE3_GLYPH_CANONICAL_BYTES) return null;
    return createHash("sha256").update(canonical).digest("hex");
  } catch {
    return null;
  }
}

function fontEncodingDifferences(font, context) {
  const encoding = context.lookup(font.get(PDFName.of("Encoding")), PDFDict);
  const differences = encoding?.lookup(PDFName.of("Differences"), PDFArray);
  if (!differences) return null;
  const codeToGlyph = new Map();
  let code = null;
  for (let index = 0; index < differences.size(); index += 1) {
    const value = differences.lookup(index);
    if (value instanceof PDFNumber) {
      code = value.asNumber();
    } else if (value instanceof PDFName && Number.isSafeInteger(code) && code >= 0 && code <= 255) {
      codeToGlyph.set(code, value.decodeText());
      code += 1;
    } else {
      return null;
    }
  }
  return codeToGlyph;
}

function rawType3Fonts(pdfLibPage) {
  try {
    const context = pdfLibPage.doc.context;
    const resources = pdfLibPage.node.Resources();
    const fonts = resources?.lookup(PDFName.of("Font"), PDFDict);
    if (!fonts) return [];
    const records = [];
    for (const [, reference] of fonts.entries()) {
      const font = context.lookup(reference, PDFDict);
      if (font?.get(PDFName.of("Subtype"))?.toString() !== "/Type3") continue;
      if (font.has(PDFName.of("ToUnicode"))) continue;
      const first = font.lookup(PDFName.of("FirstChar"), PDFNumber)?.asNumber();
      const last = font.lookup(PDFName.of("LastChar"), PDFNumber)?.asNumber();
      const widthsArray = font.lookup(PDFName.of("Widths"), PDFArray);
      const codeToGlyph = fontEncodingDifferences(font, context);
      if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || !widthsArray || !codeToGlyph) continue;
      if (first < 0 || last > 127 || last < first || widthsArray.size() !== last - first + 1) continue;
      const widths = new Map();
      let valid = true;
      for (let code = first; code <= last; code += 1) {
        const width = widthsArray.lookup(code - first, PDFNumber)?.asNumber();
        if (!Number.isSafeInteger(width) || width < 0) {
          valid = false;
          break;
        }
        if (width > 0) widths.set(code, width);
      }
      if (valid && widths.size > 0) records.push({ widths, codeToGlyph });
    }
    return records;
  } catch {
    return [];
  }
}

function metricScaleInterval(widths, metric) {
  let lower = 0;
  let upper = Infinity;
  for (const [code, observed] of widths) {
    const fixedWidth = metric.widths[code];
    if (!Number.isSafeInteger(fixedWidth) || fixedWidth <= 0) return null;
    const reference = fixedWidth / 1048576;
    lower = Math.max(lower, (observed - 0.5) / reference);
    upper = Math.min(upper, (observed + 0.5) / reference);
  }
  return lower < upper ? { lower, upper } : null;
}

export function uniqueComputerModernFamily(widthEntries) {
  const widths = widthEntries instanceof Map ? widthEntries : new Map(widthEntries);
  if (widths.size < 2) return null;
  const families = new Set();
  for (const metric of CM_TFM_METRICS) {
    if (metricScaleInterval(widths, metric)) families.add(metric.family);
  }
  return families.size === 1 ? [...families][0] : null;
}

function operatorGlyphTokens(operators, pdfjsPage, pdfjsLib) {
  const ops = pdfjsLib?.OPS ?? {};
  if (!operators || !Array.isArray(operators.fnArray) || !Array.isArray(operators.argsArray)) return null;
  const state = {
    current_font: null,
    font_size: 0,
    font_direction: 1,
    char_spacing: 0,
    word_spacing: 0,
    text_h_scale: 1,
    text_rise: 0,
    leading: 0,
    text_matrix: null,
    x: 0,
    y: 0,
    line_x: 0,
    line_y: 0,
    graphics_transform: identityTransform(),
  };
  const stateStack = [];
  const tokens = [];
  const allTokens = [];
  const fonts = new Map();
  const fontObjects = new Map();
  const unsupportedTextOps = new Set([
    ops.showSpacedText,
    ops.nextLineShowText,
    ops.nextLineSetSpacingShowText,
  ].filter(Number.isFinite));
  const numericArgument = (args, index = 0) => Number(Array.isArray(args) ? args[index] : NaN);
  const moveText = (x, y) => {
    if (![x, y].every(Number.isFinite)) return false;
    state.line_x += x;
    state.line_y += y;
    state.x = state.line_x;
    state.y = state.line_y;
    return true;
  };
  const fontObject = fontId => {
    if (fontObjects.has(fontId)) return fontObjects.get(fontId);
    let font;
    try {
      font = pdfjsPage.commonObjs.get(fontId);
    } catch {
      return null;
    }
    fontObjects.set(fontId, font);
    fonts.set(fontId, font?.isType3Font === true ? font : null);
    return font;
  };
  for (let index = 0; index < operators.fnArray.length; index += 1) {
    const operation = operators.fnArray[index];
    const args = operators.argsArray[index];
    if (operation === ops.save) stateStack.push(structuredClone(state));
    else if (operation === ops.restore) {
      if (stateStack.length === 0) return null;
      Object.assign(state, stateStack.pop());
    } else if (operation === ops.transform) {
      try {
        state.graphics_transform = multiplyTransforms(state.graphics_transform, finiteMatrix(args, "text graphics"));
      } catch {
        return null;
      }
    } else if (operation === ops.beginText) {
      state.text_matrix = null;
      state.x = state.line_x = 0;
      state.y = state.line_y = 0;
    } else if (operation === ops.setFont) {
      state.current_font = typeof args?.[0] === "string" ? args[0] : null;
      const size = numericArgument(args, 1);
      if (state.current_font === null || !Number.isFinite(size)) return null;
      state.font_size = Math.abs(size);
      state.font_direction = size < 0 ? -1 : 1;
    } else if (operation === ops.setTextMatrix) {
      try {
        state.text_matrix = finiteMatrix(args, "text");
      } catch {
        return null;
      }
      state.x = state.line_x = 0;
      state.y = state.line_y = 0;
    } else if (operation === ops.moveText) {
      if (!moveText(numericArgument(args), numericArgument(args, 1))) return null;
    } else if (operation === ops.setLeadingMoveText) {
      const x = numericArgument(args);
      const y = numericArgument(args, 1);
      state.leading = -y;
      if (!moveText(x, y)) return null;
    } else if (operation === ops.nextLine) {
      if (!moveText(0, state.leading)) return null;
    } else if (operation === ops.setLeading) {
      const leading = numericArgument(args);
      if (!Number.isFinite(leading)) return null;
      state.leading = -leading;
    } else if (operation === ops.setCharSpacing) {
      state.char_spacing = numericArgument(args);
      if (!Number.isFinite(state.char_spacing)) return null;
    } else if (operation === ops.setWordSpacing) {
      state.word_spacing = numericArgument(args);
      if (!Number.isFinite(state.word_spacing)) return null;
    } else if (operation === ops.setHScale) {
      state.text_h_scale = numericArgument(args) / 100;
      if (!Number.isFinite(state.text_h_scale)) return null;
    } else if (operation === ops.setTextRise) {
      state.text_rise = numericArgument(args);
      if (!Number.isFinite(state.text_rise)) return null;
    } else if (unsupportedTextOps.has(operation)) {
      return null;
    } else if (operation === ops.showText) {
      if (state.current_font === null || state.text_matrix === null || !Array.isArray(args?.[0])) return null;
      const font = fontObject(state.current_font);
      if (!font) return null;
      const fontMatrix = Array.isArray(font.fontMatrix) || ArrayBuffer.isView(font.fontMatrix)
        ? Array.from(font.fontMatrix, Number) : [0.001, 0, 0, 0.001, 0, 0];
      if (fontMatrix.length !== 6 || !fontMatrix.every(Number.isFinite)) return null;
      const textHScale = state.text_h_scale * state.font_direction;
      for (const glyph of args[0]) {
        if (typeof glyph === "number" && Number.isFinite(glyph)) {
          const spacingDirection = font.vertical ? 1 : -1;
          state.x += spacingDirection * glyph * state.font_size / 1000 * textHScale;
          continue;
        }
        if (!glyph || typeof glyph !== "object" || !Number.isFinite(glyph.width)) continue;
        const textOrigin = multiplyTransforms(
          state.graphics_transform,
          multiplyTransforms(state.text_matrix, [1, 0, 0, 1, state.x, state.y + state.text_rise]),
        );
        const origin = [textOrigin[4], textOrigin[5]];
        const glyphWidth = font.isType3Font
          ? (glyph.width * fontMatrix[0] + fontMatrix[4]) * state.font_size
          : glyph.width * state.font_size * fontMatrix[0];
        const spacing = (glyph.isSpace ? state.word_spacing : 0) + state.char_spacing;
        const glyphAdvanceVector = [
          textOrigin[0] * glyphWidth * textHScale,
          textOrigin[1] * glyphWidth * textHScale,
        ];
        const operatorAdvanceWidth = Math.hypot(...glyphAdvanceVector);
        const unicode = typeof glyph.unicode === "string" ? glyph.unicode : "";
        let offset = 0;
        for (const originalScalar of unicode) {
          const start = offset;
          offset += originalScalar.length;
          for (const scalar of originalScalar.normalize("NFKC")) {
            const token = {
              font_id: state.current_font,
              unicode: scalar,
              glyph,
              glyph_unicode_start: start,
              glyph_unicode_end: offset,
              all_token_index: allTokens.length,
              operator_origin: origin,
              operator_advance_width: operatorAdvanceWidth,
              operator_baseline: [textOrigin[0] * textHScale, textOrigin[1] * textHScale],
            };
            allTokens.push(token);
            if (!/^\s$/u.test(scalar)) tokens.push(token);
          }
        }
        state.x += (glyphWidth + spacing) * textHScale;
      }
    }
  }
  if (stateStack.length !== 0) return null;
  return { tokens, all_tokens: allTokens, fonts };
}

function textItemTokens(textContent) {
  const entries = (textContent?.items ?? [])
    .filter(item => typeof item?.str === "string")
    .map((item, sourceIndex) => [sourceIndex, item]);
  const tokens = [];
  for (const [sourceIndex, item] of entries) {
    let offset = 0;
    for (const originalScalar of item.str) {
      const start = offset;
      offset += originalScalar.length;
      for (const scalar of originalScalar.normalize("NFKC")) {
        if (/^\s$/u.test(scalar)) continue;
        tokens.push({
          font_id: item.fontName,
          unicode: scalar,
          source_index: sourceIndex,
          source_utf16_start: start,
          source_utf16_end: offset,
          direction: direction(item.dir),
        });
      }
    }
  }
  return { tokens, entries };
}

function baselineTextLineEvidence(textContent, pdfjsPage) {
  const viewport = pdfjsPage?.getViewport?.({ scale: 1 });
  const viewportTransform = safeTransform(viewport?.transform);
  if (!viewportTransform || !Number.isFinite(viewport?.width)) return null;
  const items = [];
  let hardSegment = 0;
  let invalidGeometry = false;
  for (let sourceIndex = 0; sourceIndex < (textContent?.items ?? []).length; sourceIndex += 1) {
    const item = textContent.items[sourceIndex];
    if (typeof item?.str !== "string") continue;
    const style = textContent?.styles?.[item.fontName] ?? {};
    const geometry = computeItemGeometry(
      viewportTransform,
      safeTransform(item.transform),
      finiteOrNull(item.width),
      finiteOrNull(item.height),
      style,
    );
    invalidGeometry ||= !geometry.valid;
    if (item.str.trim().length > 0) {
      const baselineItem = {
        id: `baseline-${sourceIndex}`,
        source_index: sourceIndex,
        is_whitespace: false,
        geometry_valid: geometry.valid,
        x: geometry.bbox?.x ?? null,
        y: geometry.bbox?.y ?? null,
        width: geometry.bbox?.width ?? null,
        height: geometry.bbox?.height ?? null,
        line_height: geometry.line_height,
        direction: direction(item.dir),
      };
      Object.defineProperty(baselineItem, "hard_segment", { value: hardSegment, enumerable: false });
      items.push(baselineItem);
    }
    if (item.hasEOL) hardSegment += 1;
  }
  const candidates = items.filter(item => item.geometry_valid);
  const grouped = groupLines(candidates, pdfjsPage?.pageNumber ?? 0);
  if (invalidGeometry) return null;
  const sourceById = new Map(items.map(item => [item.id, item.source_index]));
  const lineBySource = new Map();
  for (const line of grouped) {
    for (const itemId of line.item_ids) lineBySource.set(sourceById.get(itemId), line);
  }
  return { line_by_source: lineBySource };
}

function collapsedWhitespaceBinding(operatorTokens, token, textEntries, baselineEvidence) {
  const tokenIndex = token.all_token_index;
  if (!Number.isSafeInteger(tokenIndex) || operatorTokens[tokenIndex] !== token || !/^\s$/u.test(token.unicode)) return null;
  if ((tokenIndex > 0 && /^\s$/u.test(operatorTokens[tokenIndex - 1].unicode))
    || (tokenIndex + 1 < operatorTokens.length && /^\s$/u.test(operatorTokens[tokenIndex + 1].unicode))) return null;
  const previous = operatorTokens[tokenIndex - 1];
  const next = operatorTokens[tokenIndex + 1];
  if (!previous?.binding || !next?.binding) return null;
  if (next.binding.source_index !== previous.binding.source_index + 2) return null;
  const sourceIndex = previous.binding.source_index + 1;
  const item = textEntries[sourceIndex]?.[1];
  const nextItem = textEntries[next.binding.source_index]?.[1];
  if (!item || !["ltr", "unknown"].includes(direction(item.dir))) return null;
  if (item.str !== " ") return null;
  const previousSourceIndex = previous.binding.source_index;
  const nextSourceIndex = next.binding.source_index;
  const previousLine = baselineEvidence?.line_by_source.get(previousSourceIndex);
  const nextLine = baselineEvidence?.line_by_source.get(nextSourceIndex);
  if (!previousLine || previousLine !== nextLine) return null;
  const transform = safeTransform(item.transform);
  const nextTransform = safeTransform(nextItem?.transform);
  const operatorOrigin = token.operator_origin;
  const operatorBaseline = token.operator_baseline;
  if (!transform || !nextTransform
    || !Array.isArray(operatorOrigin) || operatorOrigin.length !== 2 || !operatorOrigin.every(Number.isFinite)
    || !Array.isArray(operatorBaseline) || operatorBaseline.length !== 2 || !operatorBaseline.every(Number.isFinite)) return null;
  const baselineMagnitude = Math.hypot(...operatorBaseline);
  if (!(baselineMagnitude > 0)) return null;
  const baselineUnit = operatorBaseline.map(value => value / baselineMagnitude);
  const fontSize = Math.hypot(transform[2], transform[3]);
  if (!(fontSize > 0)) return null;
  const toNext = [nextTransform[4] - operatorOrigin[0], nextTransform[5] - operatorOrigin[1]];
  const operatorAnchorSpanWidth = toNext[0] * baselineUnit[0] + toNext[1] * baselineUnit[1];
  const crossDistance = Math.abs(toNext[0] * -baselineUnit[1] + toNext[1] * baselineUnit[0]);
  const operatorAdvanceWidth = token.operator_advance_width;
  if (!Number.isFinite(operatorAdvanceWidth)
    || operatorAdvanceWidth <= 0
    || !Number.isFinite(operatorAnchorSpanWidth)
    || operatorAnchorSpanWidth + 0.01 < operatorAdvanceWidth
    || operatorAnchorSpanWidth > Math.max(24, fontSize * 2)
    || crossDistance > Math.max(2, fontSize * 0.5)) return null;
  const operatorRawTransform = [
    baselineUnit[0] * fontSize,
    baselineUnit[1] * fontSize,
    -baselineUnit[1] * fontSize,
    baselineUnit[0] * fontSize,
    operatorOrigin[0],
    operatorOrigin[1],
  ];
  return {
    font_id: item.fontName,
    unicode: item.str,
    source_index: sourceIndex,
    source_utf16_start: 0,
    source_utf16_end: item.str.length,
    direction: direction(item.dir),
    operator_advance_width: operatorAdvanceWidth,
    operator_anchor_span_width: operatorAnchorSpanWidth,
    operator_raw_transform: operatorRawTransform,
  };
}

function linkedRawType3Font(fontId, fontTokens, rawFonts) {
  const observed = new Map();
  const glyphIds = new Map();
  for (const token of fontTokens) {
    const glyph = token.glyph;
    if (!Number.isSafeInteger(glyph.originalCharCode) || !Number.isFinite(glyph.width)) return null;
    const priorWidth = observed.get(glyph.originalCharCode);
    if (priorWidth !== undefined && priorWidth !== glyph.width) return null;
    observed.set(glyph.originalCharCode, glyph.width);
    if (typeof glyph.operatorListId === "string") glyphIds.set(glyph.originalCharCode, glyph.operatorListId);
  }
  const candidates = rawFonts.filter(raw => [...observed].every(([code, width]) => raw.widths.get(code) === width)
    && [...glyphIds].every(([code, glyphId]) => raw.codeToGlyph.get(code) === glyphId));
  if (candidates.length !== 1) return null;
  return candidates[0];
}

function charProcDigestForCode(font, rawFont, code) {
  const glyphId = rawFont.codeToGlyph.get(code);
  if (typeof glyphId !== "string") return null;
  return type3CharProcSha256(font?.charProcOperatorList?.[glyphId]);
}

function collectType3GlyphRecoveries({ textContent, operators, pdfjsPage, pdfLibPage, pdfjsLib }) {
  const operatorEvidence = operatorGlyphTokens(operators, pdfjsPage, pdfjsLib);
  if (!operatorEvidence) return new Map();
  const textEvidence = textItemTokens(textContent);
  const baselineEvidence = baselineTextLineEvidence(textContent, pdfjsPage);
  if (!baselineEvidence) return new Map();
  const textTokens = textEvidence.tokens;
  if (textTokens.length !== operatorEvidence.tokens.length) return new Map();
  for (let index = 0; index < textTokens.length; index += 1) {
    const source = textTokens[index];
    const operator = operatorEvidence.tokens[index];
    if (source.font_id !== operator.font_id || source.unicode !== operator.unicode) return new Map();
    operator.binding = source;
  }

  const rawFonts = rawType3Fonts(pdfLibPage);
  const byFont = new Map();
  for (const token of operatorEvidence.all_tokens) {
    if (!byFont.has(token.font_id)) byFont.set(token.font_id, []);
    byFont.get(token.font_id).push(token);
  }
  const recoveries = new Map();
  for (const [fontId, fontTokens] of byFont) {
    const font = operatorEvidence.fonts.get(fontId);
    if (!font) continue;
    const rawFont = linkedRawType3Font(fontId, fontTokens, rawFonts);
    if (!rawFont) continue;
    const family = uniqueComputerModernFamily(rawFont.widths);
    if (!family || family.startsWith("unsupported:")) continue;
    for (const registry of TYPE3_RECOVERY_REGISTRY.filter(entry => entry.family === family)) {
      const targetDigest = charProcDigestForCode(font, rawFont, registry.original_char_code);
      if (targetDigest !== registry.charproc_sha256) continue;
      const witnessDigests = registry.witnesses.map(witness => charProcDigestForCode(font, rawFont, witness.original_char_code));
      if (witnessDigests.some((digest, index) => digest !== registry.witnesses[index].charproc_sha256)) continue;
      for (const token of fontTokens) {
        const glyph = token.glyph;
        if (glyph.originalCharCode !== registry.original_char_code || glyph.unicode !== registry.source_unicode) continue;
        const collapsedBinding = registry.allow_collapsed_whitespace === true
          ? collapsedWhitespaceBinding(operatorEvidence.all_tokens, token, textEvidence.entries, baselineEvidence)
          : null;
        const binding = token.binding ?? collapsedBinding;
        if (!binding || !["ltr", "unknown"].includes(binding.direction)) continue;
        if (!recoveries.has(binding.source_index)) recoveries.set(binding.source_index, []);
        recoveries.get(binding.source_index).push({
          source_utf16_start: binding.source_utf16_start,
          source_utf16_end: binding.source_utf16_end,
          output_utf16_start: binding.source_utf16_start,
          output_utf16_end: binding.source_utf16_start + registry.target_unicode.length,
          original_char_code: registry.original_char_code,
          source_unicode: binding.unicode,
          operator_unicode: registry.source_unicode,
          target_unicode: registry.target_unicode,
          binding_kind: collapsedBinding ? "collapsed_whitespace_item" : "exact_text_scalar",
          operator_advance_width: collapsedBinding?.operator_advance_width ?? null,
          operator_anchor_span_width: collapsedBinding?.operator_anchor_span_width ?? null,
          operator_raw_transform: collapsedBinding?.operator_raw_transform ?? null,
          source_font_id: fontId,
          registry_id: registry.id,
          qualification: registry.qualification,
          charproc_sha256: registry.charproc_sha256,
          witness_charproc_sha256: witnessDigests,
          tfm_reference_version: CM_TFM_REFERENCE_VERSION,
          canonicalizer_version: TYPE3_GLYPH_CANONICALIZER_VERSION,
        });
      }
    }
  }
  for (const [sourceIndex, items] of recoveries) {
    const deduplicated = [...new Map(items.map(item => [`${item.source_utf16_start}:${item.registry_id}`, item])).values()]
      .sort((left, right) => left.source_utf16_start - right.source_utf16_start);
    recoveries.set(sourceIndex, deduplicated);
  }
  return recoveries;
}

/**
 * Read-only maintainer census for every understood legacy Type-3 showText
 * glyph. Unlike recovery's strict text-binding lane, this keeps control and
 * whitespace-like Unicode values so old encodings cannot disappear from the
 * report. Missing links/classification/digests remain explicit omissions.
 */
export function inspectType3GlyphEvidenceForPage({ textContent, operators, pdfjsPage, pdfLibPage, pdfjsLib }) {
  const ops = pdfjsLib?.OPS ?? {};
  const omissions = [];
  if (!operators || !Array.isArray(operators.fnArray) || !Array.isArray(operators.argsArray)) {
    return { occurrences: [], omissions: [{ reason: "operator_evidence_unavailable", count: 1 }] };
  }
  let currentFont = null;
  const fontStack = [];
  const byFont = new Map();
  const fonts = new Map();
  const unsupportedTextOps = new Set([
    ops.showSpacedText,
    ops.nextLineShowText,
    ops.nextLineSetSpacingShowText,
  ].filter(Number.isFinite));
  for (let operatorIndex = 0; operatorIndex < operators.fnArray.length; operatorIndex += 1) {
    const operation = operators.fnArray[operatorIndex];
    const args = operators.argsArray[operatorIndex];
    if (operation === ops.save) fontStack.push(currentFont);
    else if (operation === ops.restore) {
      if (fontStack.length === 0) omissions.push({ reason: "font_stack_restore_underflow", count: 1 });
      else currentFont = fontStack.pop();
    } else if (operation === ops.setFont) {
      currentFont = typeof args?.[0] === "string" ? args[0] : null;
    } else if (unsupportedTextOps.has(operation)) {
      omissions.push({ reason: "unsupported_text_operator", count: 1 });
    } else if (operation === ops.showText && currentFont !== null && Array.isArray(args?.[0])) {
      let font = fonts.get(currentFont);
      if (font === undefined) {
        try {
          font = pdfjsPage.commonObjs.get(currentFont);
        } catch {
          font = null;
          omissions.push({ font_id: currentFont, reason: "font_object_unavailable", scope: "potential_font_glyph", count: args[0].length });
        }
        if (font?.isType3Font !== true) font = null;
        fonts.set(currentFont, font);
      }
      if (!font) continue;
      if (!byFont.has(currentFont)) byFont.set(currentFont, []);
      for (let glyphIndex = 0; glyphIndex < args[0].length; glyphIndex += 1) {
        const glyph = args[0][glyphIndex];
        // PDF.js interleaves numeric text-position adjustments with glyphs.
        if (typeof glyph === "number" && Number.isFinite(glyph)) continue;
        if (!glyph || typeof glyph !== "object") {
          omissions.push({ font_id: currentFont, reason: "malformed_type3_glyph", scope: "type3_glyph", count: 1 });
          continue;
        }
        byFont.get(currentFont).push({ glyph, operator_index: operatorIndex, glyph_index: glyphIndex });
      }
    } else if (operation === ops.showText && currentFont === null) {
      omissions.push({ reason: "show_text_without_current_font", scope: "potential_font_glyph", count: Array.isArray(args?.[0]) ? args[0].length : 1 });
    } else if (operation === ops.showText) {
      omissions.push({ reason: "malformed_show_text_arguments", scope: "potential_font_glyph", count: 1 });
    }
  }
  if (fontStack.length !== 0) omissions.push({ reason: "font_stack_unbalanced_at_end", count: fontStack.length });

  const rawFonts = rawType3Fonts(pdfLibPage);
  const occurrences = [];
  for (const [fontId, fontTokens] of byFont) {
    const font = fonts.get(fontId);
    const rawFont = linkedRawType3Font(fontId, fontTokens, rawFonts);
    if (!rawFont) {
      omissions.push({ font_id: fontId, reason: "raw_type3_font_link_ambiguous_or_unavailable", scope: "type3_glyph", count: fontTokens.length });
      continue;
    }
    const family = uniqueComputerModernFamily(rawFont.widths);
    const official = family ? CM_CODEPOINTS[family] : null;
    const witnessCodes = family ? CM_WITNESS_CODEPOINTS[family] : null;
    const mappedCodeCharprocSha256 = official ? Object.fromEntries([...new Set([
      ...Object.keys(official),
      ...Object.keys(witnessCodes ?? {}),
    ])]
      .map(Number)
      .sort((left, right) => left - right)
      .map(code => [code, charProcDigestForCode(font, rawFont, code)])) : {};
    for (const token of fontTokens) {
      const code = token.glyph.originalCharCode;
      if (!Number.isSafeInteger(code)) {
        omissions.push({ font_id: fontId, reason: "original_char_code_unavailable", scope: "type3_glyph", count: 1 });
        continue;
      }
      const digest = charProcDigestForCode(font, rawFont, code);
      if (!digest) omissions.push({ font_id: fontId, reason: "charproc_digest_unavailable", scope: "glyph_evidence", count: 1 });
      const registryEvidenceMatchIds = TYPE3_RECOVERY_REGISTRY.filter(entry => entry.family === family
        && entry.original_char_code === code
        && entry.source_unicode === token.glyph.unicode
        && entry.target_unicode === official?.[code]
        && entry.charproc_sha256 === digest
        && entry.witnesses.every(witness => mappedCodeCharprocSha256[witness.original_char_code] === witness.charproc_sha256))
        .map(entry => entry.id)
        .sort();
      occurrences.push({
        family,
        family_status: !family
          ? "ambiguous_or_unavailable"
          : official
            ? "identified_reviewed_mapping"
            : "identified_not_unicode_mapped",
        original_char_code: code,
        source_unicode: typeof token.glyph.unicode === "string" ? token.glyph.unicode : "",
        intended_unicode: official?.[code] ?? null,
        charproc_sha256: digest,
        mapped_code_charproc_sha256: mappedCodeCharprocSha256,
        registry_evidence_match_ids: registryEvidenceMatchIds,
        operator_index: token.operator_index,
        glyph_index: token.glyph_index,
        tfm_reference_version: CM_TFM_REFERENCE_VERSION,
        canonicalizer_version: TYPE3_GLYPH_CANONICALIZER_VERSION,
      });
    }
  }
  const strictRecoveries = textContent ? [...collectType3GlyphRecoveries({
    textContent,
    operators,
    pdfjsPage,
    pdfLibPage,
    pdfjsLib,
  }).entries()].flatMap(([sourceIndex, recoveries]) => recoveries.map(recovery => ({
    source_index: sourceIndex,
    ...recovery,
  }))) : [];
  if (!textContent) omissions.push({ reason: "strict_text_binding_unavailable", scope: "strict_recovery", count: 1 });
  return { occurrences, omissions, strict_recoveries: strictRecoveries };
}

function applyType3GlyphRecoveries(sourceText, recoveries) {
  if (!recoveries?.length) return sourceText;
  let cursor = 0;
  let result = "";
  for (const recovery of recoveries) {
    if (recovery.source_utf16_start < cursor
      || sourceText.slice(recovery.source_utf16_start, recovery.source_utf16_end) !== recovery.source_unicode) return sourceText;
    result += sourceText.slice(cursor, recovery.source_utf16_start);
    result += recovery.target_unicode;
    cursor = recovery.source_utf16_end;
  }
  return result + sourceText.slice(cursor);
}

function round(value) {
  return Number(Number(value).toFixed(3));
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function box(value) {
  return {
    x: round(value.x),
    y: round(value.y),
    width: round(value.width),
    height: round(value.height),
  };
}

function normalizedRotation(value) {
  return ((Number(value) % 360) + 360) % 360;
}

function effectiveViewportScale(viewportTransform) {
  return Math.hypot(Number(viewportTransform[0]), Number(viewportTransform[1]));
}

function ascentRatio(style) {
  if (Number.isFinite(Number(style?.ascent)) && Number(style.ascent) !== 0) {
    return { ratio: Number(style.ascent), source: "style_ascent" };
  }
  if (Number.isFinite(Number(style?.descent)) && Number(style.descent) !== 0) {
    return { ratio: 1 + Number(style.descent), source: "style_descent_fallback" };
  }
  return { ratio: 0.8, source: "default_0_8" };
}

export function pageGeometry(pdfLibPage, pdfjsPage, viewport, pageNumber) {
  const mediaBox = pdfLibPage ? box(pdfLibPage.getMediaBox()) : null;
  const cropBox = pdfLibPage ? box(pdfLibPage.getCropBox()) : null;
  const rawPdfRotation = pdfLibPage ? normalizedRotation(pdfLibPage.getRotation().angle) : null;
  const displayRotation = pdfjsPage ? normalizedRotation(pdfjsPage.rotate) : null;
  return {
    page: pageNumber,
    media_box: mediaBox,
    crop_box: cropBox,
    pdfjs_view: pdfjsPage ? pdfjsPage.view.map(round) : null,
    user_unit: pdfjsPage ? round(pdfjsPage.userUnit || 1) : null,
    raw_pdf_rotation: rawPdfRotation,
    display_rotation: displayRotation,
    rotation_matches_raw: displayRotation === null || rawPdfRotation === null ? null : displayRotation === rawPdfRotation,
    display_width: viewport ? round(viewport.width) : null,
    display_height: viewport ? round(viewport.height) : null,
    viewport_transform: viewport ? viewport.transform.map(round) : null,
    raw_page_space: { ...RAW_PAGE_SPACE },
    item_space: { ...ITEM_SPACE },
  };
}

const MAX_LINK_ANNOTATIONS = 200;
const SUPPORTED_LINK_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Resolve a link annotation to a supported target.
 *
 * Trust boundary: the only target string ever resolved is PDF.js's sanitized
 * `url`. The raw `unsafeUrl` is used solely as a typeof presence signal when
 * classifying the target class, and its content is never read, parsed, or
 * emitted. The value returned is the normalized `parsed.href`, not the
 * original string.
 */
function supportedLinkUrl(annotation) {
  const url = typeof annotation?.url === "string" ? annotation.url : null;
  if (url === null || url.length === 0 || url.length > 2048) return null;
  if (/[\u0000-\u0020\u007f-\u009f]/u.test(url)) return null;
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!SUPPORTED_LINK_PROTOCOLS.has(parsed.protocol)) return null;
  if (parsed.href.length > 2048) return null;
  if (/[\u0000-\u0020\u007f-\u009f]/u.test(parsed.href)) return null;
  return parsed.href;
}

/**
 * Which target classes the annotation declares. Presence only: `unsafeUrl` is
 * counted by type, never by content.
 */
function linkTargetClasses(annotation) {
  const classes = [];
  if (typeof annotation?.url === "string" || typeof annotation?.unsafeUrl === "string") {
    classes.push("url");
  }
  if (annotation?.dest !== undefined && annotation?.dest !== null) classes.push("destination");
  if (annotation?.action !== undefined && annotation?.action !== null) classes.push("action");
  return classes;
}

function linkTargetKind(annotation) {
  const classes = linkTargetClasses(annotation);
  // A safe url must not win over a co-declared destination or action. More
  // than one declared class is ambiguous and degrades to escaped text.
  if (classes.length === 0) return "none";
  if (classes.length > 1) return "ambiguous_target";
  if (classes[0] === "destination") return "internal_destination";
  if (classes[0] === "action") return "action";
  return supportedLinkUrl(annotation) !== null ? "http" : "unsupported_scheme";
}

function applyViewportPoint(transform, x, y) {
  return [
    transform[0] * x + transform[2] * y + transform[4],
    transform[1] * x + transform[3] * y + transform[5],
  ];
}

/**
 * Project an annotation rect from PDF user space into the same display
 * viewport the text items use, so rotation and CropBox origin are already
 * folded in by the viewport transform.
 */
function linkRectGeometry(viewportTransform, rect) {
  if (!Array.isArray(viewportTransform) || viewportTransform.length !== 6) return null;
  if (!viewportTransform.every(Number.isFinite)) return null;
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) return null;
  const [x1, y1, x2, y2] = rect;
  const corners = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]
    .map(([x, y]) => applyViewportPoint(viewportTransform, x, y));
  const xs = corners.map(corner => corner[0]);
  const ys = corners.map(corner => corner[1]);
  if (![...xs, ...ys].every(Number.isFinite)) return null;
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x: round(x),
    y: round(y),
    width: round(Math.max(...xs) - x),
    height: round(Math.max(...ys) - y),
  };
}

function collectLinkAnnotations(annotations, viewportTransform, pageNumber) {
  const items = [];
  let truncated = false;
  for (const annotation of Array.isArray(annotations) ? annotations : []) {
    if (annotation?.subtype !== "Link") continue;
    if (items.length >= MAX_LINK_ANNOTATIONS) {
      truncated = true;
      break;
    }
    const targetKind = linkTargetKind(annotation);
    items.push({
      id: `p${String(pageNumber).padStart(4, "0")}-link${String(items.length + 1).padStart(4, "0")}`,
      rect: linkRectGeometry(viewportTransform, annotation.rect),
      target_kind: targetKind,
      url: targetKind === "http" ? supportedLinkUrl(annotation) : null,
    });
  }
  return { status: "available", truncated, items };
}

const UNAVAILABLE_LINK_ANNOTATIONS = Object.freeze({
  status: "unavailable",
  truncated: false,
  items: [],
});

function multiplyTransforms(left, right) {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function computeItemGeometry(viewportTransform, rawTransform, rawWidth, rawHeight, style) {
  const rawValues = [...viewportTransform, ...rawTransform, rawWidth, rawHeight];
  if (!rawValues.every(value => typeof value === "number" && Number.isFinite(value))) {
    return {
      valid: false,
      quad: null,
      bbox: null,
      line_height: null,
      ascent_ratio: null,
      ascent_source: null,
      advance_source: style?.vertical === true ? "item_height" : "item_width",
    };
  }
  const transformed = multiplyTransforms(viewportTransform, rawTransform);
  if (!transformed.every(Number.isFinite)) {
    return {
      valid: false,
      quad: null,
      bbox: null,
      line_height: null,
      ascent_ratio: null,
      ascent_source: null,
      advance_source: style?.vertical === true ? "item_height" : "item_width",
    };
  }
  const baseline = { x: transformed[4], y: transformed[5] };
  const fontSize = Math.hypot(transformed[2], transformed[3]);
  const viewportScale = effectiveViewportScale(viewportTransform);
  const isVertical = style?.vertical === true;
  const rawAdvance = isVertical ? rawHeight : rawWidth;
  const advanceLength = Math.abs(rawAdvance) * viewportScale;
  let angle = Math.atan2(transformed[1], transformed[0]);
  if (isVertical) angle += Math.PI / 2;
  const advance = { x: Math.cos(angle) * advanceLength, y: Math.sin(angle) * advanceLength };
  const cross = { x: -Math.sin(angle) * fontSize, y: Math.cos(angle) * fontSize };
  const ascent = ascentRatio(style);
  const top = {
    x: baseline.x + fontSize * ascent.ratio * Math.sin(angle),
    y: baseline.y - fontSize * ascent.ratio * Math.cos(angle),
  };
  const points = [
    top,
    { x: top.x + advance.x, y: top.y + advance.y },
    { x: top.x + cross.x, y: top.y + cross.y },
    { x: top.x + advance.x + cross.x, y: top.y + advance.y + cross.y },
  ];
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  return {
    valid: true,
    quad: points.map(point => ({ x: round(point.x), y: round(point.y) })),
    bbox: {
      x: round(Math.min(...xs)),
      y: round(Math.min(...ys)),
      width: round(Math.max(...xs) - Math.min(...xs)),
      height: round(Math.max(...ys) - Math.min(...ys)),
    },
    line_height: round(fontSize),
    ascent_ratio: round(ascent.ratio),
    ascent_source: ascent.source,
    advance_source: isVertical ? "item_height" : "item_width",
  };
}

function direction(value) {
  return ["ltr", "rtl", "ttb"].includes(value) ? value : "unknown";
}

function lineText(items, lineDirection) {
  let text = "";
  let previous = null;
  for (const item of items) {
    if (previous) {
      const gap = lineDirection === "rtl"
        ? previous.x - (item.x + item.width)
        : item.x - (previous.x + previous.width);
      const operatorRecoveredBoundary = [previous, item].some(value => value.glyph_recoveries
        ?.some(recovery => recovery.binding_kind === "collapsed_whitespace_item"));
      const spaceThreshold = operatorRecoveredBoundary
        ? Math.max(0.5, Math.min(item.line_height ?? 8, previous.line_height ?? 8) * 0.08)
        : Math.max(1, Math.min(item.line_height ?? 8, previous.line_height ?? 8) * 0.2);
      if (gap > spaceThreshold && !text.endsWith(" ")) text += " ";
    }
    text += item.text;
    previous = item;
  }
  return normalizeText(text);
}

function combineBounds(items) {
  const right = Math.max(...items.map(item => item.x + item.width));
  const bottom = Math.max(...items.map(item => item.y + item.height));
  const x = Math.min(...items.map(item => item.x));
  const y = Math.min(...items.map(item => item.y));
  return { x: round(x), y: round(y), width: round(right - x), height: round(bottom - y) };
}

function materializeLine(lineItems, pageNumber, lineDirection) {
  const sourceFirstIndex = Math.min(...lineItems.map(item => item.source_index));
  return {
    id: `p${String(pageNumber).padStart(4, "0")}-l${String(sourceFirstIndex + 1).padStart(6, "0")}`,
    source_first_index: sourceFirstIndex,
    text: lineText(lineItems, lineDirection),
    ...combineBounds(lineItems),
    direction: lineDirection,
    item_ids: lineItems.map(item => item.id),
    reading_order_index: -1,
    column_index: 0,
  };
}

function medianNumber(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function itemBaselineCenter(item) {
  return item.y + item.height / 2;
}

function baselineInvariant(lineItems, toleranceFactor) {
  if (lineItems.length <= 1) return true;
  const centers = lineItems.map(itemBaselineCenter);
  const heights = lineItems.map(item => item.line_height).filter(Number.isFinite);
  const referenceHeight = heights.length > 0 ? medianNumber(heights) : 8;
  const centerMedian = medianNumber(centers);
  const tolerances = lineItems.map(item => Math.max(2, Math.min(referenceHeight, item.line_height ?? referenceHeight) * toleranceFactor));
  return lineItems.every((item, index) => Math.abs(centers[index] - centers[0]) <= tolerances[index]
    && Math.abs(centers[index] - centerMedian) <= tolerances[index])
    && Math.max(...centers) - Math.min(...centers) <= Math.min(...tolerances);
}

function groupLines(items, pageNumber) {
  const ordered = [...items].sort((left, right) => {
    const leftCenter = left.y + left.height / 2;
    const rightCenter = right.y + right.height / 2;
    return leftCenter - rightCenter || left.x - right.x || left.source_index - right.source_index;
  });
  const lines = [];
  for (const item of ordered) {
    const center = item.y + item.height / 2;
    let best = null;
    let bestDistance = Infinity;
    for (const line of lines) {
      if (line.direction !== item.direction || line.hard_segment !== item.hard_segment) continue;
      if (!baselineInvariant([...line.items, item], 0.35)) continue;
      const distance = Math.abs(center - medianNumber(line.items.map(itemBaselineCenter)));
      const lineLeft = Math.min(...line.items.map(value => value.x));
      const lineRight = Math.max(...line.items.map(value => value.x + value.width));
      const alongAxisGap = Math.max(0, lineLeft - (item.x + item.width), item.x - lineRight);
      const maxAlongAxisGap = Math.max(24, Math.min(line.median_font_size, item.line_height ?? line.median_font_size) * 4);
      if (alongAxisGap > maxAlongAxisGap) continue;
      if (distance < bestDistance) {
        best = line;
        bestDistance = distance;
      }
    }
    if (!best) {
      lines.push({ center, direction: item.direction, hard_segment: item.hard_segment, median_font_size: item.line_height ?? 8, items: [item] });
    } else {
      best.items.push(item);
      best.center = best.items.reduce((sum, value) => sum + value.y + value.height / 2, 0) / best.items.length;
      const sizes = best.items.map(value => value.line_height).filter(Number.isFinite).sort((a, b) => a - b);
      if (sizes.length > 0) best.median_font_size = sizes[Math.floor(sizes.length / 2)];
    }
  }
  return lines.map(line => {
    const lineItems = [...line.items].sort((left, right) => {
      if (line.direction === "rtl") return right.x - left.x || left.source_index - right.source_index;
      return left.x - right.x || left.source_index - right.source_index;
    });
    return materializeLine(lineItems, pageNumber, line.direction);
  });
}

function sourceOrderLines(items, pageNumber) {
  const segments = [];
  let current = null;
  for (const item of [...items].sort((left, right) => left.source_index - right.source_index)) {
    if (!item.geometry_valid || item.is_whitespace) continue;
    if (!current
      || current.hard_segment !== item.hard_segment
      || current.direction !== item.direction
      || !baselineInvariant([...current.items, item], 0.5)) {
      current = { hard_segment: item.hard_segment, direction: item.direction, items: [] };
      segments.push(current);
    }
    current.items.push(item);
  }
  return segments.map(segment => materializeLine(segment.items, pageNumber, segment.direction));
}

function buildBlocks(lines, pageNumber, columnCount) {
  const blocks = [];
  for (const line of lines) {
    const previous = blocks.at(-1);
    if (!previous || previous.column_index !== line.column_index) {
      blocks.push({
        id: `p${String(pageNumber).padStart(4, "0")}-b${String(blocks.length + 1).padStart(4, "0")}`,
        kind: line.column_index === -1 ? "spanning_flow" : columnCount > 1 ? "column_flow" : "page_flow",
        column_index: line.column_index,
        line_ids: [],
      });
    }
    blocks.at(-1).line_ids.push(line.id);
  }
  return blocks;
}

function readingOrder(lines, displayWidth, { sourceLines, forceSourceOrder = false, fallbackReason = null } = {}) {
  const sourceOrder = [...sourceLines].sort((left, right) => left.source_first_index - right.source_first_index);
  if (forceSourceOrder) {
    return {
      lines: sourceOrder,
      strategy: "source_order_fallback",
      confidence: "not_calibrated",
      column_count: 1,
      limitations: [
        fallbackReason || "Geometry was ambiguous, so source item order was retained.",
        "Source order is parser order and is not proof of intended or visible reading order.",
      ],
    };
  }
  const defaultResult = {
    lines: sourceOrder,
    strategy: "source_order_fallback",
    confidence: "not_calibrated",
    column_count: 1,
    limitations: [
      "Column evidence was insufficient or ambiguous, so source item order was retained.",
      "Source order is parser order and is not proof of intended or visible reading order.",
    ],
  };
  if (lines.length < 4) return defaultResult;

  const byX = [...lines].sort((left, right) => left.x - right.x || left.y - right.y);
  let largestGap = { size: 0, index: -1 };
  for (let index = 1; index < byX.length; index += 1) {
    const gap = byX[index].x - byX[index - 1].x;
    if (gap > largestGap.size) largestGap = { size: gap, index };
  }
  if (largestGap.index < 2 || byX.length - largestGap.index < 2 || largestGap.size < displayWidth * 0.15) {
    return defaultResult;
  }
  const threshold = (byX[largestGap.index - 1].x + byX[largestGap.index].x) / 2;
  const spanning = lines.filter(line => line.x < threshold && line.x + line.width > threshold);
  const left = lines.filter(line => line.x <= threshold && !spanning.includes(line));
  const right = lines.filter(line => line.x > threshold);
  if (left.length < 2 || right.length < 2) return defaultResult;
  const gutterLeft = Math.max(...left.map(line => line.x + line.width));
  const gutterRight = Math.min(...right.map(line => line.x));
  if (gutterRight - gutterLeft < Math.max(12, displayWidth * 0.05)) return defaultResult;
  const span = values => ({
    top: Math.min(...values.map(line => line.y)),
    bottom: Math.max(...values.map(line => line.y + line.height)),
  });
  const leftSpan = span(left);
  const rightSpan = span(right);
  const overlap = Math.max(0, Math.min(leftSpan.bottom, rightSpan.bottom) - Math.max(leftSpan.top, rightSpan.top));
  const minimumSpan = Math.min(leftSpan.bottom - leftSpan.top, rightSpan.bottom - rightSpan.top);
  if (minimumSpan <= 0 || overlap / minimumSpan < 0.5) return defaultResult;
  const hasSegmentedBaseline = values => values.some((line, index) => values.slice(index + 1).some(other => {
    const centerDistance = Math.abs((line.y + line.height / 2) - (other.y + other.height / 2));
    const tolerance = Math.max(2, Math.min(line.height, other.height) * 0.35);
    const horizontallySeparate = line.x + line.width <= other.x || other.x + other.width <= line.x;
    return horizontallySeparate && centerDistance <= tolerance;
  }));
  if (hasSegmentedBaseline(left) || hasSegmentedBaseline(right)) {
    return {
      ...defaultResult,
      limitations: [
        "A candidate column contained multiple non-overlapping lines on the same baseline, so table-like or segmented content retained source order.",
        "Source order is parser order and is not proof of intended or visible reading order.",
      ],
    };
  }
  const columnTop = Math.min(leftSpan.top, rightSpan.top);
  const columnBottom = Math.max(leftSpan.bottom, rightSpan.bottom);
  const spanningAbove = spanning.filter(line => line.y + line.height <= columnTop);
  const spanningBelow = spanning.filter(line => line.y >= columnBottom);
  if (spanningAbove.length + spanningBelow.length !== spanning.length) return defaultResult;

  for (const line of left) line.column_index = 0;
  for (const line of right) line.column_index = 1;
  for (const line of spanning) line.column_index = -1;
  const stableGeometryOrder = values => values.sort((a, b) => a.y - b.y || a.x - b.x || a.source_first_index - b.source_first_index);
  return {
    lines: [
      ...stableGeometryOrder(spanningAbove),
      ...stableGeometryOrder(left),
      ...stableGeometryOrder(right),
      ...stableGeometryOrder(spanningBelow),
    ],
    strategy: "two_column_left_to_right",
    confidence: "not_calibrated",
    column_count: 2,
    limitations: [
      "Two-column order requires persistent non-overlapping line boxes and a real gutter; confidence is not calibrated.",
      "Spanning headings or footers are retained only when they are geometrically outside both column spans.",
      "Tables, floating objects, and footnotes are not inferred.",
    ],
  };
}

function imageOperationSet(pdfjsLib) {
  return new Set([
    pdfjsLib.OPS?.paintImageXObject,
    pdfjsLib.OPS?.paintJpegXObject,
    pdfjsLib.OPS?.paintImageMaskXObject,
    pdfjsLib.OPS?.paintImageMaskXObjectGroup,
    pdfjsLib.OPS?.paintInlineImageXObject,
    pdfjsLib.OPS?.paintInlineImageXObjectGroup,
    pdfjsLib.OPS?.paintImageXObjectRepeat,
    pdfjsLib.OPS?.paintImageMaskXObjectRepeat,
  ].filter(Number.isInteger));
}

function vectorOperationSet(pdfjsLib) {
  return new Set([
    pdfjsLib.OPS?.stroke,
    pdfjsLib.OPS?.closeStroke,
    pdfjsLib.OPS?.fill,
    pdfjsLib.OPS?.eoFill,
    pdfjsLib.OPS?.fillStroke,
    pdfjsLib.OPS?.eoFillStroke,
    pdfjsLib.OPS?.closeFillStroke,
    pdfjsLib.OPS?.closeEOFillStroke,
    pdfjsLib.OPS?.shadingFill,
    pdfjsLib.OPS?.constructPath,
    pdfjsLib.OPS?.rawFillPath,
  ].filter(Number.isInteger));
}

const RECT_FILL_OP_NAMES = [
  "fill",
  "eoFill",
  "fillStroke",
  "eoFillStroke",
  "closeFillStroke",
  "closeEOFillStroke",
];
const RECT_STROKE_OP_NAMES = ["stroke", "closeStroke"];

function identityTransform() {
  return [1, 0, 0, 1, 0, 0];
}

function operatorArgument(argsArray, index) {
  return Array.isArray(argsArray) ? argsArray[index] : undefined;
}

function operatorMatrix(value) {
  if ((Array.isArray(value) || ArrayBuffer.isView(value))
    && value.length === 1
    && (Array.isArray(value[0]) || ArrayBuffer.isView(value[0]))) return value[0];
  return value;
}

function finiteMatrix(value, label) {
  const matrix = operatorMatrix(value);
  if (!matrix || matrix.length !== 6 || !Array.from(matrix).every(Number.isFinite)) {
    throw new Error(`Invalid ${label} matrix in operator list.`);
  }
  return Array.from(matrix, Number);
}

function pathBufferFromArguments(argumentsForOperation) {
  if (!Array.isArray(argumentsForOperation)) return null;
  const pathData = argumentsForOperation[1];
  if (!Array.isArray(pathData) && !ArrayBuffer.isView(pathData)) {
    throw new Error("Invalid constructPath data in operator list.");
  }
  const buffer = pathData[0];
  if (buffer === null || buffer === undefined) return null;
  if (!Array.isArray(buffer) && !ArrayBuffer.isView(buffer)) {
    throw new Error("Invalid constructPath DrawOPS buffer in operator list.");
  }
  return buffer;
}

function decodeDrawOps(buffer) {
  if (buffer === null) return [];
  const commands = [];
  let index = 0;
  while (index < buffer.length) {
    const opcode = Number(buffer[index++]);
    if (![DRAW_OPS.moveTo, DRAW_OPS.lineTo, DRAW_OPS.curveTo, DRAW_OPS.quadraticCurveTo, DRAW_OPS.closePath].includes(opcode)) {
      throw new Error(`Unknown DrawOPS opcode ${opcode}.`);
    }
    const coordinateCount = opcode === DRAW_OPS.curveTo ? 6
      : opcode === DRAW_OPS.quadraticCurveTo ? 4
        : opcode === DRAW_OPS.moveTo || opcode === DRAW_OPS.lineTo ? 2 : 0;
    if (index + coordinateCount > buffer.length) throw new Error("Truncated constructPath DrawOPS buffer.");
    const coordinates = Array.from(buffer.slice(index, index + coordinateCount), Number);
    if (!coordinates.every(Number.isFinite)) throw new Error("Non-finite constructPath coordinate.");
    index += coordinateCount;
    commands.push({ opcode, coordinates });
  }
  return commands;
}

function rectangleSubpaths(commands) {
  const rectangles = [];
  let current = null;
  const finish = () => {
    if (!current || !current.closed || current.hasCurve || ![3, 4].includes(current.lines.length)) return;
    const segments = current.lines.map(segment => [...segment]);
    const last = segments.at(-1);
    const closeSegment = [last[1], current.start];
    if (segments.length === 3) segments.push(closeSegment);
    else if (Math.hypot(last[1][0] - current.start[0], last[1][1] - current.start[1]) > RULED_RECT_AXIS_TOLERANCE) return;
    rectangles.push(segments);
  };
  for (const command of commands) {
    if (command.opcode === DRAW_OPS.moveTo) {
      finish();
      const point = [command.coordinates[0], command.coordinates[1]];
      current = { start: point, point, lines: [], hasCurve: false, closed: false };
    } else if (command.opcode === DRAW_OPS.lineTo) {
      if (!current) continue;
      const next = [command.coordinates[0], command.coordinates[1]];
      current.lines.push([current.point, next]);
      current.point = next;
    } else if (command.opcode === DRAW_OPS.curveTo || command.opcode === DRAW_OPS.quadraticCurveTo) {
      if (current) {
        current.hasCurve = true;
        current.point = command.opcode === DRAW_OPS.curveTo
          ? [command.coordinates[4], command.coordinates[5]]
          : [command.coordinates[2], command.coordinates[3]];
      }
    } else if (command.opcode === DRAW_OPS.closePath) {
      if (current) {
        current.closed = true;
        finish();
        current = null;
      }
    }
  }
  finish();
  return rectangles;
}

function transformedRectangle(segments, transform) {
  const transformedSegments = segments.map(([start, end]) => [
    applyViewportPoint(transform, start[0], start[1]),
    applyViewportPoint(transform, end[0], end[1]),
  ]);
  const points = transformedSegments.flat();
  if (!points.every(point => point.every(Number.isFinite))) return null;
  const axisAligned = transformedSegments.every(([start, end]) => {
    const dx = Math.abs(end[0] - start[0]);
    const dy = Math.abs(end[1] - start[1]);
    return (dy <= RULED_RECT_AXIS_TOLERANCE && dx > RULED_RECT_AXIS_TOLERANCE)
      || (dx <= RULED_RECT_AXIS_TOLERANCE && dy > RULED_RECT_AXIS_TOLERANCE);
  });
  if (!axisAligned) return null;
  const xs = points.map(point => point[0]);
  const ys = points.map(point => point[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const width = Math.max(...xs) - x;
  const height = Math.max(...ys) - y;
  if (width < RULED_RECT_MIN_SIZE || height < RULED_RECT_MIN_SIZE) return null;
  const uniqueCorners = [];
  for (const point of points) {
    if (!uniqueCorners.some(existing => Math.hypot(existing[0] - point[0], existing[1] - point[1]) <= RULED_RECT_AXIS_TOLERANCE)) {
      uniqueCorners.push(point);
    }
  }
  if (uniqueCorners.length !== 4) return null;
  return { x: round(x), y: round(y), width: round(width), height: round(height) };
}

function rectPaintVerb(pdfjsLib, paintOp, pendingClip) {
  if (pendingClip && paintOp === pdfjsLib.OPS?.endPath) return "clip";
  if (RECT_FILL_OP_NAMES.some(name => paintOp === pdfjsLib.OPS?.[name])) return "fill";
  if (RECT_STROKE_OP_NAMES.some(name => paintOp === pdfjsLib.OPS?.[name])) return "stroke";
  if (paintOp === pdfjsLib.OPS?.endPath) return "none";
  return null;
}

function rectGridKey(rect) {
  return [rect.x, rect.y, rect.width, rect.height].map(value => Math.round(value / RULED_RECT_AXIS_TOLERANCE));
}

function deduplicateRectangles(candidates) {
  const sorted = [...candidates].sort((left, right) => {
    const leftKey = rectGridKey(left);
    const rightKey = rectGridKey(right);
    for (let index = 0; index < leftKey.length; index += 1) {
      if (leftKey[index] !== rightKey[index]) return leftKey[index] - rightKey[index];
    }
    return left.operator_index - right.operator_index;
  });
  const buckets = new Map();
  const unique = [];
  for (const candidate of sorted) {
    const [x, y, width, height] = rectGridKey(candidate);
    let duplicate = false;
    for (let dx = -1; dx <= 1 && !duplicate; dx += 1) {
      for (let dy = -1; dy <= 1 && !duplicate; dy += 1) {
        for (let dw = -1; dw <= 1 && !duplicate; dw += 1) {
          for (let dh = -1; dh <= 1 && !duplicate; dh += 1) {
            const bucket = buckets.get(`${x + dx}:${y + dy}:${width + dw}:${height + dh}`) ?? [];
            duplicate = bucket.some(existing => existing.verb === candidate.verb
              && ["x", "y", "width", "height"].every(
                field => Math.abs(existing[field] - candidate[field]) <= RULED_RECT_AXIS_TOLERANCE,
              ));
          }
        }
      }
    }
    if (duplicate) continue;
    const key = `${x}:${y}:${width}:${height}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(candidate);
    buckets.set(key, bucket);
    unique.push(candidate);
  }
  return unique.sort((left, right) => left.operator_index - right.operator_index);
}

// Ported from firecrawl/pdf-inspector (MIT): src/tables/detect_rects.rs.
function deriveOperatorEvidence(pdfjsLib, operators, viewportTransform) {
  const fnArray = operators?.fnArray;
  if (!Array.isArray(fnArray)) throw new Error("Operator list fnArray is unavailable.");
  const argsArray = Array.isArray(operators?.argsArray) ? operators.argsArray : [];
  const imageOps = imageOperationSet(pdfjsLib);
  const constructPathOp = pdfjsLib.OPS?.constructPath;
  const matrixStack = [];
  const scopeBases = [0];
  let currentTransform = identityTransform();
  let pendingClip = false;
  let imagePaintOps = 0;
  let pathConstructOps = 0;
  let pathSegments = 0;
  const candidates = [];
  const displayTransform = Array.isArray(viewportTransform) && viewportTransform.length === 6
    ? viewportTransform : identityTransform();

  for (let operatorIndex = 0; operatorIndex < fnArray.length; operatorIndex += 1) {
    const operation = fnArray[operatorIndex];
    const args = operatorArgument(argsArray, operatorIndex);
    if (imageOps.has(operation)) imagePaintOps += 1;
    if (operation === pdfjsLib.OPS?.save) {
      matrixStack.push({ kind: "save", transform: currentTransform });
    } else if (operation === pdfjsLib.OPS?.restore) {
      const scopeBase = scopeBases.at(-1);
      if (matrixStack.length > scopeBase) currentTransform = matrixStack.pop().transform;
    } else if (operation === pdfjsLib.OPS?.transform) {
      currentTransform = multiplyTransforms(currentTransform, finiteMatrix(args, "transform"));
    } else if (operation === pdfjsLib.OPS?.paintFormXObjectBegin) {
      matrixStack.push({ kind: "form", transform: currentTransform });
      scopeBases.push(matrixStack.length);
      const formArgs = Array.isArray(args) ? args : [];
      // pdfjs passes [null, bbox] for a Form XObject without /Matrix; null
      // means identity, not an invalid operator list.
      if (formArgs[0] !== null && formArgs[0] !== undefined) {
        currentTransform = multiplyTransforms(currentTransform, finiteMatrix(formArgs[0], "Form XObject"));
      }
    } else if (operation === pdfjsLib.OPS?.paintFormXObjectEnd) {
      const scopeBase = scopeBases.length > 1 ? scopeBases.pop() : null;
      if (scopeBase !== null) {
        while (matrixStack.length > scopeBase) matrixStack.pop();
        const formFrame = matrixStack.pop();
        if (formFrame?.kind === "form") currentTransform = formFrame.transform;
      }
    } else if (operation === pdfjsLib.OPS?.clip || operation === pdfjsLib.OPS?.eoClip) {
      pendingClip = true;
    } else if (operation === constructPathOp) {
      pathConstructOps += 1;
      const argumentsForPath = Array.isArray(args) ? args : null;
      const buffer = pathBufferFromArguments(argumentsForPath);
      const commands = decodeDrawOps(buffer);
      pathSegments += commands.length;
      const paintOp = argumentsForPath?.[0];
      const verb = rectPaintVerb(pdfjsLib, paintOp, pendingClip);
      if (verb !== null && buffer !== null) {
        const combinedTransform = multiplyTransforms(displayTransform, currentTransform);
        for (const segments of rectangleSubpaths(commands)) {
          const rect = transformedRectangle(segments, combinedTransform);
          if (rect) candidates.push({ ...rect, verb, operator_index: operatorIndex });
        }
      }
      pendingClip = false;
    }
  }

  const unique = deduplicateRectangles(candidates);
  const returned = unique.slice(0, RULED_RECT_PAGE_LIMIT).map(({ operator_index: _operatorIndex, ...rect }) => rect);
  const truncated = unique.length > returned.length;
  return {
    ruled_rects: {
      status: truncated ? "truncated" : "available",
      observed_count: unique.length,
      returned_count: returned.length,
      items: returned,
    },
    operator_counts: {
      image_paint_ops: imagePaintOps,
      path_segments: pathSegments,
      path_construct_ops: pathConstructOps,
    },
  };
}

// Ported from firecrawl/pdf-inspector (MIT): src/text_quality.rs.
function codePointIsPrivateUse(codePoint) {
  return (codePoint >= 0xe000 && codePoint <= 0xf8ff)
    || (codePoint >= 0xf0000 && codePoint <= 0xffffd)
    || (codePoint >= 0x100000 && codePoint <= 0x10fffd);
}

// Ported from firecrawl/pdf-inspector (MIT): src/text_quality.rs.
function itemTextIntegrity(text) {
  const codePoints = [...text];
  let replacementCharacters = 0;
  let longestReplacementRun = 0;
  let replacementSpans = 0;
  let replacementRun = 0;
  let privateUse = 0;
  let privateUseRuns = 0;
  let privateRun = 0;
  for (const character of codePoints) {
    const codePoint = character.codePointAt(0);
    if (character === "\uFFFD") {
      replacementCharacters += 1;
      replacementRun += 1;
      longestReplacementRun = Math.max(longestReplacementRun, replacementRun);
    } else if (replacementRun > 0) {
      if (replacementRun >= 2) replacementSpans += 1;
      replacementRun = 0;
    }
    if (codePointIsPrivateUse(codePoint)) {
      privateUse += 1;
      privateRun += 1;
    } else if (privateRun > 0) {
      if (privateRun >= 3) privateUseRuns += 1;
      privateRun = 0;
    }
  }
  if (replacementRun >= 2) replacementSpans += 1;
  if (privateRun >= 3) privateUseRuns += 1;
  const replacementSignal = longestReplacementRun >= 2 || replacementCharacters >= 3;
  let c1ControlTokens = 0;
  for (const token of text.matchAll(/\S+/gu)) {
    const tokenText = token[0];
    const tokenCodePoints = [...tokenText];
    const c1Count = tokenCodePoints.filter(character => {
      const codePoint = character.codePointAt(0);
      return codePoint >= 0x80 && codePoint <= 0x9f;
    }).length;
    if (tokenCodePoints.length >= 5 && c1Count >= 2 && c1Count * 20 >= tokenCodePoints.length) c1ControlTokens += 1;
  }
  const privateUseSignal = privateUseRuns > 0
    || (codePoints.length >= 5 && privateUse >= 2 && privateUse * 2 >= codePoints.length);
  return {
    replacementCharacters: replacementSignal ? replacementCharacters : 0,
    longestReplacementRun,
    replacementSpans: replacementSignal ? replacementSpans : 0,
    privateUseRuns: privateUseSignal ? Math.max(1, privateUseRuns) : 0,
    privateUseSignal,
    c1ControlTokens,
  };
}

function nonAlphanumericDominance(text) {
  const codePoints = [...text];
  let total = 0;
  let alphanumeric = 0;
  for (let index = 0; index < codePoints.length;) {
    if ([".", "_", "·"].includes(codePoints[index])) {
      let end = index + 1;
      while (end < codePoints.length && [".", "_", "·"].includes(codePoints[end])) end += 1;
      if (end - index >= 3) {
        index = end;
        continue;
      }
    }
    const character = codePoints[index++];
    if (/\s/u.test(character)) continue;
    total += 1;
    if (/^[\p{L}\p{N}]$/u.test(character)) alphanumeric += 1;
  }
  return total >= 50 && alphanumeric * 2 < total;
}

function deriveTextIntegrity(textItemEntries, unavailable = false) {
  if (unavailable) return { status: "unavailable", signals: [] };
  const pageText = textItemEntries.map(([, item]) => item.str).join("\n");
  const itemSignals = textItemEntries.map(([, item]) => itemTextIntegrity(item.str));
  const characters = [...pageText].length;
  const replacementCharacters = itemSignals.reduce((sum, signal) => sum + signal.replacementCharacters, 0);
  const replacementSpans = itemSignals.reduce((sum, signal) => sum + signal.replacementSpans, 0);
  const longestReplacementRun = Math.max(0, ...itemSignals.map(signal => signal.longestReplacementRun));
  const privateUseRuns = itemSignals.reduce((sum, signal) => sum + signal.privateUseRuns, 0);
  const c1ControlTokens = itemSignals.reduce((sum, signal) => sum + signal.c1ControlTokens, 0);
  const replacementSuspect = (characters <= 80 && longestReplacementRun >= 2)
    || (replacementCharacters >= 12 && replacementCharacters / Math.max(1, characters) >= 0.05)
    || (replacementSpans >= 3 && replacementSpans / Math.max(1, characters) >= 0.025)
    || (longestReplacementRun >= 8 && longestReplacementRun / Math.max(1, characters) >= 0.025);
  const signals = [];
  if (replacementCharacters > 0) signals.push({ kind: "replacement_characters", count: replacementCharacters });
  if (privateUseRuns > 0) signals.push({ kind: "private_use_runs", count: privateUseRuns });
  if (c1ControlTokens > 0) signals.push({ kind: "c1_control_tokens", count: c1ControlTokens });
  if (nonAlphanumericDominance(pageText)) signals.push({ kind: "non_alphanumeric_dominance", count: 1 });
  return {
    status: replacementSuspect || privateUseRuns > 0 || c1ControlTokens > 0 || signals.some(signal => signal.kind === "non_alphanumeric_dominance")
      ? "suspect" : "ok",
    signals,
  };
}

function unavailablePaintedRectangles() {
  return {
    status: "unavailable",
    truncated: false,
    observed_count: 0,
    returned_count: 0,
    items: [],
  };
}

function unitRectangleGeometry(viewportTransform, graphicsTransform) {
  if (![...viewportTransform, ...graphicsTransform].every(Number.isFinite)) return null;
  const transformed = multiplyTransforms(viewportTransform, graphicsTransform);
  if (!transformed.every(Number.isFinite)) return null;
  const axisAligned = (Math.abs(transformed[1]) <= 0.002 && Math.abs(transformed[2]) <= 0.002)
    || (Math.abs(transformed[0]) <= 0.002 && Math.abs(transformed[3]) <= 0.002);
  if (!axisAligned) return null;
  const points = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => ({
    x: round(transformed[0] * x + transformed[2] * y + transformed[4]),
    y: round(transformed[1] * x + transformed[3] * y + transformed[5]),
  }));
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const width = round(Math.max(...xs) - x);
  const height = round(Math.max(...ys) - y);
  if (!(width > 0 && height > 0)) return null;
  return {
    quad: points,
    bbox: { x: round(x), y: round(y), width, height },
  };
}

/**
 * Preserve a bounded neutral projection of PDF.js solid-color image-mask
 * rectangles. These marks include rules but can also include fraction bars or
 * other artwork; table semantics are deliberately left to the renderer, which
 * must require a complete closed grid rather than trusting any one rectangle.
 */
function collectPaintedRectangles(operators, pdfjsLib, viewportTransform, pageNumber) {
  const save = pdfjsLib.OPS?.save;
  const restore = pdfjsLib.OPS?.restore;
  const transform = pdfjsLib.OPS?.transform;
  const paint = pdfjsLib.OPS?.paintSolidColorImageMask;
  if (![save, restore, transform, paint].every(Number.isInteger)
    || !Array.isArray(operators?.fnArray)
    || !Array.isArray(operators?.argsArray)) return unavailablePaintedRectangles();
  let current = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const items = [];
  let observedCount = 0;
  for (let operationIndex = 0; operationIndex < operators.fnArray.length; operationIndex += 1) {
    const operation = operators.fnArray[operationIndex];
    if (operation === save) {
      stack.push([...current]);
    } else if (operation === restore) {
      if (stack.length === 0) return unavailablePaintedRectangles();
      current = stack.pop();
    } else if (operation === transform) {
      const values = operators.argsArray[operationIndex];
      if (!Array.isArray(values) || values.length !== 6 || !values.every(Number.isFinite)) {
        return unavailablePaintedRectangles();
      }
      current = multiplyTransforms(current, values);
      if (!current.every(Number.isFinite)) return unavailablePaintedRectangles();
    } else if (operation === paint) {
      const geometry = unitRectangleGeometry(viewportTransform, current);
      if (!geometry) continue;
      observedCount += 1;
      if (items.length >= MAX_PAINTED_RECTANGLES) continue;
      items.push({
        id: `p${String(pageNumber).padStart(4, "0")}-r${String(operationIndex + 1).padStart(6, "0")}`,
        source_operation_index: operationIndex,
        source_kind: "solid_color_image_mask",
        graphics_transform: [...current],
        quad: geometry.quad,
        bbox: geometry.bbox,
      });
    }
  }
  return {
    status: "available",
    truncated: observedCount > items.length,
    observed_count: observedCount,
    returned_count: items.length,
    items,
  };
}

function errorRecord(stage, error) {
  return {
    stage,
    code: String(error?.name || "Error"),
    message: String(error?.message || error || "Unknown parser error").slice(0, 500),
  };
}

function withDeadline(operation, deadlineAt) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return Promise.reject(Object.assign(new Error("PDF layout extraction exceeded its 20 second deadline."), { code: "LAYOUT_DEADLINE" }));
  let timer;
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("PDF layout extraction exceeded its 20 second deadline."), { code: "LAYOUT_DEADLINE" })), remaining);
    }),
  ]).finally(() => clearTimeout(timer));
}

function classifyLoadingError(error, pdfjsLib) {
  const passwordCode = Number(error?.code);
  const passwordName = String(error?.name || "");
  if (passwordName !== "PasswordException") return error;
  const requiredCode = Number(pdfjsLib.PasswordResponses?.NEED_PASSWORD ?? 1);
  const incorrectCode = Number(pdfjsLib.PasswordResponses?.INCORRECT_PASSWORD ?? 2);
  if (passwordCode === requiredCode) {
    return Object.assign(new Error("PDF password is required."), { code: "PASSWORD_REQUIRED" });
  }
  if (passwordCode === incorrectCode) {
    return Object.assign(new Error("PDF password is incorrect."), { code: "PASSWORD_INCORRECT" });
  }
  return Object.assign(new Error("PDF password authentication failed."), { code: "PASSWORD_AUTHENTICATION_FAILED" });
}

function isFatalParserResourceError(error) {
  const name = String(error?.name || "");
  const code = String(error?.code || "");
  return code === "LAYOUT_DEADLINE"
    || /Abort|Cancel|Timeout|MissingPDF|UnexpectedResponse/i.test(name)
    || /DEADLINE|TIMEOUT|ABORT|CANCEL|ENOMEM|RESOURCE|EIO|EMFILE|ENFILE/i.test(code);
}

function recomputeDocumentTruncation(payload) {
  const truncatedPages = payload.pages.filter(page => page.truncation.truncated);
  payload.truncation.truncated = truncatedPages.length > 0;
  payload.truncation.omitted_items = truncatedPages.reduce((sum, page) => sum + page.truncation.omitted_items, 0);
  payload.truncation.omitted_characters = truncatedPages.reduce((sum, page) => sum + page.truncation.omitted_characters, 0);
  payload.truncation.first_omitted_page = truncatedPages[0]?.page ?? null;
  payload.truncation.first_omitted_source_index = truncatedPages[0]?.truncation.first_omitted_source_index ?? null;
}

function markOutputBudget(payload, maxOutputCharacters) {
  if (JSON.stringify(payload).length <= maxOutputCharacters) return payload;
  for (let index = payload.pages.length - 1; index >= 0 && JSON.stringify(payload).length > maxOutputCharacters; index -= 1) {
    const page = payload.pages[index];
    if (page.painted_rectangles.items.length === 0) continue;
    page.painted_rectangles = {
      status: "unavailable",
      truncated: true,
      observed_count: page.painted_rectangles.observed_count,
      returned_count: 0,
      items: [],
    };
    page.extraction_status = page.extraction_status === "failed" ? "failed" : "partial";
    page.needs_visual_inspection = true;
    if (!page.limitations.includes("Painted rectangle detail was omitted to satisfy max_output_characters.")) {
      page.limitations.push("Painted rectangle detail was omitted to satisfy max_output_characters.");
    }
  }
  if (JSON.stringify(payload).length <= maxOutputCharacters) {
    payload.extraction_status = payload.pages.every(page => page.extraction_status === "complete") ? "complete" : "partial";
    return payload;
  }
  if (!payload.truncation.reasons.includes("max_output_characters")) payload.truncation.reasons.push("max_output_characters");
  for (let index = payload.pages.length - 1; index >= 0 && JSON.stringify(payload).length > maxOutputCharacters; index -= 1) {
    const page = payload.pages[index];
    if (page.raw_items.length === 0 && page.lines.length === 0 && page.flow_text.length === 0) continue;
    page.truncation.truncated = true;
    if (!page.truncation.reasons.includes("max_output_characters")) page.truncation.reasons.push("max_output_characters");
    page.truncation.first_omitted_source_index = page.raw_items[0]?.source_index ?? page.truncation.first_omitted_source_index;
    page.truncation.omitted_items = page.counts.observed_items;
    page.truncation.omitted_non_whitespace_items = page.counts.observed_non_whitespace_items;
    page.truncation.omitted_characters = page.counts.observed_characters;
    page.counts.returned_items = 0;
    page.counts.returned_non_whitespace_items = 0;
    page.counts.returned_characters = 0;
    page.raw_items = [];
    page.lines = [];
    page.blocks = [];
    // Link items are page detail too. Leaving them would keep a link-heavy
    // page over budget and turn a bounded partial into a whole-call error.
    page.link_annotations = { status: "unavailable", truncated: true, items: [] };
    page.painted_rectangles = {
      status: "unavailable",
      truncated: true,
      observed_count: page.painted_rectangles.observed_count,
      returned_count: 0,
      items: [],
    };
    page.flow_text = "";
    page.spatial_text = "";
    page.reading_order = {
      strategy: "unavailable_output_omitted",
      confidence: "not_calibrated",
      column_count: 0,
      limitations: ["Reading-order evidence was omitted to satisfy max_output_characters."],
    };
    if (page.text_layer_status === "present") page.text_layer_status = "partial";
    page.extraction_status = "partial";
    page.needs_visual_inspection = true;
    if (!page.limitations.includes("Page detail omitted to satisfy max_output_characters.")) {
      page.limitations.push("Page detail omitted to satisfy max_output_characters.");
    }
  }
  recomputeDocumentTruncation(payload);
  if (JSON.stringify(payload).length > maxOutputCharacters) {
    throw new Error("Layout metadata exceeds max_output_characters. Request a narrower page range.");
  }
  payload.extraction_status = payload.pages.every(page => page.extraction_status === "failed") ? "failed" : "partial";
  return payload;
}

function finiteOrNull(value) {
  return Number.isFinite(Number(value)) ? round(value) : null;
}

function safeTransform(transform) {
  return Array.from({ length: 6 }, (_, index) => finiteOrNull(transform?.[index]));
}

function semanticAssertion(condition, message) {
  if (!condition) throw new Error(`Invalid Extraction IR semantics: ${message}`);
}

function sameRoundedNumber(left, right) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 0.002;
}

function roundedProductTolerance(left, right, leftError = 0.0005, rightError = 0.0005) {
  return 0.001 + Math.abs(left) * rightError + Math.abs(right) * leftError + leftError * rightError;
}

function roundedSpanProductTolerance(start, end, scale) {
  const span = end - start;
  return 0.001 + Math.abs(span) * 0.0005 + Math.abs(scale) * 0.001 + 0.0000005;
}

function expectedViewportGeometry(view, userUnit, rotation) {
  const [x1, y1, x2, y2] = view;
  const scale = userUnit;
  const xSpanTolerance = roundedSpanProductTolerance(x1, x2, scale);
  const ySpanTolerance = roundedSpanProductTolerance(y1, y2, scale);
  if (rotation === 0) {
    return {
      width: (x2 - x1) * scale,
      height: (y2 - y1) * scale,
      transform: [scale, 0, 0, -scale, -x1 * scale, y2 * scale],
      width_tolerance: xSpanTolerance,
      height_tolerance: ySpanTolerance,
      transform_tolerances: [0.002, 0.002, 0.002, 0.002, roundedProductTolerance(x1, scale), roundedProductTolerance(y2, scale)],
    };
  }
  if (rotation === 90) {
    return {
      width: (y2 - y1) * scale,
      height: (x2 - x1) * scale,
      transform: [0, scale, scale, 0, -y1 * scale, -x1 * scale],
      width_tolerance: ySpanTolerance,
      height_tolerance: xSpanTolerance,
      transform_tolerances: [0.002, 0.002, 0.002, 0.002, roundedProductTolerance(y1, scale), roundedProductTolerance(x1, scale)],
    };
  }
  if (rotation === 180) {
    return {
      width: (x2 - x1) * scale,
      height: (y2 - y1) * scale,
      transform: [-scale, 0, 0, scale, x2 * scale, -y1 * scale],
      width_tolerance: xSpanTolerance,
      height_tolerance: ySpanTolerance,
      transform_tolerances: [0.002, 0.002, 0.002, 0.002, roundedProductTolerance(x2, scale), roundedProductTolerance(y1, scale)],
    };
  }
  return {
    width: (y2 - y1) * scale,
    height: (x2 - x1) * scale,
    transform: [0, -scale, -scale, 0, y2 * scale, x2 * scale],
    width_tolerance: ySpanTolerance,
    height_tolerance: xSpanTolerance,
    transform_tolerances: [0.002, 0.002, 0.002, 0.002, roundedProductTolerance(y2, scale), roundedProductTolerance(x2, scale)],
  };
}

export function validatePdfLayoutSemantics(payload, {
  sourceBytes = null,
  enforceOutputBudget = true,
} = {}) {
  semanticAssertion(payload.id_scope.source_sha256 === payload.source.sha256, "ID scope source hash mismatch");
  semanticAssertion(payload.id_scope.parser_version === payload.parser.version, "ID scope parser mismatch");
  semanticAssertion(payload.id_scope.ir_version === payload.ir.version, "ID scope IR mismatch");
  semanticAssertion(payload.id_scope.requested_start_page === payload.page_range.requested_start_page, "ID scope start page mismatch");
  semanticAssertion(payload.id_scope.requested_end_page === payload.page_range.requested_end_page, "ID scope end page mismatch");
  semanticAssertion(payload.id_scope.max_items === payload.limits.max_items, "ID scope item limit mismatch");
  semanticAssertion(payload.id_scope.max_characters === payload.limits.max_characters, "ID scope character limit mismatch");
  semanticAssertion(payload.id_scope.max_output_characters === payload.limits.max_output_characters, "ID scope output limit mismatch");
  semanticAssertion(Number.isSafeInteger(payload.source.size_bytes)
    && payload.source.size_bytes >= 1
    && payload.source.size_bytes <= 250 * 1024 * 1024, "invalid source size");
  if (sourceBytes !== null) {
    semanticAssertion(payload.source.size_bytes === sourceBytes.length, "source byte length mismatch");
    semanticAssertion(payload.source.sha256 === createHash("sha256").update(sourceBytes).digest("hex"), "source byte hash mismatch");
  }
  semanticAssertion(Number.isInteger(payload.page_range.requested_start_page) && payload.page_range.requested_start_page >= 1, "invalid requested start page");
  semanticAssertion(payload.page_range.requested_end_page >= payload.page_range.requested_start_page, "invalid requested end page");
  semanticAssertion(payload.page_range.start_page === payload.page_range.requested_start_page
    && payload.page_range.end_page === payload.page_range.requested_end_page
    && payload.page_range.end_page <= payload.page_range.total_pages, "effective page range mismatch");
  semanticAssertion(payload.pages.length <= 10, "page range exceeds hard limit");
  semanticAssertion(payload.limits.max_items >= 1 && payload.limits.max_items <= 5000, "item limit out of range");
  semanticAssertion(payload.limits.max_characters >= 1 && payload.limits.max_characters <= 100000, "character limit out of range");
  semanticAssertion(payload.limits.max_output_characters >= 20000 && payload.limits.max_output_characters <= 200000, "output limit out of range");
  semanticAssertion(payload.limits.deadline_ms === 20000, "deadline mismatch");
  semanticAssertion(payload.pages.length === payload.page_range.end_page - payload.page_range.start_page + 1, "page range length mismatch");

  const documentIds = new Set();
  for (let pageOffset = 0; pageOffset < payload.pages.length; pageOffset += 1) {
    const page = payload.pages[pageOffset];
    const expectedPage = payload.page_range.start_page + pageOffset;
    const pagePrefix = `p${String(expectedPage).padStart(4, "0")}`;
    const links = page.link_annotations;
    semanticAssertion(links && typeof links === "object" && !Array.isArray(links),
      `page ${page.page} link annotations are malformed`);
    semanticAssertion(["available", "unavailable"].includes(links.status),
      `page ${page.page} link annotation status is invalid`);
    semanticAssertion(typeof links.truncated === "boolean",
      `page ${page.page} link annotation truncation flag is invalid`);
    semanticAssertion(Array.isArray(links.items) && links.items.length <= MAX_LINK_ANNOTATIONS,
      `page ${page.page} link annotation list is invalid`);
    semanticAssertion(links.status === "available" || links.items.length === 0,
      `page ${page.page} reports unavailable link annotations with retained items`);
    // An unavailable link state is only legitimate when the page carries an
    // annotations-stage error or had its detail omitted for the output budget.
    // Without this, downgrading available evidence to unavailable would pass.
    const linkAnnotationError = page.errors.some(
      error => error.stage === "annotations" || error.stage === "page",
    );
    const linkBudgetOmitted = page.truncation.reasons.includes("max_output_characters");
    if (links.status === "unavailable") {
      semanticAssertion(linkAnnotationError || linkBudgetOmitted,
        `page ${page.page} reports unavailable link annotations without supporting evidence`);
      semanticAssertion(!linkBudgetOmitted || links.truncated === true,
        `page ${page.page} omitted link detail for the output budget without recording truncation`);
    }
    for (let linkIndex = 0; linkIndex < links.items.length; linkIndex += 1) {
      const link = links.items[linkIndex];
      semanticAssertion(link.id === `${pagePrefix}-link${String(linkIndex + 1).padStart(4, "0")}`,
        `page ${page.page} link ${link.id} is out of order`);
      semanticAssertion([
        "http",
        "internal_destination",
        "action",
        "unsupported_scheme",
        "ambiguous_target",
        "none",
      ].includes(link.target_kind), `page ${page.page} link ${link.id} target kind is invalid`);
      // Only an http target may carry a URL, and it must already be exactly
      // the normalized absolute form the resolver would produce.
      if (link.target_kind === "http") {
        semanticAssertion(typeof link.url === "string"
          && link.url === supportedLinkUrl({ url: link.url }),
        `page ${page.page} link ${link.id} url is not a normalized supported target`);
      } else {
        semanticAssertion(link.url === null,
          `page ${page.page} link ${link.id} retains a url for a non-http target`);
      }
      semanticAssertion(!documentIds.has(link.id), `duplicate ID ${link.id}`);
      documentIds.add(link.id);
      semanticAssertion(link.rect === null || (
        Number.isFinite(link.rect.x) && Number.isFinite(link.rect.y)
        && Number.isFinite(link.rect.width) && Number.isFinite(link.rect.height)
        && link.rect.width >= 0 && link.rect.height >= 0
      ), `page ${page.page} link ${link.id} rect is invalid`);
    }
    semanticAssertion(page.page === expectedPage && page.id === pagePrefix, `page ${expectedPage} identity mismatch`);
    semanticAssertion(page.geometry.page === page.page, `page ${page.page} geometry identity mismatch`);
    const ruledRects = page.ruled_rects;
    semanticAssertion(ruledRects && typeof ruledRects === "object" && !Array.isArray(ruledRects),
      `page ${page.page} ruled rectangle evidence is malformed`);
    semanticAssertion(["available", "truncated", "failed", "unavailable"].includes(ruledRects.status),
      `page ${page.page} ruled rectangle status is invalid`);
    semanticAssertion(Number.isSafeInteger(ruledRects.observed_count) && ruledRects.observed_count >= 0
      && Number.isSafeInteger(ruledRects.returned_count) && ruledRects.returned_count >= 0
      && ruledRects.returned_count <= ruledRects.observed_count
      && Array.isArray(ruledRects.items) && ruledRects.items.length === ruledRects.returned_count
      && ruledRects.items.length <= RULED_RECT_PAGE_LIMIT,
    `page ${page.page} ruled rectangle accounting is invalid`);
    semanticAssertion((ruledRects.status === "truncated") === (ruledRects.observed_count > ruledRects.returned_count),
      `page ${page.page} ruled rectangle truncation status mismatch`);
    if (ruledRects.status === "available") {
      semanticAssertion(ruledRects.observed_count === ruledRects.returned_count,
        `page ${page.page} available ruled rectangle evidence is incomplete`);
    }
    if (ruledRects.status === "failed" || ruledRects.status === "unavailable") {
      semanticAssertion(ruledRects.items.length === 0 && ruledRects.observed_count === 0 && ruledRects.returned_count === 0,
      `page ${page.page} degraded ruled rectangle evidence retains geometry`);
    }
    if (ruledRects.status === "truncated" || ruledRects.status === "failed") {
      semanticAssertion(page.errors.some(error => error.stage === "ruled_rects"),
        `page ${page.page} degraded ruled rectangle evidence lacks a supporting error`);
    }
    if (ruledRects.status === "unavailable") {
      semanticAssertion(page.errors.some(error => error.stage === "operators" || error.stage === "page"),
        `page ${page.page} unavailable ruled rectangle evidence lacks an operator failure`);
    }
    for (const rect of ruledRects.items) {
      semanticAssertion(Number.isFinite(rect.x) && Number.isFinite(rect.y)
        && Number.isFinite(rect.width) && Number.isFinite(rect.height)
        && rect.x >= 0 && rect.y >= 0 && rect.width >= 0 && rect.height >= 0
        && ["fill", "stroke", "clip", "none"].includes(rect.verb),
      `page ${page.page} ruled rectangle geometry or verb is invalid`);
    }
    const operatorCounts = page.operator_counts;
    semanticAssertion(operatorCounts === null || (
      typeof operatorCounts === "object"
      && ["image_paint_ops", "path_segments", "path_construct_ops"].every(field => Number.isSafeInteger(operatorCounts[field]) && operatorCounts[field] >= 0)
    ), `page ${page.page} operator counts are invalid`);
    const textIntegrity = page.text_integrity;
    semanticAssertion(textIntegrity && typeof textIntegrity === "object" && !Array.isArray(textIntegrity)
      && ["ok", "suspect", "unavailable"].includes(textIntegrity.status)
      && Array.isArray(textIntegrity.signals), `page ${page.page} text-integrity evidence is malformed`);
    const textSignalKinds = ["replacement_characters", "private_use_runs", "c1_control_tokens", "non_alphanumeric_dominance"];
    const seenTextSignalKinds = new Set();
    for (const signal of textIntegrity.signals) {
      semanticAssertion(textSignalKinds.includes(signal.kind)
        && Number.isSafeInteger(signal.count) && signal.count > 0
        && !seenTextSignalKinds.has(signal.kind), `page ${page.page} text-integrity signal is invalid`);
      seenTextSignalKinds.add(signal.kind);
    }
    if (textIntegrity.status === "unavailable") {
      semanticAssertion(textIntegrity.signals.length === 0
        && page.errors.some(error => error.stage === "page" || error.stage === "text"),
      `page ${page.page} unavailable text-integrity evidence lacks a text failure`);
    }
    semanticAssertion(page.geometry.rotation_matches_raw === (page.geometry.display_rotation === null || page.geometry.raw_pdf_rotation === null
      ? null : page.geometry.display_rotation === page.geometry.raw_pdf_rotation), `page ${page.page} rotation cross-check mismatch`);
    const rawGeometryUnavailable = page.errors.some(error => error.code === "RAW_PAGE_GEOMETRY_UNAVAILABLE");
    if (rawGeometryUnavailable) {
      semanticAssertion(page.geometry.media_box === null
        && page.geometry.crop_box === null
        && page.geometry.raw_pdf_rotation === null
        && page.geometry.rotation_matches_raw === null, `page ${page.page} unavailable raw geometry contains claims`);
    } else {
      semanticAssertion(page.geometry.media_box !== null
        && page.geometry.crop_box !== null
        && page.geometry.raw_pdf_rotation !== null, `page ${page.page} raw geometry lacks unavailability evidence`);
    }
    for (const rawBox of [page.geometry.media_box, page.geometry.crop_box]) {
      if (rawBox) {
        semanticAssertion([rawBox.x, rawBox.y, rawBox.width, rawBox.height].every(Number.isFinite)
          && rawBox.width > 0 && rawBox.height > 0, `page ${page.page} invalid raw page box`);
      }
    }
    if (page.geometry.display_width !== null || page.geometry.display_height !== null) {
      semanticAssertion(Number.isFinite(page.geometry.display_width) && page.geometry.display_width > 0
        && Number.isFinite(page.geometry.display_height) && page.geometry.display_height > 0, `page ${page.page} invalid display size`);
      semanticAssertion(Array.isArray(page.geometry.viewport_transform)
        && page.geometry.viewport_transform.length === 6
        && page.geometry.viewport_transform.every(Number.isFinite), `page ${page.page} invalid viewport transform`);
      semanticAssertion(Array.isArray(page.geometry.pdfjs_view)
        && page.geometry.pdfjs_view.length === 4
        && page.geometry.pdfjs_view.every(Number.isFinite), `page ${page.page} invalid PDF.js view`);
      semanticAssertion(Number.isFinite(page.geometry.user_unit) && page.geometry.user_unit > 0, `page ${page.page} invalid UserUnit`);
      semanticAssertion(sameRoundedNumber(effectiveViewportScale(page.geometry.viewport_transform), page.geometry.user_unit), `page ${page.page} viewport scale/UserUnit mismatch`);
      const [viewX1, viewY1, viewX2, viewY2] = page.geometry.pdfjs_view;
      semanticAssertion(viewX2 > viewX1 && viewY2 > viewY1, `page ${page.page} invalid PDF.js view bounds`);
      semanticAssertion([0, 90, 180, 270].includes(page.geometry.display_rotation), `page ${page.page} invalid display rotation`);
      const expectedViewport = expectedViewportGeometry(
        page.geometry.pdfjs_view,
        page.geometry.user_unit,
        page.geometry.display_rotation,
      );
      semanticAssertion(Math.abs(page.geometry.display_width - expectedViewport.width) <= expectedViewport.width_tolerance
        && Math.abs(page.geometry.display_height - expectedViewport.height) <= expectedViewport.height_tolerance, `page ${page.page} display size/view mismatch`);
      semanticAssertion(page.geometry.viewport_transform.every((value, index) => Math.abs(value - expectedViewport.transform[index]) <= expectedViewport.transform_tolerances[index]), `page ${page.page} viewport transform/view/rotation mismatch`);
    }
    semanticAssertion(!documentIds.has(page.id), `duplicate ID ${page.id}`);
    documentIds.add(page.id);

    const painted = page.painted_rectangles;
    semanticAssertion(painted && ["available", "unavailable"].includes(painted.status),
      `page ${page.page} painted rectangle status is invalid`);
    semanticAssertion(typeof painted.truncated === "boolean"
      && Number.isSafeInteger(painted.observed_count) && painted.observed_count >= 0
      && Number.isSafeInteger(painted.returned_count) && painted.returned_count >= 0
      && painted.returned_count === painted.items.length
      && painted.returned_count <= painted.observed_count
      && painted.returned_count <= MAX_PAINTED_RECTANGLES,
    `page ${page.page} painted rectangle counts are invalid`);
    if (painted.status === "available") {
      semanticAssertion(painted.returned_count === Math.min(painted.observed_count, MAX_PAINTED_RECTANGLES)
        && painted.truncated === (painted.observed_count > painted.returned_count),
      `page ${page.page} painted rectangle availability is inconsistent`);
    } else {
      semanticAssertion(painted.returned_count === 0 && painted.items.length === 0,
        `page ${page.page} unavailable painted rectangles leaked items`);
    }
    let priorPaintOperation = -1;
    for (const item of painted.items) {
      semanticAssertion(Number.isSafeInteger(item.source_operation_index)
        && item.source_operation_index > priorPaintOperation,
      `page ${page.page} painted rectangle operation order is invalid`);
      priorPaintOperation = item.source_operation_index;
      semanticAssertion(item.id === `${pagePrefix}-r${String(item.source_operation_index + 1).padStart(6, "0")}`
        && item.source_kind === "solid_color_image_mask"
        && Array.isArray(item.graphics_transform)
        && item.graphics_transform.length === 6
        && item.graphics_transform.every(Number.isFinite),
      `painted rectangle ${item.id} source identity is invalid`);
      semanticAssertion(!documentIds.has(item.id), `duplicate ID ${item.id}`);
      documentIds.add(item.id);
      const expected = unitRectangleGeometry(
        page.geometry.viewport_transform,
        item.graphics_transform,
      );
      semanticAssertion(expected !== null
        && sameJson(item.quad, expected.quad)
        && sameJson(item.bbox, expected.bbox),
      `painted rectangle ${item.id} geometry mismatch`);
    }

    const itemById = new Map();
    let returnedCharacters = 0;
    for (let index = 0; index < page.raw_items.length; index += 1) {
      const item = page.raw_items[index];
      const expectedId = `${pagePrefix}-i${String(item.source_index + 1).padStart(6, "0")}`;
      semanticAssertion(item.id === expectedId, `item ID ${item.id} is outside its page/source scope`);
      semanticAssertion(!documentIds.has(item.id), `duplicate ID ${item.id}`);
      semanticAssertion(Number.isSafeInteger(item.source_index) && item.source_index >= 0, `item ${item.id} has unsafe source index`);
      semanticAssertion(item.source_index === index, `page ${page.page} retained items are not the exact source prefix`);
      documentIds.add(item.id);
      itemById.set(item.id, item);
      returnedCharacters += item.text.length;
      const expectedTextKind = item.text.length === 0 ? "empty" : item.text.trim().length === 0 ? "whitespace" : "non_whitespace";
      semanticAssertion(item.text_kind === expectedTextKind, `item ${item.id} text_kind mismatch`);
      semanticAssertion(item.is_whitespace === (expectedTextKind !== "non_whitespace"), `item ${item.id} whitespace mismatch`);
      if (item.source_text === undefined || item.glyph_recoveries === undefined) {
        semanticAssertion(item.source_text === undefined && item.glyph_recoveries === undefined,
          `item ${item.id} has incomplete glyph-recovery evidence`);
      } else {
        semanticAssertion(typeof item.source_text === "string"
          && Array.isArray(item.glyph_recoveries)
          && item.glyph_recoveries.length > 0,
        `item ${item.id} glyph-recovery evidence is malformed`);
        let sourceCursor = 0;
        let outputCursor = 0;
        let recoveredText = "";
        for (const recovery of item.glyph_recoveries) {
          const registry = TYPE3_RECOVERY_BY_ID.get(recovery.registry_id);
          semanticAssertion(registry
            && recovery.qualification === registry.qualification
            && recovery.original_char_code === registry.original_char_code
            && recovery.operator_unicode === registry.source_unicode
            && recovery.target_unicode === registry.target_unicode
            && recovery.charproc_sha256 === registry.charproc_sha256
            && sameJson(recovery.witness_charproc_sha256, registry.witnesses.map(witness => witness.charproc_sha256))
            && recovery.tfm_reference_version === CM_TFM_REFERENCE_VERSION
            && recovery.canonicalizer_version === TYPE3_GLYPH_CANONICALIZER_VERSION,
          `item ${item.id} glyph-recovery registry evidence is invalid`);
          const exactScalarBinding = recovery.binding_kind === "exact_text_scalar"
            && recovery.source_unicode === recovery.operator_unicode
            && recovery.source_unicode.length === 1
            && recovery.operator_advance_width === null
            && recovery.operator_anchor_span_width === null
            && recovery.operator_raw_transform === null;
          const collapsedWhitespaceBinding = recovery.binding_kind === "collapsed_whitespace_item"
            && recovery.source_unicode === " "
            && /^\s$/u.test(recovery.operator_unicode)
            && Number.isFinite(recovery.operator_advance_width)
            && recovery.operator_advance_width > 0
            && Number.isFinite(recovery.operator_anchor_span_width)
            && recovery.operator_anchor_span_width + 0.01 >= recovery.operator_advance_width
            && Array.isArray(recovery.operator_raw_transform)
            && recovery.operator_raw_transform.length === 6
            && recovery.operator_raw_transform.every(Number.isFinite);
          semanticAssertion(recovery.font_name === item.font_name
            && (exactScalarBinding || collapsedWhitespaceBinding)
            && recovery.target_unicode.length === 1
            && recovery.source_utf16_start === sourceCursor + item.source_text.slice(sourceCursor, recovery.source_utf16_start).length
            && recovery.source_utf16_end === recovery.source_utf16_start + recovery.source_unicode.length
            && recovery.output_utf16_start === outputCursor + item.source_text.slice(sourceCursor, recovery.source_utf16_start).length
            && recovery.output_utf16_end === recovery.output_utf16_start + 1
            && recovery.source_utf16_start >= sourceCursor
            && item.source_text.slice(recovery.source_utf16_start, recovery.source_utf16_end) === recovery.source_unicode,
          `item ${item.id} glyph-recovery offsets are invalid`);
          const unchanged = item.source_text.slice(sourceCursor, recovery.source_utf16_start);
          recoveredText += unchanged + recovery.target_unicode;
          sourceCursor = recovery.source_utf16_end;
          outputCursor = recovery.output_utf16_end;
        }
        recoveredText += item.source_text.slice(sourceCursor);
        semanticAssertion(recoveredText === item.text && item.source_text !== item.text,
          `item ${item.id} recovered text does not follow its evidence`);
      }
      const collapsedRecovery = item.glyph_recoveries?.find(recovery => recovery.binding_kind === "collapsed_whitespace_item") ?? null;
      const expectedGeometryFormula = collapsedRecovery
        ? "pdfjs_collapsed_type3_operator_advance_box_approximation"
        : "pdfjs_text_item_style_metric_advance_box_approximation";
      semanticAssertion(item.geometry_provenance.formula === expectedGeometryFormula, `item ${item.id} formula provenance mismatch`);
      semanticAssertion(item.geometry_provenance.quad_order === "anchor_top_terminal_top_anchor_bottom_terminal_bottom", `item ${item.id} quad order mismatch`);
      semanticAssertion(item.geometry_provenance.advance_source === (collapsedRecovery
        ? "operator_advance_width"
        : item.font.vertical ? "item_height" : "item_width"), `item ${item.id} advance provenance mismatch`);
      const expectedGeometry = computeItemGeometry(
        page.geometry.viewport_transform ?? [],
        collapsedRecovery?.operator_raw_transform ?? item.raw_transform ?? [],
        collapsedRecovery?.operator_advance_width ?? item.raw_width,
        item.raw_height,
        item.font,
      );
      semanticAssertion(item.geometry_valid === expectedGeometry.valid, `item ${item.id} geometry validity mismatch`);
      if (!item.geometry_valid) {
        semanticAssertion(item.bbox_status === "invalid" && item.quad === null && item.bbox === null, `item ${item.id} invalid geometry mismatch`);
        semanticAssertion([item.x, item.y, item.width, item.height, item.line_height].every(value => value === null), `item ${item.id} invalid geometry leaked coordinates`);
        semanticAssertion(item.geometry_provenance.ascent_source === null && item.geometry_provenance.ascent_ratio === null, `item ${item.id} invalid geometry provenance mismatch`);
      } else {
        semanticAssertion(Array.isArray(item.raw_transform)
          && item.raw_transform.length === 6
          && item.raw_transform.every(value => typeof value === "number" && Number.isFinite(value))
          && typeof item.raw_width === "number" && Number.isFinite(item.raw_width) && item.raw_width >= 0
          && typeof item.raw_height === "number" && Number.isFinite(item.raw_height) && item.raw_height >= 0, `item ${item.id} invalid raw PDF.js metrics`);
        semanticAssertion(Array.isArray(item.quad) && item.quad.length === 4 && item.bbox, `item ${item.id} missing valid geometry`);
        semanticAssertion(Number.isFinite(item.line_height) && item.line_height >= 0, `item ${item.id} invalid line height`);
        semanticAssertion(item.quad.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)), `item ${item.id} has non-finite quad`);
        semanticAssertion(item.quad.every((point, pointIndex) => sameRoundedNumber(point.x, expectedGeometry.quad[pointIndex].x)
          && sameRoundedNumber(point.y, expectedGeometry.quad[pointIndex].y)), `item ${item.id} quad does not match raw PDF.js metrics`);
        semanticAssertion(sameRoundedNumber(item.line_height, expectedGeometry.line_height), `item ${item.id} line height mismatch`);
        semanticAssertion(item.geometry_provenance.advance_source === (collapsedRecovery ? "operator_advance_width" : expectedGeometry.advance_source)
          && item.geometry_provenance.ascent_source === expectedGeometry.ascent_source
          && sameRoundedNumber(item.geometry_provenance.ascent_ratio, expectedGeometry.ascent_ratio), `item ${item.id} recomputed provenance mismatch`);
        const expectedRawCrossMetric = Math.hypot(item.raw_transform[2], item.raw_transform[3]);
        const rawCrossMetric = item.font.vertical ? item.raw_width : item.raw_height;
        semanticAssertion(rawCrossMetric === 0 || sameRoundedNumber(rawCrossMetric, expectedRawCrossMetric), `item ${item.id} raw cross metric mismatch`);
        const xs = item.quad.map(point => point.x);
        const ys = item.quad.map(point => point.y);
        const expectedBox = {
          x: Math.min(...xs),
          y: Math.min(...ys),
          width: Math.max(...xs) - Math.min(...xs),
          height: Math.max(...ys) - Math.min(...ys),
        };
        semanticAssertion(sameRoundedNumber(item.bbox.x, expectedBox.x)
          && sameRoundedNumber(item.bbox.y, expectedBox.y)
          && sameRoundedNumber(item.bbox.width, expectedBox.width)
          && sameRoundedNumber(item.bbox.height, expectedBox.height), `item ${item.id} bbox does not enclose its quad`);
        semanticAssertion(sameRoundedNumber(item.x, item.bbox.x)
          && sameRoundedNumber(item.y, item.bbox.y)
          && sameRoundedNumber(item.width, item.bbox.width)
          && sameRoundedNumber(item.height, item.bbox.height), `item ${item.id} convenience bbox mismatch`);
        const expectedBboxStatus = item.bbox.width === 0 || item.bbox.height === 0 ? "degenerate" : "valid";
        semanticAssertion(item.bbox_status === expectedBboxStatus, `item ${item.id} bbox_status mismatch`);
        semanticAssertion(sameRoundedNumber(item.bbox.x, expectedGeometry.bbox.x)
          && sameRoundedNumber(item.bbox.y, expectedGeometry.bbox.y)
          && sameRoundedNumber(item.bbox.width, expectedGeometry.bbox.width)
          && sameRoundedNumber(item.bbox.height, expectedGeometry.bbox.height), `item ${item.id} bbox does not match raw PDF.js metrics`);
        const expectedAscent = ascentRatio(item.font);
        semanticAssertion(item.geometry_provenance.ascent_source === expectedAscent.source
          && sameRoundedNumber(item.geometry_provenance.ascent_ratio, expectedAscent.ratio), `item ${item.id} ascent provenance mismatch`);
      }
    }

    semanticAssertion(page.counts.returned_items === page.raw_items.length, `page ${page.page} returned item count mismatch`);
    semanticAssertion(page.counts.returned_characters === returnedCharacters, `page ${page.page} returned character count mismatch`);
    semanticAssertion(page.counts.observed_items === page.counts.returned_items + page.truncation.omitted_items, `page ${page.page} observed item count mismatch`);
    semanticAssertion(page.counts.observed_characters === page.counts.returned_characters + page.truncation.omitted_characters, `page ${page.page} observed character count mismatch`);
    const returnedNonWhitespace = page.raw_items.filter(item => item.text_kind === "non_whitespace").length;
    semanticAssertion(page.counts.returned_non_whitespace_items === returnedNonWhitespace, `page ${page.page} returned non-whitespace count mismatch`);
    semanticAssertion(page.counts.observed_non_whitespace_items === page.counts.returned_non_whitespace_items + page.truncation.omitted_non_whitespace_items, `page ${page.page} observed non-whitespace count mismatch`);
    const pageHasOmissions = page.truncation.omitted_items > 0 || page.truncation.omitted_characters > 0;
    semanticAssertion(page.truncation.truncated === pageHasOmissions, `page ${page.page} truncation flag mismatch`);
    semanticAssertion(new Set(page.truncation.reasons).size === page.truncation.reasons.length, `page ${page.page} duplicate truncation reasons`);
    semanticAssertion(page.truncation.reasons.every(reason => ["max_items", "max_characters", "max_output_characters"].includes(reason)), `page ${page.page} unknown truncation reason`);
    semanticAssertion(page.truncation.truncated
      ? page.truncation.reasons.length > 0 && page.truncation.first_omitted_source_index !== null
      : page.truncation.reasons.length === 0 && page.truncation.first_omitted_source_index === null, `page ${page.page} truncation evidence mismatch`);
    if (page.truncation.first_omitted_source_index !== null) {
      semanticAssertion(page.truncation.first_omitted_source_index === page.raw_items.length,
        `page ${page.page} first omitted index is not the exact prefix boundary`);
    }
    semanticAssertion(page.text_layer_status === "partial" ? page.truncation.truncated : true, `page ${page.page} partial text status lacks truncation`);

    const lineById = new Map();
    const referencedItems = new Set();
    for (let index = 0; index < page.lines.length; index += 1) {
      const line = page.lines[index];
      semanticAssertion(line.reading_order_index === index, `line ${line.id} order mismatch`);
      semanticAssertion(line.id === `${pagePrefix}-l${String(line.source_first_index + 1).padStart(6, "0")}`, `line ${line.id} scope mismatch`);
      semanticAssertion(!documentIds.has(line.id), `duplicate ID ${line.id}`);
      semanticAssertion(line.item_ids.length > 0, `line ${line.id} is empty`);
      documentIds.add(line.id);
      lineById.set(line.id, line);
      const lineItems = line.item_ids.map(id => itemById.get(id));
      semanticAssertion(lineItems.every(Boolean), `line ${line.id} has a dangling item reference`);
      semanticAssertion(lineItems.every(item => item.geometry_valid && item.text_kind === "non_whitespace"), `line ${line.id} contains unsupported items`);
      semanticAssertion(lineItems.every(item => item.direction === line.direction), `line ${line.id} direction mismatch`);
      semanticAssertion(baselineInvariant(lineItems, 0.5), `line ${line.id} baseline spread mismatch`);
      semanticAssertion(Math.min(...lineItems.map(item => item.source_index)) === line.source_first_index, `line ${line.id} source index mismatch`);
      semanticAssertion(line.text === lineText(lineItems, line.direction), `line ${line.id} text mismatch`);
      const expectedLineBox = combineBounds(lineItems);
      semanticAssertion(sameRoundedNumber(line.x, expectedLineBox.x)
        && sameRoundedNumber(line.y, expectedLineBox.y)
        && sameRoundedNumber(line.width, expectedLineBox.width)
        && sameRoundedNumber(line.height, expectedLineBox.height), `line ${line.id} bounds mismatch`);
      for (const item of lineItems) {
        semanticAssertion(!referencedItems.has(item.id), `item ${item.id} appears in multiple lines`);
        semanticAssertion(item.line_id === line.id && item.column_index === line.column_index, `item ${item.id} line back-reference mismatch`);
        referencedItems.add(item.id);
      }
    }
    for (const item of page.raw_items) {
      semanticAssertion(Number.isInteger(item.reading_order_index)
        && item.reading_order_index >= 0
        && item.reading_order_index < page.raw_items.length, `item ${item.id} order is out of range`);
      semanticAssertion(item.line_id === null ? item.column_index === null : lineById.has(item.line_id), `item ${item.id} has a dangling line reference`);
      semanticAssertion(referencedItems.has(item.id) === (item.geometry_valid && item.text_kind === "non_whitespace"), `item ${item.id} line membership mismatch`);
    }
    semanticAssertion(new Set(page.raw_items.map(item => item.reading_order_index)).size === page.raw_items.length, `page ${page.page} item order is not a permutation`);
    const expectedItemOrder = [...page.lines.flatMap(line => line.item_ids), ...page.raw_items.filter(item => !referencedItems.has(item.id)).map(item => item.id)];
    for (let index = 0; index < expectedItemOrder.length; index += 1) {
      semanticAssertion(itemById.get(expectedItemOrder[index]).reading_order_index === index, `page ${page.page} item order reconstruction mismatch`);
    }

    const flattenedBlockLines = [];
    for (let index = 0; index < page.blocks.length; index += 1) {
      const block = page.blocks[index];
      semanticAssertion(block.id === `${pagePrefix}-b${String(index + 1).padStart(4, "0")}`, `block ${block.id} scope mismatch`);
      semanticAssertion(!documentIds.has(block.id), `duplicate ID ${block.id}`);
      semanticAssertion(block.line_ids.length > 0 && block.line_ids.every(id => lineById.has(id)), `block ${block.id} has dangling or empty line references`);
      const blockLines = block.line_ids.map(id => lineById.get(id));
      semanticAssertion(blockLines.every(line => line.column_index === block.column_index), `block ${block.id} column mismatch`);
      const expectedKind = block.column_index === -1
        ? "spanning_flow" : page.reading_order.column_count > 1 ? "column_flow" : "page_flow";
      semanticAssertion(block.kind === expectedKind, `block ${block.id} kind mismatch`);
      documentIds.add(block.id);
      flattenedBlockLines.push(...block.line_ids);
    }
    semanticAssertion(JSON.stringify(flattenedBlockLines) === JSON.stringify(page.lines.map(line => line.id)), `page ${page.page} block coverage mismatch`);
    semanticAssertion(page.flow_text === page.lines.map(line => line.text).join("\n"), `page ${page.page} flow text mismatch`);
    const expectedSpatial = page.lines.map(line => `[${line.id} x=${line.x} y=${line.y} w=${line.width} h=${line.height}] ${line.text}`).join("\n");
    semanticAssertion(page.spatial_text === expectedSpatial, `page ${page.page} spatial text mismatch`);
    const outputOmitted = page.truncation.reasons.includes("max_output_characters");
    semanticAssertion(outputOmitted
      ? page.reading_order.strategy === "unavailable_output_omitted" && page.lines.length === 0 && page.blocks.length === 0
      : page.reading_order.strategy !== "unavailable_output_omitted", `page ${page.page} reading-order availability mismatch`);
    if (page.reading_order.strategy === "two_column_left_to_right") {
      semanticAssertion(page.reading_order.column_count === 2 && page.lines.some(line => line.column_index === 0)
        && page.lines.some(line => line.column_index === 1), `page ${page.page} two-column evidence mismatch`);
    } else if (page.reading_order.strategy === "source_order_fallback") {
      semanticAssertion(page.reading_order.column_count === 1, `page ${page.page} source-order column count mismatch`);
    }
    const expectedTextLayerStatus = page.errors.some(error => error.stage === "page" || error.stage === "text")
      ? "failed" : page.counts.observed_items === 0 ? "empty" : page.truncation.truncated ? "partial" : "present";
    semanticAssertion(page.text_layer_status === expectedTextLayerStatus, `page ${page.page} text-layer status mismatch`);
    const expectedImageStatus = page.errors.some(error => error.stage === "page" || error.stage === "operators")
      ? "failed" : page.has_image_operations ? "detected" : "not_detected";
    semanticAssertion(page.image_detection_status === expectedImageStatus, `page ${page.page} image status mismatch`);
    const hasObservedText = page.counts.observed_non_whitespace_items > 0;
    const expectedModality = expectedImageStatus === "failed"
      ? "unknown"
      : hasObservedText && (page.has_image_operations || page.has_vector_paint_operations) ? "mixed-content-candidate"
        : hasObservedText ? "text-layer-candidate"
          : page.has_image_operations ? "image-only-candidate"
            : page.has_vector_paint_operations ? "vector-only-candidate" : "empty-candidate";
    semanticAssertion(page.modality_hint === expectedModality, `page ${page.page} modality mismatch`);
    const hasInvalidGeometry = page.raw_items.some(item => !item.geometry_valid);
    const hasRawGeometryGap = page.errors.some(error => error.code === "RAW_PAGE_GEOMETRY_UNAVAILABLE");
    const hasAnnotationError = page.errors.some(error => error.stage === "annotations");
    // Degraded link evidence, including a hit 200-link cap, is partial evidence.
    const hasDegradedLinks = page.link_annotations.status !== "available"
      || page.link_annotations.truncated === true;
    const hasDegradedPaintedRectangles = page.painted_rectangles.status !== "available"
      || page.painted_rectangles.truncated === true;
    const expectedExtraction = expectedTextLayerStatus === "failed"
      ? "failed"
      : page.truncation.truncated || hasInvalidGeometry || hasRawGeometryGap || expectedImageStatus === "failed" || expectedModality !== "text-layer-candidate" || hasAnnotationError || hasDegradedLinks || hasDegradedPaintedRectangles
        ? "partial" : "complete";
    semanticAssertion(page.extraction_status === expectedExtraction, `page ${page.page} extraction status mismatch`);
    semanticAssertion(page.needs_visual_inspection === (expectedExtraction !== "complete" || expectedModality !== "text-layer-candidate"), `page ${page.page} visual-inspection status mismatch`);
    if (page.extraction_status === "complete") {
      semanticAssertion(page.text_layer_status === "present"
        && page.image_detection_status !== "failed"
        && page.modality_hint === "text-layer-candidate"
        && !page.needs_visual_inspection
        && !page.truncation.truncated
        && page.errors.every(error => error.stage === "ruled_rects")
        && page.link_annotations.status === "available"
        && page.link_annotations.truncated === false
        && page.painted_rectangles.status === "available"
        && page.painted_rectangles.truncated === false
        && page.raw_items.every(item => item.geometry_valid), `page ${page.page} complete status overclaims evidence`);
    }
    if (page.text_layer_status === "failed") semanticAssertion(page.extraction_status === "failed", `page ${page.page} failed text status mismatch`);
    semanticAssertion(page.errors.every(error => ["page", "text", "operators", "geometry", "annotations", "ruled_rects"].includes(error.stage)
      && typeof error.code === "string" && error.code.length > 0 && error.code.length <= 100
      && typeof error.message === "string" && error.message.length > 0 && error.message.length <= 500), `page ${page.page} invalid error record`);
  }

  const truncatedPages = payload.pages.filter(page => page.truncation.truncated);
  const omittedItems = truncatedPages.reduce((sum, page) => sum + page.truncation.omitted_items, 0);
  const omittedCharacters = truncatedPages.reduce((sum, page) => sum + page.truncation.omitted_characters, 0);
  const documentReasons = [...new Set(payload.pages.flatMap(page => page.truncation.reasons))];
  semanticAssertion(payload.truncation.truncated === (truncatedPages.length > 0), "document truncation flag mismatch");
  semanticAssertion(payload.truncation.omitted_items === omittedItems && payload.truncation.omitted_characters === omittedCharacters, "document omission counts mismatch");
  semanticAssertion(payload.truncation.first_omitted_page === (truncatedPages[0]?.page ?? null), "document first omitted page mismatch");
  semanticAssertion(payload.truncation.first_omitted_source_index === (truncatedPages[0]?.truncation.first_omitted_source_index ?? null), "document first omitted item mismatch");
  semanticAssertion(JSON.stringify(payload.truncation.reasons) === JSON.stringify(documentReasons), "document truncation reasons mismatch");
  const expectedStatus = payload.pages.every(page => page.extraction_status === "complete")
    ? "complete" : payload.pages.every(page => page.extraction_status === "failed") ? "failed" : "partial";
  semanticAssertion(payload.extraction_status === expectedStatus, "document extraction status mismatch");
  if (enforceOutputBudget) {
    semanticAssertion(JSON.stringify(payload).length <= payload.limits.max_output_characters, "serialized output exceeds its declared limit");
  }
  return payload;
}

function sourceEvidenceAssertion(condition, message) {
  if (!condition) throw new Error(`Invalid Extraction IR source evidence: ${message}`);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function replayOutputBudgetIndependently(seedPayload, maxOutputCharacters) {
  const replay = structuredClone(seedPayload);
  replay.id_scope.max_output_characters = maxOutputCharacters;
  replay.limits.max_output_characters = maxOutputCharacters;
  if (JSON.stringify(replay).length <= maxOutputCharacters) return replay;
  for (let index = replay.pages.length - 1; index >= 0 && JSON.stringify(replay).length > maxOutputCharacters; index -= 1) {
    const page = replay.pages[index];
    if (page.painted_rectangles.items.length === 0) continue;
    page.painted_rectangles = {
      status: "unavailable",
      truncated: true,
      observed_count: page.painted_rectangles.observed_count,
      returned_count: 0,
      items: [],
    };
    page.extraction_status = page.extraction_status === "failed" ? "failed" : "partial";
    page.needs_visual_inspection = true;
    if (!page.limitations.includes("Painted rectangle detail was omitted to satisfy max_output_characters.")) {
      page.limitations.push("Painted rectangle detail was omitted to satisfy max_output_characters.");
    }
  }
  if (JSON.stringify(replay).length <= maxOutputCharacters) {
    replay.extraction_status = replay.pages.every(page => page.extraction_status === "complete") ? "complete" : "partial";
    return replay;
  }
  if (!replay.truncation.reasons.includes("max_output_characters")) replay.truncation.reasons.push("max_output_characters");
  for (let index = replay.pages.length - 1; index >= 0 && JSON.stringify(replay).length > maxOutputCharacters; index -= 1) {
    const page = replay.pages[index];
    if (page.raw_items.length === 0 && page.lines.length === 0 && page.flow_text.length === 0) continue;
    page.truncation.truncated = true;
    if (!page.truncation.reasons.includes("max_output_characters")) page.truncation.reasons.push("max_output_characters");
    page.truncation.first_omitted_source_index = page.raw_items[0]?.source_index ?? page.truncation.first_omitted_source_index;
    page.truncation.omitted_items = page.counts.observed_items;
    page.truncation.omitted_non_whitespace_items = page.counts.observed_non_whitespace_items;
    page.truncation.omitted_characters = page.counts.observed_characters;
    page.counts.returned_items = 0;
    page.counts.returned_non_whitespace_items = 0;
    page.counts.returned_characters = 0;
    page.raw_items = [];
    page.lines = [];
    page.blocks = [];
    page.link_annotations = { status: "unavailable", truncated: true, items: [] };
    page.painted_rectangles = {
      status: "unavailable",
      truncated: true,
      observed_count: page.painted_rectangles.observed_count,
      returned_count: 0,
      items: [],
    };
    page.flow_text = "";
    page.spatial_text = "";
    page.reading_order = {
      strategy: "unavailable_output_omitted",
      confidence: "not_calibrated",
      column_count: 0,
      limitations: ["Reading-order evidence was omitted to satisfy max_output_characters."],
    };
    if (page.text_layer_status === "present") page.text_layer_status = "partial";
    page.extraction_status = "partial";
    page.needs_visual_inspection = true;
    if (!page.limitations.includes("Page detail omitted to satisfy max_output_characters.")) {
      page.limitations.push("Page detail omitted to satisfy max_output_characters.");
    }
  }
  const truncatedPages = replay.pages.filter(page => page.truncation.truncated);
  replay.truncation.truncated = truncatedPages.length > 0;
  replay.truncation.reasons = [...new Set(replay.pages.flatMap(page => page.truncation.reasons))];
  replay.truncation.omitted_items = truncatedPages.reduce((sum, page) => sum + page.truncation.omitted_items, 0);
  replay.truncation.omitted_characters = truncatedPages.reduce((sum, page) => sum + page.truncation.omitted_characters, 0);
  replay.truncation.first_omitted_page = truncatedPages[0]?.page ?? null;
  replay.truncation.first_omitted_source_index = truncatedPages[0]?.truncation.first_omitted_source_index ?? null;
  sourceEvidenceAssertion(JSON.stringify(replay).length <= maxOutputCharacters, "independent output-budget replay exceeds its declared limit");
  replay.extraction_status = replay.pages.every(page => page.extraction_status === "failed") ? "failed" : "partial";
  return replay;
}

/**
 * Reparse the named source bytes and bind the Extraction IR's raw page and
 * TextItem evidence to that parse. Raw pdf-lib boxes/rotation are bound when a
 * second pdf-lib parse succeeds; otherwise their explicit unavailable/null
 * state is verified. validatePdfLayoutSemantics is deliberately
 * synchronous and proves only internal consistency (plus byte identity when
 * sourceBytes is supplied); callers claiming source-bound evidence must await
 * this validator instead.
 */
export async function validatePdfLayoutSourceEvidence(payload, {
  pdfjsLib,
  sourceBytes,
  password = null,
  deadlineAt = Date.now() + 20000,
  enforceOutputBudget = true,
} = {}) {
  validatePdfLayoutSemantics(payload, { sourceBytes, enforceOutputBudget });
  sourceEvidenceAssertion(pdfjsLib && typeof pdfjsLib.getDocument === "function", "PDF.js parser is required");
  sourceEvidenceAssertion(sourceBytes && Number.isSafeInteger(sourceBytes.length), "source bytes are required");
  sourceEvidenceAssertion(String(pdfjsLib.version || "unknown") === payload.parser.version, "parser version mismatch");

  let loadingTask = null;
  let document = null;
  let pdfLibPages = null;
  try {
    loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(sourceBytes),
      password: password || undefined,
      useWorkerFetch: false,
      isEvalSupported: false,
      ...PDFJS_DOCUMENT_ASSETS,
    });
    try {
      document = await withDeadline(loadingTask.promise, deadlineAt);
    } catch (error) {
      throw classifyLoadingError(error, pdfjsLib);
    }
    sourceEvidenceAssertion(document.numPages === payload.page_range.total_pages, "source page count mismatch");
    try {
      const pdfLibDocument = await withDeadline(PDFDocument.load(sourceBytes, { ignoreEncryption: true, updateMetadata: false }), deadlineAt);
      pdfLibPages = pdfLibDocument.getPages();
      if (pdfLibPages.length !== document.numPages) pdfLibPages = null;
    } catch (error) {
      if (isFatalParserResourceError(error)) throw error;
      pdfLibPages = null;
    }

    // Independent reference replay of the public retention contract. Keep this
    // intentionally small and separate from extractPdfLayout's product loop so
    // a shared implementation bug cannot validate itself.
    let replayRetainedItems = 0;
    let replayRetainedCharacters = 0;
    const sourceImageOps = imageOperationSet(pdfjsLib);
    const sourceVectorOps = vectorOperationSet(pdfjsLib);
    for (const outputPage of payload.pages) {
      let sourcePage = null;
      try {
        let sourceViewport = null;
        let sourcePageError = null;
        try {
          sourcePage = await withDeadline(document.getPage(outputPage.page), deadlineAt);
          sourceViewport = sourcePage.getViewport({ scale: 1 });
        } catch (error) {
          if (isFatalParserResourceError(error)) throw error;
          sourcePageError = error;
        }
        // Independently re-derive link annotation evidence from the reparsed
        // source. Annotations enter the IR as a trust-boundary crossing, so
        // they are re-read here rather than accepted from the product loop.
        let replayLinks = UNAVAILABLE_LINK_ANNOTATIONS;
        let replayLinksRead = false;
        if (sourcePage !== null && typeof sourcePage.getAnnotations === "function") {
          try {
            const sourceAnnotations = await withDeadline(
              sourcePage.getAnnotations({ intent: "display" }),
              deadlineAt,
            );
            replayLinks = collectLinkAnnotations(
              sourceAnnotations,
              sourceViewport?.transform ?? null,
              outputPage.page,
            );
            replayLinksRead = true;
          } catch (error) {
            if (isFatalParserResourceError(error) || error?.code === "LAYOUT_DEADLINE") throw error;
            replayLinks = UNAVAILABLE_LINK_ANNOTATIONS;
          }
        }
        const sourceGeometry = pageGeometry(
          pdfLibPages?.[outputPage.page - 1] ?? null,
          sourcePage,
          sourceViewport,
          outputPage.page,
        );
        for (const field of [
          "pdfjs_view",
          "user_unit",
          "display_rotation",
          "display_width",
          "display_height",
          "viewport_transform",
        ]) {
          sourceEvidenceAssertion(
            sameJson(outputPage.geometry[field], sourceGeometry[field]),
            `page ${outputPage.page} ${field} differs from reparsed source`,
          );
        }
        if (pdfLibPages) {
          for (const field of ["media_box", "crop_box", "raw_pdf_rotation", "rotation_matches_raw"]) {
            sourceEvidenceAssertion(
              sameJson(outputPage.geometry[field], sourceGeometry[field]),
              `page ${outputPage.page} ${field} differs from reparsed source`,
            );
          }
        } else {
          sourceEvidenceAssertion(
            outputPage.geometry.media_box === null
              && outputPage.geometry.crop_box === null
              && outputPage.geometry.raw_pdf_rotation === null
              && outputPage.geometry.rotation_matches_raw === null
              && outputPage.errors.some(error => error.code === "RAW_PAGE_GEOMETRY_UNAVAILABLE"),
            `page ${outputPage.page} raw page geometry is unverified but output contains claims`,
          );
        }
        if (sourcePageError !== null) {
          const expectedError = errorRecord("page", sourcePageError);
          const expectedErrors = [];
          if (!pdfLibPages) {
            expectedErrors.push({
              stage: "geometry",
              code: "RAW_PAGE_GEOMETRY_UNAVAILABLE",
              message: "Raw page-box enrichment was unavailable; PDF.js display geometry remains authoritative.",
            });
          }
          expectedErrors.push(expectedError);
          sourceEvidenceAssertion(
            sameJson(outputPage.errors, expectedErrors)
              && outputPage.text_layer_status === "failed"
              && outputPage.image_detection_status === "failed"
              && outputPage.extraction_status === "failed"
              && outputPage.modality_hint === "unknown"
              && outputPage.needs_visual_inspection === true
              && sameJson(outputPage.counts, {
                observed_items: 0,
                returned_items: 0,
                observed_non_whitespace_items: 0,
                returned_non_whitespace_items: 0,
                observed_characters: 0,
                returned_characters: 0,
              })
              && sameJson(outputPage.truncation, {
                truncated: false,
                reasons: [],
                omitted_items: 0,
                omitted_non_whitespace_items: 0,
                omitted_characters: 0,
                first_omitted_source_index: null,
              })
              && outputPage.raw_items.length === 0
              && outputPage.lines.length === 0
              && outputPage.blocks.length === 0
              && outputPage.flow_text === ""
              && outputPage.spatial_text === ""
              && sameJson(outputPage.reading_order, {
                strategy: "source_order_fallback",
                confidence: "not_calibrated",
                column_count: 1,
                limitations: [
                  "Column evidence was insufficient or ambiguous, so source item order was retained.",
                  "Source order is parser order and is not proof of intended or visible reading order.",
                ],
              })
              && outputPage.has_image_operations === null
              && outputPage.has_vector_paint_operations === null
              && sameJson(outputPage.ruled_rects, { status: "unavailable", observed_count: 0, returned_count: 0, items: [] })
              && outputPage.text_integrity.status === "unavailable"
              && outputPage.text_integrity.signals.length === 0
              && outputPage.operator_counts === null
              && sameJson(outputPage.painted_rectangles, unavailablePaintedRectangles()),
            `page ${outputPage.page} ordinary page failure differs from reparsed source`,
          );
          continue;
        }

        // Link-annotation evidence. Placed after the replay's own page-failure
        // handling so a genuine page or deadline failure is reported on its own
        // terms rather than as a link mismatch.
        if (outputPage.link_annotations.status === "available") {
          // An available claim must be authenticated by a successful
          // independent read. A missing getAnnotations or a failed replay read
          // can never authenticate link evidence.
          sourceEvidenceAssertion(
            replayLinksRead,
            `page ${outputPage.page} claims available link evidence that was not independently reparsed`,
          );
          sourceEvidenceAssertion(
            JSON.stringify(outputPage.link_annotations) === JSON.stringify(replayLinks),
            `page ${outputPage.page} link annotations differ from independently reparsed source`,
          );
        } else {
          const linkBudgetOmitted = outputPage.truncation.reasons.includes("max_output_characters");
          const linkReadFailed = outputPage.errors.some(
            error => error.stage === "annotations" || error.stage === "page",
          );
          sourceEvidenceAssertion(
            linkBudgetOmitted || linkReadFailed,
            `page ${outputPage.page} reports unavailable link evidence without supporting evidence`,
          );
          sourceEvidenceAssertion(
            outputPage.link_annotations.items.length === 0
              && (!linkBudgetOmitted || outputPage.link_annotations.truncated === true),
            `page ${outputPage.page} unavailable link evidence is malformed`,
          );
        }

        let textContent = null;
        try {
          textContent = await withDeadline(sourcePage.getTextContent({ includeMarkedContent: false, disableNormalization: false }), deadlineAt);
        } catch (error) {
          if (isFatalParserResourceError(error)) throw error;
          const expectedError = errorRecord("text", error);
          sourceEvidenceAssertion(
            outputPage.text_layer_status === "failed"
              && outputPage.raw_items.length === 0
              && outputPage.errors.some(outputError => sameJson(outputError, expectedError)),
            `page ${outputPage.page} source text parse failed but output claims text evidence`,
          );
        }
        const sourceEntries = (textContent?.items ?? [])
          .filter(item => typeof item?.str === "string")
          .map((item, sourceIndex) => [sourceIndex, item]);
        let sourceOperators = null;
        let sourceOperatorError = null;
        try {
          sourceOperators = await withDeadline(sourcePage.getOperatorList(), deadlineAt);
        } catch (error) {
          if (isFatalParserResourceError(error)) throw error;
          sourceOperatorError = error;
        }
        const sourceType3Recoveries = sourceOperatorError === null
          ? collectType3GlyphRecoveries({
            textContent,
            operators: sourceOperators,
            pdfjsPage: sourcePage,
            pdfLibPage: pdfLibPages?.[outputPage.page - 1] ?? null,
            pdfjsLib,
          })
          : new Map();
        const sourceEffectiveText = (sourceIndex, item) => applyType3GlyphRecoveries(
          item.str,
          sourceType3Recoveries.get(sourceIndex) ?? [],
        );
        // Dedicated source replay: ruled_rects, text_integrity, and operator_counts
        // are all replay-proven from the second parse; none are semantic-only.
        const sourceTextIntegrity = deriveTextIntegrity(sourceEntries, textContent === null);
        sourceEvidenceAssertion(
          sameJson(outputPage.text_integrity, sourceTextIntegrity),
          `page ${outputPage.page} text-integrity evidence differs from independently reparsed source`,
        );
        sourceEvidenceAssertion(outputPage.counts.observed_items === sourceEntries.length, `page ${outputPage.page} observed item count differs from reparsed source`);
        sourceEvidenceAssertion(
          outputPage.counts.observed_non_whitespace_items === sourceEntries.filter(([sourceIndex, item]) => sourceEffectiveText(sourceIndex, item).trim().length > 0).length,
          `page ${outputPage.page} observed non-whitespace count differs from reparsed source`,
        );
        sourceEvidenceAssertion(
          outputPage.counts.observed_characters === sourceEntries.reduce((sum, [, item]) => sum + item.str.length, 0),
          `page ${outputPage.page} observed character count differs from reparsed source`,
        );

        let replayPrefixLength = 0;
        let replayReason = null;
        for (const [, sourceItem] of sourceEntries) {
          const exceedsItems = replayRetainedItems >= payload.limits.max_items;
          const exceedsCharacters = replayRetainedCharacters + sourceItem.str.length > payload.limits.max_characters;
          if (replayReason !== null || exceedsItems || exceedsCharacters) {
            if (replayReason === null) replayReason = exceedsItems ? "max_items" : "max_characters";
            continue;
          }
          replayPrefixLength += 1;
          replayRetainedItems += 1;
          replayRetainedCharacters += sourceItem.str.length;
        }
        const outputOmitted = outputPage.truncation.reasons.includes("max_output_characters");
        const expectedReturnedEntries = outputOmitted ? [] : sourceEntries.slice(0, replayPrefixLength);
        const expectedOmittedEntries = outputOmitted ? sourceEntries : sourceEntries.slice(replayPrefixLength);
        const expectedReasons = [
          ...(replayReason === null ? [] : [replayReason]),
          ...(outputOmitted ? ["max_output_characters"] : []),
        ];
        sourceEvidenceAssertion(
          sameJson(outputPage.raw_items.map(item => item.source_index), expectedReturnedEntries.map(([sourceIndex]) => sourceIndex)),
          `page ${outputPage.page} retained items differ from independently replayed limits`,
        );
        sourceEvidenceAssertion(
          sameJson(outputPage.truncation.reasons, expectedReasons),
          `page ${outputPage.page} truncation reason differs from independently replayed limits`,
        );
        sourceEvidenceAssertion(
          outputPage.truncation.omitted_items === expectedOmittedEntries.length
            && outputPage.truncation.omitted_non_whitespace_items === expectedOmittedEntries.filter(([sourceIndex, item]) => sourceEffectiveText(sourceIndex, item).trim().length > 0).length
            && outputPage.truncation.omitted_characters === expectedOmittedEntries.reduce((sum, [, item]) => sum + item.str.length, 0),
          `page ${outputPage.page} omission counts differ from independently replayed limits`,
        );
        sourceEvidenceAssertion(
          outputPage.truncation.first_omitted_source_index === (expectedOmittedEntries.length > 0 ? expectedReturnedEntries.length : null),
          `page ${outputPage.page} first omitted index differs from independently replayed limits`,
        );

        const sourceByIndex = new Map(sourceEntries);
        const fontIds = new Map();
        for (const outputItem of outputPage.raw_items) {
          const sourceItem = sourceByIndex.get(outputItem.source_index);
          sourceEvidenceAssertion(sourceItem, `item ${outputItem.id} source index is absent from reparsed source`);
          const sourceStyle = textContent?.styles?.[sourceItem.fontName] ?? {};
          if (typeof sourceItem.fontName === "string" && !fontIds.has(sourceItem.fontName)) {
            fontIds.set(sourceItem.fontName, `font-${String(fontIds.size + 1).padStart(4, "0")}`);
          }
          const sourceFont = {
            family: typeof sourceStyle.fontFamily === "string" ? sourceStyle.fontFamily : null,
            ascent: finiteOrNull(sourceStyle.ascent),
            descent: finiteOrNull(sourceStyle.descent),
            vertical: sourceStyle.vertical === true,
          };
          const expectedFontName = typeof sourceItem.fontName === "string" ? fontIds.get(sourceItem.fontName) : null;
          const internalRecoveries = sourceType3Recoveries.get(outputItem.source_index) ?? [];
          const expectedText = applyType3GlyphRecoveries(sourceItem.str, internalRecoveries);
          const expectedGlyphRecoveries = expectedText === sourceItem.str ? undefined : internalRecoveries.map(recovery => ({
            source_utf16_start: recovery.source_utf16_start,
            source_utf16_end: recovery.source_utf16_end,
            output_utf16_start: recovery.output_utf16_start,
            output_utf16_end: recovery.output_utf16_end,
            original_char_code: recovery.original_char_code,
            source_unicode: recovery.source_unicode,
            operator_unicode: recovery.operator_unicode,
            target_unicode: recovery.target_unicode,
            binding_kind: recovery.binding_kind,
            operator_advance_width: recovery.operator_advance_width,
            operator_anchor_span_width: recovery.operator_anchor_span_width,
            operator_raw_transform: recovery.operator_raw_transform,
            font_name: expectedFontName,
            registry_id: recovery.registry_id,
            qualification: recovery.qualification,
            charproc_sha256: recovery.charproc_sha256,
            witness_charproc_sha256: recovery.witness_charproc_sha256,
            tfm_reference_version: recovery.tfm_reference_version,
            canonicalizer_version: recovery.canonicalizer_version,
          }));
          const comparisons = [
            ["text", outputItem.text, expectedText],
            ["source_text", outputItem.source_text, expectedGlyphRecoveries ? sourceItem.str : undefined],
            ["glyph_recoveries", outputItem.glyph_recoveries, expectedGlyphRecoveries],
            ["has_eol", outputItem.has_eol, sourceItem.hasEOL === true],
            ["raw_transform", outputItem.raw_transform, safeTransform(sourceItem.transform)],
            ["raw_width", outputItem.raw_width, finiteOrNull(sourceItem.width)],
            ["raw_height", outputItem.raw_height, finiteOrNull(sourceItem.height)],
            ["font_name", outputItem.font_name, expectedFontName],
            ["font", outputItem.font, sourceFont],
            ["direction", outputItem.direction, direction(sourceItem.dir)],
          ];
          for (const [field, actual, expected] of comparisons) {
            sourceEvidenceAssertion(sameJson(actual, expected), `item ${outputItem.id} ${field} differs from reparsed source`);
          }
        }

        let sourceOperatorEvidenceError = null;
        let sourceOperatorEvidence = null;
        if (sourceOperatorError === null) {
          try {
            if (!Array.isArray(sourceOperators?.fnArray)) throw new Error("Operator list fnArray is unavailable.");
            sourceOperatorEvidence = deriveOperatorEvidence(pdfjsLib, sourceOperators, sourceViewport?.transform ?? null);
          } catch (error) {
            if (isFatalParserResourceError(error)) throw error;
            sourceOperatorEvidenceError = error;
          }
        }
        if (sourceOperatorError === null) {
          const sourceHasImageOperations = sourceOperators.fnArray.some(operation => sourceImageOps.has(operation));
          const sourceHasVectorOperations = sourceOperators.fnArray.some(operation => sourceVectorOps.has(operation));
          const sourcePaintedRectangles = collectPaintedRectangles(
            sourceOperators,
            pdfjsLib,
            sourceViewport?.transform ?? [],
            outputPage.page,
          );
          const paintedOutputOmitted = outputPage.painted_rectangles.status === "unavailable"
            && outputPage.painted_rectangles.truncated === true
            && !outputPage.errors.some(error => error.stage === "operators" || error.stage === "page");
          const expectedPaintedRectangles = (outputOmitted || paintedOutputOmitted)
            ? {
              status: "unavailable",
              truncated: true,
              observed_count: sourcePaintedRectangles.observed_count,
              returned_count: 0,
              items: [],
            }
            : sourcePaintedRectangles;
          sourceEvidenceAssertion(
            outputPage.has_image_operations === sourceHasImageOperations
              && outputPage.has_vector_paint_operations === sourceHasVectorOperations
              && sameJson(outputPage.painted_rectangles, expectedPaintedRectangles)
              && !outputPage.errors.some(error => error.stage === "operators"),
            `page ${outputPage.page} operator evidence differs from reparsed source`,
          );
          if (sourceOperatorEvidenceError === null) {
            const expectedRuledErrors = sourceOperatorEvidence.ruled_rects.status === "truncated"
              ? [errorRecord("ruled_rects", Object.assign(new Error(`Ruled rectangle evidence exceeded the per-page limit of ${RULED_RECT_PAGE_LIMIT}.`), { name: "RULED_RECT_PAGE_LIMIT" }))]
              : [];
            sourceEvidenceAssertion(
              sameJson(outputPage.ruled_rects, sourceOperatorEvidence.ruled_rects)
                && sameJson(outputPage.operator_counts, sourceOperatorEvidence.operator_counts)
                && sameJson(outputPage.errors.filter(error => error.stage === "ruled_rects"), expectedRuledErrors),
              `page ${outputPage.page} dedicated operator evidence differs from independently reparsed source`,
            );
          } else {
            const expectedError = errorRecord("ruled_rects", sourceOperatorEvidenceError);
            sourceEvidenceAssertion(
              outputPage.ruled_rects.status === "failed"
                && outputPage.ruled_rects.observed_count === 0
                && outputPage.ruled_rects.returned_count === 0
                && outputPage.ruled_rects.items.length === 0
                && outputPage.operator_counts === null
                && sameJson(outputPage.errors.filter(error => error.stage === "ruled_rects"), [expectedError]),
              `page ${outputPage.page} failed dedicated operator evidence differs from independently reparsed source`,
            );
          }
        } else {
          const expectedError = errorRecord("operators", sourceOperatorError);
          sourceEvidenceAssertion(
            outputPage.has_image_operations === null
              && outputPage.has_vector_paint_operations === null
              && sameJson(outputPage.ruled_rects, { status: "unavailable", observed_count: 0, returned_count: 0, items: [] })
              && outputPage.operator_counts === null
              && sameJson(outputPage.painted_rectangles, unavailablePaintedRectangles())
              && outputPage.errors.some(outputError => sameJson(outputError, expectedError)),
            `page ${outputPage.page} source operator parse failed but output claims operator evidence`,
          );
        }
      } finally {
        sourcePage?.cleanup();
      }
    }
    const sourceTruncatedPages = payload.pages.filter(page => page.truncation.truncated);
    const sourceDocumentTruncation = {
      truncated: sourceTruncatedPages.length > 0,
      reasons: [...new Set(payload.pages.flatMap(page => page.truncation.reasons))],
      omitted_items: sourceTruncatedPages.reduce((sum, page) => sum + page.truncation.omitted_items, 0),
      omitted_characters: sourceTruncatedPages.reduce((sum, page) => sum + page.truncation.omitted_characters, 0),
      first_omitted_page: sourceTruncatedPages[0]?.page ?? null,
      first_omitted_source_index: sourceTruncatedPages[0]?.truncation.first_omitted_source_index ?? null,
    };
    sourceEvidenceAssertion(sameJson(payload.truncation, sourceDocumentTruncation), "document truncation differs from source-verified page records");
    const sourceDocumentStatus = payload.pages.every(page => page.extraction_status === "complete")
      ? "complete" : payload.pages.every(page => page.extraction_status === "failed") ? "failed" : "partial";
    sourceEvidenceAssertion(payload.extraction_status === sourceDocumentStatus, "document status differs from source-verified page records");
    if (!enforceOutputBudget) {
      sourceEvidenceAssertion(
        payload.pages.every(page => !page.truncation.reasons.includes("max_output_characters")
          && !(page.painted_rectangles.status === "unavailable" && page.painted_rectangles.truncated)),
        "internal Markdown evidence contains a public output-budget omission",
      );
    } else if (payload.pages.some(page => page.truncation.reasons.includes("max_output_characters")
      || (page.painted_rectangles.status === "unavailable" && page.painted_rectangles.truncated))) {
      const replaySeed = await extractPdfLayout({
        pdfjsLib,
        pdfBytes: sourceBytes,
        sourcePath: payload.source.pdf_path,
        sourceFileName: payload.source.file_name,
        sourceSha256: payload.source.sha256,
        sourceSizeBytes: payload.source.size_bytes,
        password,
        requestedStartPage: payload.page_range.requested_start_page,
        requestedEndPage: payload.page_range.requested_end_page,
        maxItems: payload.limits.max_items,
        maxCharacters: payload.limits.max_characters,
        maxOutputCharacters: 200000,
        deadlineMs: payload.limits.deadline_ms,
        operationDeadlineAt: deadlineAt,
        sourceEvidenceValidationToken: INTERNAL_SOURCE_REPLAY,
      });
      const replayedBudget = replayOutputBudgetIndependently(replaySeed, payload.limits.max_output_characters);
      sourceEvidenceAssertion(sameJson(payload, replayedBudget), "output omission differs from independent budget replay");
    }
    return payload;
  } finally {
    await document?.destroy().catch(() => {});
    await loadingTask?.destroy?.().catch(() => {});
  }
}

function horizontalGeometryIsAmbiguous(item) {
  if (item.direction === "ttb") return true;
  if (!item.geometry_valid || !item.quad || item.raw_width === 0) return false;
  const start = item.quad[0];
  const end = item.quad[1];
  const magnitude = Math.hypot(end.x - start.x, end.y - start.y);
  return magnitude > 0 && Math.abs((end.y - start.y) / magnitude) > 0.05;
}

export async function extractPdfLayout({
  pdfjsLib,
  pdfBytes,
  sourcePath,
  sourceFileName,
  sourceSha256,
  sourceSizeBytes = pdfBytes.length,
  password = null,
  requestedStartPage = 1,
  requestedEndPage = requestedStartPage,
  maxItems = 1000,
  maxCharacters = 50000,
  maxOutputCharacters = 50000,
  deadlineMs = 20000,
  operationDeadlineAt = null,
  sourceEvidenceValidationToken = null,
  outputProjectionToken = null,
}) {
  const deadlineAt = operationDeadlineAt ?? Date.now() + deadlineMs;
  let loadingTask = null;
  let document = null;
  try {
    loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(pdfBytes),
      password: password || undefined,
      useWorkerFetch: false,
      isEvalSupported: false,
      ...PDFJS_DOCUMENT_ASSETS,
    });
    try {
      document = await withDeadline(loadingTask.promise, deadlineAt);
    } catch (error) {
      throw classifyLoadingError(error, pdfjsLib);
    }
    let pdfLibPages = null;
    try {
      const pdfLibDocument = await withDeadline(PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false }), deadlineAt);
      pdfLibPages = pdfLibDocument.getPages();
    } catch (error) {
      if (isFatalParserResourceError(error)) throw error;
      pdfLibPages = null;
    }
    const totalPages = document.numPages;
    if (pdfLibPages && pdfLibPages.length !== totalPages) pdfLibPages = null;
    if (requestedStartPage < 1 || requestedStartPage > totalPages) {
      throw new Error(`start_page ${requestedStartPage} is out of range (1-${totalPages}).`);
    }
    if (requestedEndPage < requestedStartPage || requestedEndPage > totalPages) {
      throw new Error(`end_page ${requestedEndPage} is out of range (${requestedStartPage}-${totalPages}).`);
    }

    const pages = [];
    let retainedItemCount = 0;
    let retainedCharacterCount = 0;
    const imageOps = imageOperationSet(pdfjsLib);
    const vectorOps = vectorOperationSet(pdfjsLib);

    for (let pageNumber = requestedStartPage; pageNumber <= requestedEndPage; pageNumber += 1) {
      const errors = [];
      const limitations = [];
      if (!pdfLibPages) {
        errors.push({
          stage: "geometry",
          code: "RAW_PAGE_GEOMETRY_UNAVAILABLE",
          message: "Raw page-box enrichment was unavailable; PDF.js display geometry remains authoritative.",
        });
        limitations.push("Raw MediaBox, CropBox, and PDF rotation enrichment was unavailable for this page.");
      }
      let textContent = null;
      let hasImageOperations = null;
      let hasVectorPaintOperations = null;
      let ruledRects = { status: "unavailable", observed_count: 0, returned_count: 0, items: [] };
      let operatorCounts = null;
      let paintedRectangles = unavailablePaintedRectangles();
      let type3GlyphRecoveries = new Map();
      let pdfjsPage = null;
      let viewport = null;
      let linkAnnotations = UNAVAILABLE_LINK_ANNOTATIONS;
      try {
        pdfjsPage = await withDeadline(document.getPage(pageNumber), deadlineAt);
        viewport = pdfjsPage.getViewport({ scale: 1 });
        try {
          if (typeof pdfjsPage.getAnnotations !== "function") {
            throw new Error("Parser does not expose annotation evidence.");
          }
          const annotations = await withDeadline(
            pdfjsPage.getAnnotations({ intent: "display" }),
            deadlineAt,
          );
          linkAnnotations = collectLinkAnnotations(
            annotations,
            viewport?.transform ?? null,
            pageNumber,
          );
        } catch (error) {
          if (isFatalParserResourceError(error)) throw error;
          errors.push(errorRecord("annotations", error));
        }
        try {
          textContent = await withDeadline(pdfjsPage.getTextContent({ includeMarkedContent: false, disableNormalization: false }), deadlineAt);
        } catch (error) {
          if (isFatalParserResourceError(error)) throw error;
          errors.push(errorRecord("text", error));
        }
        try {
          const operators = await withDeadline(pdfjsPage.getOperatorList(), deadlineAt);
          hasImageOperations = operators.fnArray.some(operation => imageOps.has(operation));
          hasVectorPaintOperations = operators.fnArray.some(operation => vectorOps.has(operation));
          try {
            const operatorEvidence = deriveOperatorEvidence(pdfjsLib, operators, viewport?.transform ?? null);
            ruledRects = operatorEvidence.ruled_rects;
            operatorCounts = operatorEvidence.operator_counts;
            if (ruledRects.status === "truncated") {
              const limitError = Object.assign(new Error(`Ruled rectangle evidence exceeded the per-page limit of ${RULED_RECT_PAGE_LIMIT}.`), {
                name: "RULED_RECT_PAGE_LIMIT",
              });
              errors.push(errorRecord("ruled_rects", limitError));
            }
          } catch (error) {
            if (isFatalParserResourceError(error)) throw error;
            ruledRects = { status: "failed", observed_count: 0, returned_count: 0, items: [] };
            operatorCounts = null;
            errors.push(errorRecord("ruled_rects", error));
          }
          paintedRectangles = collectPaintedRectangles(
            operators,
            pdfjsLib,
            viewport?.transform ?? [],
            pageNumber,
          );
          type3GlyphRecoveries = collectType3GlyphRecoveries({
            textContent,
            operators,
            pdfjsPage,
            pdfLibPage: pdfLibPages?.[pageNumber - 1] ?? null,
            pdfjsLib,
          });
        } catch (error) {
          if (isFatalParserResourceError(error)) throw error;
          errors.push(errorRecord("operators", error));
        }
      } catch (error) {
        if (isFatalParserResourceError(error)) throw error;
        errors.push(errorRecord("page", error));
      } finally {
        pdfjsPage?.cleanup();
      }

      const geometry = pageGeometry(pdfLibPages?.[pageNumber - 1] ?? null, pdfjsPage, viewport, pageNumber);
      const textItemEntries = (textContent?.items ?? [])
        .filter(item => typeof item?.str === "string")
        .map((item, sourceIndex) => [sourceIndex, item]);
      const textIntegrity = deriveTextIntegrity(textItemEntries, textContent === null);
      const observedCharacters = textItemEntries.reduce((sum, [, item]) => sum + item.str.length, 0);
      const rawItems = [];
      const pageReasons = [];
      let firstOmittedSourceIndex = null;
      let hardSegment = 0;
      let invalidGeometry = false;
      const fontIds = new Map();

      for (const [sourceIndex, item] of textItemEntries) {
        const retentionAlreadyTruncated = firstOmittedSourceIndex !== null;
        const exceedsItems = retainedItemCount >= maxItems;
        const exceedsCharacters = retainedCharacterCount + item.str.length > maxCharacters;
        if (retentionAlreadyTruncated || exceedsItems || exceedsCharacters) {
          if (firstOmittedSourceIndex === null) firstOmittedSourceIndex = sourceIndex;
          if (!retentionAlreadyTruncated) {
            const reason = exceedsItems ? "max_items" : "max_characters";
            if (!pageReasons.includes(reason)) pageReasons.push(reason);
          }
          if (item.hasEOL) hardSegment += 1;
          continue;
        }
        const style = textContent?.styles?.[item.fontName] ?? {};
        const rawTransform = safeTransform(item.transform);
        const rawWidth = finiteOrNull(item.width);
        const rawHeight = finiteOrNull(item.height);
        const font = {
          family: typeof style.fontFamily === "string" ? style.fontFamily : null,
          ascent: finiteOrNull(style.ascent),
          descent: finiteOrNull(style.descent),
          vertical: style.vertical === true,
        };
        const itemRecoveries = type3GlyphRecoveries.get(sourceIndex) ?? [];
        const collapsedRecovery = itemRecoveries.find(recovery => recovery.binding_kind === "collapsed_whitespace_item") ?? null;
        const geometryAdvanceWidth = collapsedRecovery?.operator_advance_width ?? rawWidth;
        const geometryItem = computeItemGeometry(
          geometry.viewport_transform ?? [],
          collapsedRecovery?.operator_raw_transform ?? rawTransform,
          geometryAdvanceWidth,
          rawHeight,
          font,
        );
        if (typeof item.fontName === "string" && !fontIds.has(item.fontName)) {
          fontIds.set(item.fontName, `font-${String(fontIds.size + 1).padStart(4, "0")}`);
        }
        const effectiveText = applyType3GlyphRecoveries(item.str, itemRecoveries);
        const publicFontName = typeof item.fontName === "string" ? fontIds.get(item.fontName) : null;
        const publicRecoveries = effectiveText === item.str ? [] : itemRecoveries.map(recovery => ({
          source_utf16_start: recovery.source_utf16_start,
          source_utf16_end: recovery.source_utf16_end,
          output_utf16_start: recovery.output_utf16_start,
          output_utf16_end: recovery.output_utf16_end,
          original_char_code: recovery.original_char_code,
          source_unicode: recovery.source_unicode,
          operator_unicode: recovery.operator_unicode,
          target_unicode: recovery.target_unicode,
          binding_kind: recovery.binding_kind,
          operator_advance_width: recovery.operator_advance_width,
          operator_anchor_span_width: recovery.operator_anchor_span_width,
          operator_raw_transform: recovery.operator_raw_transform,
          font_name: publicFontName,
          registry_id: recovery.registry_id,
          qualification: recovery.qualification,
          charproc_sha256: recovery.charproc_sha256,
          witness_charproc_sha256: recovery.witness_charproc_sha256,
          tfm_reference_version: recovery.tfm_reference_version,
          canonicalizer_version: recovery.canonicalizer_version,
        }));
        if (!geometryItem.valid) {
          invalidGeometry = true;
          errors.push({ stage: "geometry", code: "NONFINITE_TEXT_GEOMETRY", message: `Text item ${sourceIndex} has non-finite geometry.` });
        }
        const rawItem = {
          id: `p${String(pageNumber).padStart(4, "0")}-i${String(sourceIndex + 1).padStart(6, "0")}`,
          source_index: sourceIndex,
          text: effectiveText,
          ...(publicRecoveries.length > 0 ? { source_text: item.str, glyph_recoveries: publicRecoveries } : {}),
          is_whitespace: effectiveText.trim().length === 0,
          text_kind: effectiveText.length === 0 ? "empty" : effectiveText.trim().length === 0 ? "whitespace" : "non_whitespace",
          has_eol: item.hasEOL === true,
          raw_transform: rawTransform,
          raw_width: rawWidth,
          raw_height: rawHeight,
          font_name: publicFontName,
          font,
          geometry_kind: "pdfjs_text_run_advance_box",
          geometry_valid: geometryItem.valid,
          bbox_status: !geometryItem.valid ? "invalid" : geometryItem.bbox.width === 0 || geometryItem.bbox.height === 0 ? "degenerate" : "valid",
          geometry_provenance: {
            formula: collapsedRecovery
              ? "pdfjs_collapsed_type3_operator_advance_box_approximation"
              : "pdfjs_text_item_style_metric_advance_box_approximation",
            quad_order: "anchor_top_terminal_top_anchor_bottom_terminal_bottom",
            advance_source: collapsedRecovery ? "operator_advance_width" : geometryItem.advance_source,
            ascent_source: geometryItem.ascent_source,
            ascent_ratio: geometryItem.ascent_ratio,
          },
          quad: geometryItem.quad,
          bbox: geometryItem.bbox,
          x: geometryItem.bbox?.x ?? null,
          y: geometryItem.bbox?.y ?? null,
          width: geometryItem.bbox?.width ?? null,
          height: geometryItem.bbox?.height ?? null,
          line_height: geometryItem.line_height,
          direction: direction(item.dir),
          reading_order_index: -1,
          line_id: null,
          column_index: null,
        };
        Object.defineProperty(rawItem, "hard_segment", { value: hardSegment, enumerable: false });
        rawItems.push(rawItem);
        retainedItemCount += 1;
        retainedCharacterCount += item.str.length;
        if (item.hasEOL) hardSegment += 1;
      }

      const lineCandidates = rawItems.filter(item => item.geometry_valid && !item.is_whitespace);
      const forceSourceOrder = invalidGeometry || lineCandidates.some(horizontalGeometryIsAmbiguous);
      const sourceLines = sourceOrderLines(rawItems, pageNumber);
      const grouped = groupLines(lineCandidates, pageNumber);
      const ordered = readingOrder(grouped, geometry.display_width ?? geometry.crop_box.width, {
        sourceLines,
        forceSourceOrder,
        fallbackReason: invalidGeometry
          ? "At least one retained item had invalid geometry, so source order was retained."
          : "Vertical or skewed text made geometric order ambiguous, so source order was retained.",
      });
      const itemById = new Map(rawItems.map(item => [item.id, item]));
      const orderedIds = [];
      ordered.lines.forEach((line, lineIndex) => {
        line.reading_order_index = lineIndex;
        for (const itemId of line.item_ids) {
          const item = itemById.get(itemId);
          item.line_id = line.id;
          item.column_index = line.column_index;
          orderedIds.push(itemId);
        }
      });
      const orderedIdSet = new Set(orderedIds);
      for (const item of rawItems) {
        if (!orderedIdSet.has(item.id)) {
          orderedIds.push(item.id);
          orderedIdSet.add(item.id);
        }
      }
      const orderById = new Map(orderedIds.map((id, index) => [id, index]));
      for (const item of rawItems) item.reading_order_index = orderById.get(item.id);

      const textLayerStatus = errors.some(error => error.stage === "page" || error.stage === "text")
        ? "failed" : textItemEntries.length === 0 ? "empty" : firstOmittedSourceIndex !== null ? "partial" : "present";
      const imageDetectionStatus = errors.some(error => error.stage === "page" || error.stage === "operators")
        ? "failed" : hasImageOperations ? "detected" : "not_detected";
      const hasText = textItemEntries.some(([, item]) => item.str.trim().length > 0);
      let modalityHint = "unknown";
      if (imageDetectionStatus !== "failed") {
        if (hasText && (hasImageOperations || hasVectorPaintOperations)) modalityHint = "mixed-content-candidate";
        else if (hasText) modalityHint = "text-layer-candidate";
        else if (hasImageOperations) modalityHint = "image-only-candidate";
        else if (hasVectorPaintOperations) modalityHint = "vector-only-candidate";
        else modalityHint = "empty-candidate";
      }
      const pageTruncated = firstOmittedSourceIndex !== null;
      let extractionStatus = "complete";
      if (textLayerStatus === "failed") extractionStatus = "failed";
      else if (pageTruncated || invalidGeometry || !pdfLibPages || imageDetectionStatus === "failed" || modalityHint !== "text-layer-candidate" || errors.some(error => error.stage === "annotations") || linkAnnotations.truncated === true || paintedRectangles.status !== "available" || paintedRectangles.truncated === true) extractionStatus = "partial";
      const needsVisualInspection = extractionStatus !== "complete" || modalityHint !== "text-layer-candidate";
      if (hasImageOperations) limitations.push("Image paint operations were detected, but no image was rendered or OCRed; this is not raster-content proof.");
      if (hasVectorPaintOperations) limitations.push("Vector paint operations were detected but not interpreted.");
      if (imageDetectionStatus === "failed") limitations.push("Image and vector gap detection failed for this page.");
      if (pageTruncated) limitations.push("Page content is incomplete because a caller-supplied retention limit was reached.");
      if (invalidGeometry) limitations.push("At least one retained text item had non-finite geometry and was excluded from geometric reconstruction.");
      limitations.push("The PDF text layer can contain hidden, clipped, duplicated, or OCR-overlay text and is not proof of visible content.");

      const flowText = ordered.lines.map(line => line.text).join("\n");
      pages.push({
        id: `p${String(pageNumber).padStart(4, "0")}`,
        page: pageNumber,
        text_layer_status: textLayerStatus,
        image_detection_status: imageDetectionStatus,
        modality_hint: modalityHint,
        extraction_status: extractionStatus,
        needs_visual_inspection: needsVisualInspection,
        geometry,
        has_image_operations: hasImageOperations,
        has_vector_paint_operations: hasVectorPaintOperations,
        ruled_rects: ruledRects,
        text_integrity: textIntegrity,
        operator_counts: operatorCounts,
        painted_rectangles: paintedRectangles,
        link_annotations: linkAnnotations,
        raw_items: rawItems,
        lines: ordered.lines,
        blocks: buildBlocks(ordered.lines, pageNumber, ordered.column_count),
        reading_order: {
          strategy: ordered.strategy,
          confidence: ordered.confidence,
          column_count: ordered.column_count,
          limitations: ordered.limitations,
        },
        flow_text: flowText,
        spatial_text: ordered.lines.map(line => `[${line.id} x=${line.x} y=${line.y} w=${line.width} h=${line.height}] ${line.text}`).join("\n"),
        counts: {
          observed_items: textItemEntries.length,
          returned_items: rawItems.length,
          observed_non_whitespace_items: textItemEntries.filter(([sourceIndex, item]) => applyType3GlyphRecoveries(
            item.str,
            type3GlyphRecoveries.get(sourceIndex) ?? [],
          ).trim().length > 0).length,
          returned_non_whitespace_items: rawItems.filter(item => item.text_kind === "non_whitespace").length,
          observed_characters: observedCharacters,
          returned_characters: rawItems.reduce((sum, item) => sum + item.text.length, 0),
        },
        truncation: {
          truncated: pageTruncated,
          reasons: pageReasons,
          omitted_items: textItemEntries.length - rawItems.length,
          omitted_non_whitespace_items: textItemEntries.filter(([sourceIndex, item]) => applyType3GlyphRecoveries(
            item.str,
            type3GlyphRecoveries.get(sourceIndex) ?? [],
          ).trim().length > 0).length
            - rawItems.filter(item => item.text_kind === "non_whitespace").length,
          omitted_characters: observedCharacters - rawItems.reduce((sum, item) => sum + item.text.length, 0),
          first_omitted_source_index: firstOmittedSourceIndex,
        },
        errors,
        limitations,
      });
    }

    const payload = {
      ir: { name: IR_NAME, version: IR_VERSION },
      parser: { name: "pdfjs-dist", version: String(pdfjsLib.version || "unknown") },
      source: { pdf_path: sourcePath, file_name: sourceFileName, sha256: sourceSha256, size_bytes: sourceSizeBytes },
      id_scope: {
        kind: "source_parser_ir_options",
        source_sha256: sourceSha256,
        parser_version: String(pdfjsLib.version || "unknown"),
        ir_version: IR_VERSION,
        requested_start_page: requestedStartPage,
        requested_end_page: requestedEndPage,
        max_items: maxItems,
        max_characters: maxCharacters,
        max_output_characters: maxOutputCharacters,
      },
      page_range: {
        requested_start_page: requestedStartPage,
        requested_end_page: requestedEndPage,
        start_page: requestedStartPage,
        end_page: requestedEndPage,
        total_pages: totalPages,
      },
      extraction_status: pages.every(page => page.extraction_status === "complete")
        ? "complete" : pages.every(page => page.extraction_status === "failed") ? "failed" : "partial",
      pages,
      limits: { max_items: maxItems, max_characters: maxCharacters, max_output_characters: maxOutputCharacters, deadline_ms: deadlineMs },
      truncation: {
        truncated: false,
        reasons: [...new Set(pages.flatMap(page => page.truncation.reasons))],
        omitted_items: 0,
        omitted_characters: 0,
        first_omitted_page: null,
        first_omitted_source_index: null,
      },
      limitations: [
        "Local PDF.js text-layer geometry only; no rendering, OCR, table inference, or arbitrary schema extraction is performed.",
        "PDF.js display-viewport coordinates are not interchangeable with render_pdf_region or signing coordinates; do not pass these boxes to those tools.",
        "Text-run quads are a deterministic PDF.js TextItem/style-metric approximation, not DOM TextLayer or glyph ink bounds.",
        "Text-layer content can be hidden, clipped, duplicated, or an OCR overlay and is not proof of visible page content.",
        "Reading order is deterministic conservative reconstruction, not tagged-PDF or intended semantic order.",
        "Legacy Computer Modern Type-3 text is recovered only for independently qualified exact metric, target-glyph, witness-glyph, and full-page sequence matches; every unsupported or ambiguous variant is left unchanged.",
      ],
    };
    recomputeDocumentTruncation(payload);
    const internalMarkdownProjection = outputProjectionToken === INTERNAL_MARKDOWN_PROJECTION;
    const projectedPayload = internalMarkdownProjection
      ? payload
      : markOutputBudget(payload, maxOutputCharacters);
    const validatedPayload = validatePdfLayoutSemantics(projectedPayload, {
      sourceBytes: pdfBytes,
      enforceOutputBudget: !internalMarkdownProjection,
    });
    if (sourceEvidenceValidationToken === INTERNAL_SOURCE_REPLAY) return validatedPayload;
    return await validatePdfLayoutSourceEvidence(validatedPayload, {
      pdfjsLib,
      sourceBytes: pdfBytes,
      password,
      deadlineAt,
      enforceOutputBudget: !internalMarkdownProjection,
    });
  } finally {
    await document?.destroy().catch(() => {});
    await loadingTask?.destroy?.().catch(() => {});
  }
}

/**
 * Produce source-validated bounded layout evidence for the deterministic local
 * Markdown renderer before the public read_pdf_layout response projection can
 * omit whole-page detail. This remains bounded by the same page, item,
 * character, and deadline limits. It is not an MCP response payload and must
 * be reduced by the Markdown renderer before returning to a client.
 */
export async function extractPdfLayoutForMarkdown(options) {
  return extractPdfLayout({
    ...options,
    outputProjectionToken: INTERNAL_MARKDOWN_PROJECTION,
  });
}

export const EXTRACTION_IR_IDENTITY = Object.freeze({ name: IR_NAME, version: IR_VERSION });
