import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CURRENT_PRODUCT_SURFACES = [
  "README.md",
  "CLAUDE.md",
  "AGENTS.md",
  "docs/MAINTAINERS.md",
  "docs/SUPPORT.md",
  "docs/releases/v0.9.5.md",
  "pdf-toolkit-mcp-share/README.md",
  "manifest.json",
  "manifest.mcpb.json",
  "server/index.js",
  "pdf-toolkit-mcp-share/server/index.js",
];
const POSITIVE_OCR_PATTERNS = [
  /\bOCR\s*(?:\/\s*image\s*)?(?:support|fallback|extraction|engine|capabilit(?:y|ies)|pipeline)\b/i,
  /\b(?:automatic|built[- ]in|bundled|integrated|native|local)\s+OCR\b/i,
  /\b(?:includes?|runs?|performs?|provides?|supports?|uses?|ships?|offers?|handles?)\b[^.!?;\n]{0,60}\bOCR\b/i,
  /\bwith\s+(?:(?:automatic|built[- ]in|integrated|local)\s+)?OCR\b/i,
  /\bOCR\s+is\s+(?:not\s+)?(?:supported|included|available|enabled|bundled|built[ -]in)\b/i,
  /\b(?:has|have|features?|contains?)\b[^.!?;\n]{0,40}\bOCR\b/i,
  /\bOCR[ -]enabled\b/i,
  /\bOCR\b[^.!?;\n]{0,40}\bbuilt[ -]in\b/i,
];
const EXPLICIT_OCR_BOUNDARIES = [
  /\b(?:does not|do not|doesn't|don't|cannot|can't|never)\s+(?:currently\s+)?(?:bundle|include|run|perform|provide|support|use|ship|offer|have)\b[^.!?;\n]{0,80}\bOCR\b/i,
  /\bdoes not\s+render\s+pages,\s+run\s+OCR(?:\s*,|\s+or\b)/i,
  /\bno\s+(?:(?:built[- ]in|bundled|integrated|local|automatic)\s+)?OCR\s+(?:support|fallback|extraction|engine|capabilit(?:y|ies)|pipeline)\b/i,
  /\bwithout\s+(?:(?:built[- ]in|bundled|integrated|local|automatic)\s+)?OCR\b/i,
  /\b(?:future|planned|proposed|candidate|experimental|optional)\s+(?:(?:local|bundled|integrated)\s+)?OCR\b/i,
  /\bOCR\b[^.!?;\n]{0,100}\b(?:unavailable|unsupported|unshipped|planned|proposed|future|candidate|evaluation|benchmark)\b/i,
  /\bOCR\b[^.!?;\n]{0,100}\bnot\s+(?:shipped|included|available|supported|bundled|implemented|enabled)\b/i,
  /\bOCR\s+is\s+not\s+(?:supported|included|available|enabled|bundled|built[ -]in)\b/i,
  /\b(?:has|have|features?|contains?)\s+no\s+OCR\b/i,
  /\bOCR\b[^.!?;\n]{0,40}\bdoes not come built[ -]in\b/i,
  /\bnot\s+OCR[ -]enabled\b/i,
];
const POSITIVE_SCANNED_TEXT_PATTERNS = [
  /\b(?:recognizes?|extracts?|reads?|transcribes?)\s+(?:all\s+)?scanned\s+text\b/i,
  /\b(?:recognizes?|extracts?|reads?|transcribes?)\s+(?:all\s+)?text\s+(?:from|in)\s+scanned\s+(?:PDFs?|documents?|pages?)\b/i,
  /\bscanned\s+(?:PDFs?|text|documents?|pages?)\s+(?:is|are)\s+(?:not\s+)?(?:automatically\s+)?(?:recognized|extracted|read|transcribed)\b/i,
  /\btext\s+(?:in|from)\s+scanned\s+(?:PDFs?|documents?|pages?)\s+(?:is|are)\s+(?:not\s+)?(?:automatically\s+)?(?:recognized|extracted|read|transcribed)\b/i,
];
const EXPLICIT_SCANNED_TEXT_BOUNDARIES = [
  /\b(?:does not|do not|doesn't|don't|cannot|can't|never)\s+(?:currently\s+)?(?:recognize|extract|read|transcribe)\b[^.!?;\n]{0,80}\bscanned\s+(?:text|PDFs?|documents?|pages?)\b/i,
  /\bscanned\s+(?:text|PDFs?|documents?|pages?)\b[^.!?;\n]{0,80}\b(?:not recognized|not extracted|unrecognized|unsupported|planned|future)\b/i,
  /\btext\s+(?:in|from)\s+scanned\s+(?:PDFs?|documents?|pages?)\s+(?:is|are)\s+not\s+(?:recognized|extracted|read|transcribed)\b/i,
];
const POSITIVE_PDF_PARSE_PATTERNS = [
  /\b(?:uses?|includes?|requires?|bundles?)\b[^.!?;\n]{0,50}\bpdf-parse\b/i,
  /\bdepends?\s+on\b[^.!?;\n]{0,50}\bpdf-parse\b/i,
  /\bships?\s+with\b[^.!?;\n]{0,50}\bpdf-parse\b/i,
  /\bpdf-parse\s+is\s+(?:not\s+)?(?:used|included|required|bundled|installed)\b/i,
];
const EXPLICIT_PDF_PARSE_BOUNDARIES = [
  /\b(?:does not|do not|doesn't|don't|never)\s+(?:currently\s+)?(?:use|include|require|bundle)\b[^.!?;\n]{0,50}\bpdf-parse\b/i,
  /\b(?:does not|do not|doesn't|don't|never)\s+(?:currently\s+)?depend\s+on\b[^.!?;\n]{0,50}\bpdf-parse\b/i,
  /\b(?:does not|do not|doesn't|don't|never)\s+(?:currently\s+)?ship\s+with\b[^.!?;\n]{0,50}\bpdf-parse\b/i,
  /\bpdf-parse\s+is\s+not\s+(?:used|included|required|bundled|installed)\b/i,
];

async function readRepositoryFile(relativePath) {
  return fs.readFile(path.join(REPO_ROOT, relativePath), "utf8");
}

function findMatches(contents, pattern) {
  return contents
    .split("\n")
    .flatMap((line, index) => pattern.test(line) ? [`${index + 1}: ${line.trim()}`] : []);
}

function collectJsonStrings(value, strings = []) {
  if (typeof value === "string") {
    strings.push(value);
  } else if (Array.isArray(value)) {
    value.forEach(item => collectJsonStrings(item, strings));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach(item => collectJsonStrings(item, strings));
  }
  return strings;
}

function splitClaimUnits(text, { sourceCode = false } = {}) {
  if (sourceCode) {
    return text.split("\n").map(line => line.trim()).filter(Boolean);
  }

  return text
    .replaceAll("\r\n", "\n")
    .split(/\n\s*\n/)
    .flatMap(paragraph => {
      const lines = paragraph.split("\n").map(line => line.trim()).filter(Boolean);
      const hasListItems = lines.some(line => /^(?:[-*•]|\d+[.)])\s+/.test(line));
      const units = hasListItems ? lines : [lines.join(" ")];
      return units.flatMap(unit => unit.split(/(?<=[.!?;])\s+/));
    })
    .map(unit => unit.trim())
    .filter(Boolean);
}

function claimUnits(relativePath, contents) {
  if (relativePath.endsWith(".json")) {
    return collectJsonStrings(JSON.parse(contents)).flatMap(value => splitClaimUnits(value));
  }
  return splitClaimUnits(contents, { sourceCode: relativePath.endsWith(".js") });
}

function findOcrClaimViolations(units) {
  return units.filter(unit => {
    const positiveOcr = POSITIVE_OCR_PATTERNS.some(pattern => pattern.test(unit));
    const boundedOcr = EXPLICIT_OCR_BOUNDARIES.some(pattern => pattern.test(unit));
    const positiveScannedText = POSITIVE_SCANNED_TEXT_PATTERNS.some(pattern => pattern.test(unit));
    const boundedScannedText = EXPLICIT_SCANNED_TEXT_BOUNDARIES.some(pattern => pattern.test(unit));
    return (positiveOcr && !boundedOcr) || (positiveScannedText && !boundedScannedText);
  });
}

function findPdfParseClaimViolations(units) {
  return units.filter(unit =>
    POSITIVE_PDF_PARSE_PATTERNS.some(pattern => pattern.test(unit)) &&
    !EXPLICIT_PDF_PARSE_BOUNDARIES.some(pattern => pattern.test(unit))
  );
}

describe("documentation capability claims", () => {
  it("does not advertise absent PDF or OCR dependencies on current product surfaces", async () => {
    const violations = [];

    for (const relativePath of CURRENT_PRODUCT_SURFACES) {
      const contents = await readRepositoryFile(relativePath);
      const units = claimUnits(relativePath, contents);
      for (const unit of findPdfParseClaimViolations(units)) {
        violations.push(`${relativePath}: ${unit}`);
      }
      for (const unit of findOcrClaimViolations(units)) {
        violations.push(`${relativePath}: ${unit}`);
      }
      if (relativePath.endsWith("server/index.js")) {
        expect(contents, relativePath).toContain("No text was found in the PDF.js text layer.");
        expect(contents, relativePath).toContain(
          "Rendering page 1 as an image for host/model visual inspection...",
        );
        expect(contents, relativePath).not.toMatch(/OCR fallback/i);
      }
    }

    expect(CURRENT_PRODUCT_SURFACES).toContain("docs/releases/v0.9.5.md");
    expect(CURRENT_PRODUCT_SURFACES.some(relativePath => /evaluation/i.test(relativePath))).toBe(false);

    for (const relativePath of ["package.json", "pdf-toolkit-mcp-share/package.json"]) {
      const packageJson = JSON.parse(await readRepositoryFile(relativePath));
      const dependencyNames = Object.keys({
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      });
      expect(dependencyNames, relativePath).not.toContain("pdf-parse");
      expect(
        dependencyNames.some(name => /(?:^|[-_/])ocr(?:$|[-_/])/i.test(name)),
        `${relativePath} must not silently add an OCR package while docs describe OCR as unshipped`,
      ).toBe(false);
    }

    expect(violations).toEqual([]);
  });

  it.each([
    "PDF Tools does not include OCR support.",
    "A future OCR fallback is planned but not shipped.",
    "OCR support is unavailable in the current runtime.",
    "Optional local OCR remains a candidate for evaluation.",
    "The current package has no built-in OCR engine.",
    "OCR is not supported by the current runtime.",
    "The package has no OCR.",
    "OCR does not come built in.",
    "The runtime is not OCR-enabled.",
    "This tool does not render pages, run OCR, infer tables, or fill an arbitrary schema.",
    "PDF Tools renders scanned PDF pages for host/model visual inspection.",
    "The runtime does not recognize scanned text; it returns raster images for visual inspection.",
    "Scanned PDFs are not recognized as text.",
    "Text in scanned PDFs is not extracted by the runtime.",
  ])("allows explicitly qualified OCR boundary: %s", phrase => {
    expect(findOcrClaimViolations(splitClaimUnits(phrase))).toEqual([]);
  });

  it.each([
    "OCR fallback handles scanned PDFs.",
    "Built-in OCR reads scans.",
    "PDF Tools includes OCR for invoices.",
    "The runtime runs OCR locally.",
    "PDF Tools performs OCR automatically.",
    "Scans work with OCR.",
    "Automatic OCR is available.",
    "No text layer is required, and PDF Tools includes OCR.",
    "The runtime has no upload step but performs OCR.",
    "OCR support is included. Future improvements are planned.",
    "PDF Tools includes OCR, although no separate service is used.",
    "No OCR errors occur because built-in OCR reads scans.",
    "PDF Tools does not fail when it includes OCR.",
    "Future UI polish includes OCR support today.",
    "PDF Tools recognizes scanned text.",
    "PDF Tools extracts text from scanned PDFs.",
    "PDF Tools reads scanned text automatically.",
    "OCR is supported.",
    "OCR is included.",
    "OCR is available.",
    "OCR is enabled.",
    "OCR is bundled.",
    "OCR is built in.",
    "PDF Tools has OCR.",
    "PDF Tools features OCR.",
    "PDF Tools contains OCR.",
    "This is an OCR-enabled runtime.",
    "This tool does not render pages, but it runs OCR.",
    "This tool does not render pages and does run OCR.",
    "Scanned PDFs are recognized as text.",
    "Scanned text is extracted automatically.",
    "Scanned documents are read by the runtime.",
    "Scanned pages are transcribed.",
    "Text in scanned PDFs is recognized.",
    "Text from scanned PDFs is extracted automatically.",
  ])("rejects positive or qualification-bypass OCR claim: %s", phrase => {
    expect(findOcrClaimViolations(splitClaimUnits(phrase))).not.toEqual([]);
  });

  it.each([
    "PDF Tools does not use pdf-parse.",
    "The current runtime does not depend on pdf-parse.",
    "The package does not include pdf-parse.",
    "pdf-parse is not installed.",
  ])("allows explicitly negative pdf-parse boundary: %s", phrase => {
    expect(findPdfParseClaimViolations(splitClaimUnits(phrase))).toEqual([]);
  });

  it.each([
    "PDF Tools uses pdf-parse.",
    "The package includes pdf-parse.",
    "The runtime depends on pdf-parse.",
    "PDF Tools ships with pdf-parse.",
    "pdf-parse is installed.",
    "PDF Tools does not upload files but uses pdf-parse.",
  ])("rejects positive pdf-parse dependency claim: %s", phrase => {
    expect(findPdfParseClaimViolations(splitClaimUnits(phrase))).not.toEqual([]);
  });

  it("allows historical and evaluation files to describe former or candidate dependencies", () => {
    const historicalText =
      "Version 0.2 used pdf-parse. A candidate OCR engine was evaluated and removed.";

    expect(CURRENT_PRODUCT_SURFACES).not.toContain("docs/releases/v0.2.0.md");
    expect(CURRENT_PRODUCT_SURFACES).not.toContain("docs/EXTRACTION_EVALUATION.md");
    expect(historicalText).toContain("pdf-parse");
    expect(findOcrClaimViolations(splitClaimUnits(historicalText))).toEqual([]);
  });

  it("keeps extraction limitations explicit on current product surfaces", async () => {
    const readme = await readRepositoryFile("README.md");
    const developmentGuide = await readRepositoryFile("CLAUDE.md");
    const maintainerGuide = await readRepositoryFile("docs/MAINTAINERS.md");
    const shareReadme = await readRepositoryFile("pdf-toolkit-mcp-share/README.md");
    const sourceManifest = JSON.parse(await readRepositoryFile("manifest.json"));
    const packedManifest = JSON.parse(await readRepositoryFile("manifest.mcpb.json"));

    for (const [name, contents] of [
      ["README.md", readme],
      ["CLAUDE.md", developmentGuide],
      ["docs/MAINTAINERS.md", maintainerGuide],
      ["pdf-toolkit-mcp-share/README.md", shareReadme],
    ]) {
      expect(contents, name).toMatch(/does not (?:currently )?bundle an OCR engine/i);
      expect(contents, name).toMatch(/selected\s+(?:`read_pdf_content`\s+)?(?:result|extraction)[\s\S]{0,180}no text[\s\S]{0,180}page 1/i);
      expect(contents, name).toMatch(/(?:raster images?|rasterization)[\s\S]{0,120}(?:not|do not|rather than)[\s\S]{0,80}(?:recognized text|produce recognized text)/i);
      expect(contents, name).toMatch(/mixed\s+text\/raster[\s\S]{0,180}(?:pages? after page 1|later raster pages?)/i);
    }

    expect(sourceManifest.long_description).toMatch(/does not currently bundle OCR/i);
    expect(sourceManifest.long_description).toMatch(/selected `read_pdf_content` extraction has no text[\s\S]{0,100}page 1/i);
    expect(sourceManifest.long_description).toMatch(/raster images, not OCR text/i);
    expect(sourceManifest.long_description).toMatch(/mixed text\/raster documents and raster pages after page 1/i);
    expect(packedManifest.long_description).toBe(sourceManifest.long_description);
  });

  it("does not promise zero egress for host or model content", async () => {
    const zeroEgressPatterns = [
      /nothing is uploaded/i,
      /all processing happens locally/i,
      /analy(?:ze|sis) document content locally/i,
      /(?:files|PDFs).{0,80}stay on (?:your|the user's) machine/i,
      /without (?:sending|uploading)(?: files| PDFs?)?(?: to a web app)?/i,
    ];
    const violations = [];

    for (const relativePath of CURRENT_PRODUCT_SURFACES) {
      const contents = await readRepositoryFile(relativePath);
      for (const pattern of zeroEgressPatterns) {
        for (const match of findMatches(contents, pattern)) {
          violations.push(`${relativePath}:${match}`);
        }
      }
    }

    const readme = await readRepositoryFile("README.md");
    const shareReadme = await readRepositoryFile("pdf-toolkit-mcp-share/README.md");
    const sourceManifest = JSON.parse(await readRepositoryFile("manifest.json"));
    expect(readme).toMatch(/complete workflow is not necessarily zero egress/i);
    expect(shareReadme).toMatch(/complete workflow is not necessarily[\s\n]+zero egress/i);
    expect(sourceManifest.long_description).toMatch(/returned through MCP may be processed under the selected host or model provider's data terms/i);
    expect(violations).toEqual([]);
  });
});
