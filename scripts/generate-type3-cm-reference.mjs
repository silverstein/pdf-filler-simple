#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber } from "pdf-lib";
import { uniqueComputerModernFamily } from "../server/layout-extraction.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TFM_ARCHIVE_URL = "https://mirrors.ctan.org/fonts/cm/tfm.zip";
const TYPE3_ARCHIVE_URL = "https://mirrors.ctan.org/fonts/cm/ps-type3.zip";
const MF_ARCHIVE_URL = "https://mirrors.ctan.org/fonts/cm/mf.zip";
const TFM_ARCHIVE_SHA256 = "9c0f99fa34c7d801c40f6b5ff60bc28f200e8ef6ffb2fe75e54ca835c67fc04c";
const TYPE3_ARCHIVE_SHA256 = "ef38efbd58774b454b190e17c8b5ca0fde13dd5d5ff2282bf0dc0313197f1033";
const MF_ARCHIVE_SHA256 = "b22c69034d9f3f7a9bf22673544bdeaace5656973cf7fb1a395a857148943076";
const OUTPUT_MODULE = path.join(REPO_ROOT, "server/type3-cm-reference.js");
const OUTPUT_SHARE_MODULE = path.join(REPO_ROOT, "pdf-toolkit-mcp-share/server/type3-cm-reference.js");
const OUTPUT_FIXTURE = path.join(REPO_ROOT, "test/fixtures/eval/extraction/type3-cm-reference.pdf");
const OUTPUT_PROVENANCE = path.join(REPO_ROOT, "test/fixtures/eval/extraction/type3-cm-reference.provenance.json");

const REVIEWED_SLOT_LABELS = {
  "computer-modern-math-italic": {
    1: "Delta", 11: "alpha", 14: "delta", 15: "epsilon", 17: "eta", 18: "theta",
    21: "lambda", 22: "mu", 23: "nu", 25: "pi", 26: "rho", 27: "sigma", 28: "tau",
    33: "omega", 39: "variant-phi", 58: "period", 59: "comma", 61: "slash",
  },
  "computer-modern-math-symbol": {
    0: "minus", 1: "centered-dot", 6: "plus-or-minus", 20: "less-or-equal",
    21: "greater-or-equal", 33: "right-arrow", 48: "prime", 106: "vertical", 112: "square-root",
  },
  "computer-modern-math-extension": {
    0: "big-left-parenthesis", 1: "big-right-parenthesis", 2: "big-left-bracket", 3: "big-right-bracket",
    16: "Big-left-parenthesis", 17: "Big-right-parenthesis", 18: "bigg-left-parenthesis", 19: "bigg-right-parenthesis",
    20: "bigg-left-bracket", 21: "bigg-right-bracket",
    82: "textstyle-integral", 90: "displaystyle-integral",
  },
};

/*
 * What the labeled fixture draws is an authoring choice; that each drawn font
 * resolves to a family is a measured fact, recomputed by measureFixture from
 * the emitted PDF rather than asserted here.
 *
 * The fonts stay byte-exact official CTAN ps-type3, because the fixture's
 * other job is to be real CharProc-digest evidence: a registry entry
 * qualified against it (`cmsy-ctan-type3-minus-v1`) only means something if
 * the same digest can appear in a real ps-type3 document. Rewriting /Widths
 * from the TFM would make every CharProc digest in this file correspond to a
 * font no producer emits.
 *
 * The cost of keeping the fonts exact is that ps-type3 /Widths are
 * pre-rounded to integer 1/1000 em, lossy against the TFM by up to three
 * units, while metricScaleInterval needs one scale to fit every observed code
 * within half a unit. That constraint is a conjunction, so a font cannot draw
 * all of its enrolled slots at once. Each set below is the unique
 * maximum-cardinality subset of the family's enrolled slots whose as-shipped
 * widths still admit a single scale, except cmsy10, which keeps the set the
 * previous revision drew so its already-qualified CharProc digests stay bound
 * to the same bytes. Enrolled slots outside these sets are recorded as
 * `fixture_undrawable_slots` rather than quietly dropped.
 */
const FIXTURE_FONTS = [
  {
    font: "cmmi10",
    family: "computer-modern-math-italic",
    codes: [11, 14, 15, 21, 22, 27, 33, 58, 59],
    size: 30,
  },
  {
    // Draw order, not sorted order: the previous revision drew these five in
    // this sequence, and holding the byte sequence keeps the text run that
    // qualifies `cmsy-ctan-type3-minus-v1` identical.
    font: "cmsy10",
    family: "computer-modern-math-symbol",
    codes: [0, 6, 33, 21, 112],
    size: 30,
  },
  {
    font: "cmex10",
    family: "computer-modern-math-extension",
    codes: [2, 3, 18, 19, 20, 21, 82],
    size: 20,
  },
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function download(url, destination) {
  execFileSync("curl", ["-L", "--fail", "--silent", "--show-error", url, "-o", destination]);
}

function requireDigest(filename, expected) {
  const actual = sha256(fs.readFileSync(filename));
  if (actual !== expected) throw new Error(`${path.basename(filename)} SHA-256 ${actual} != ${expected}`);
}

function unzip(archive, destination) {
  fs.mkdirSync(destination, { recursive: true });
  execFileSync("unzip", ["-q", archive, "-d", destination]);
}

function parseTfm(filename) {
  const bytes = fs.readFileSync(filename);
  const half = index => bytes.readUInt16BE(index * 2);
  const headerLength = half(1);
  const firstCharacter = half(2);
  const lastCharacter = half(3);
  const widthCount = half(4);
  if (firstCharacter > lastCharacter || lastCharacter > 255) throw new Error(`Unsupported TFM bounds: ${filename}`);
  let characterOffset = (6 + headerLength) * 4;
  const widthIndexes = [];
  for (let code = firstCharacter; code <= lastCharacter; code += 1, characterOffset += 4) {
    widthIndexes[code] = bytes[characterOffset];
  }
  const widthOffset = (6 + headerLength + (lastCharacter - firstCharacter + 1)) * 4;
  const widthTable = [];
  for (let index = 0; index < widthCount; index += 1) {
    widthTable[index] = bytes.readInt32BE(widthOffset + index * 4);
  }
  return Array.from({ length: 128 }, (_, code) => widthTable[widthIndexes[code] ?? 0] ?? 0);
}

function encodingFamily(filename) {
  if (/^(?:cmmi|cmmib)/u.test(filename)) return "computer-modern-math-italic";
  if (/^(?:cmsy|cmbsy)/u.test(filename)) return "computer-modern-math-symbol";
  if (/^cmex/u.test(filename)) return "computer-modern-math-extension";
  return `unsupported:${filename.replace(/\.tfm$/u, "")}`;
}

function requireSourceDefinitions(mfRoot) {
  const checks = [
    ["greekl.mf", /cmchar "Lowercase Greek alpha";\s*beginchar\(oct"013"/u],
    ["greekl.mf", /cmchar "Lowercase Greek pi";\s*beginchar\(oct"031"/u],
    ["greekl.mf", /cmchar "Lowercase Greek rho";\s*beginchar\(oct"032"/u],
    ["greekl.mf", /cmchar "Lowercase Greek omega";\s*beginchar\(oct"041"/u],
    ["romms.mf", /cmchar "Period";[\s\S]*?beginchar\(oct"072"/u],
    ["romms.mf", /cmchar "Comma";[\s\S]*?beginchar\(oct"073"/u],
    ["romms.mf", /cmchar "Virgule \(slash\)";\s*beginchar\(oct"075"/u],
    ["symbol.mf", /minus=oct"000"/u],
    ["sym.mf", /iff known minus: cmchar "Minus sign";\s*beginarithchar\(minus\)/u],
    ["symbol.mf", /plus_minus=oct"006"/u],
    ["sym.mf", /iff known plus_minus: cmchar "Plus-or-minus sign";\s*beginarithchar\(plus_minus\)/u],
    ["symbol.mf", /right_arrow=oct"041"/u],
    ["sym.mf", /iff known right_arrow: cmchar "Rightward arrow";[\s\S]*?beginchar\(right_arrow,/u],
    ["symbol.mf", /geq=oct"025"/u],
    ["sym.mf", /iff known geq: cmchar "Greater than or equal to sign";[\s\S]*?beginchar\(geq,/u],
    ["symbol.mf", /cmchar "Radical sign";\s*beginchar\(oct"160"/u],
    ["symbol.mf", /cdot=oct"001"/u],
    ["sym.mf", /iff known cdot: cmchar "Period raised to axis height";/u],
    ["symbol.mf", /leq=oct"024"/u],
    ["symbol.mf", /vertical=oct"152"/u],
    ["sym.mf", /iff known vertical: cmchar "Vertical line";/u],
    ["symbol.mf", /cmchar "Prime symbol \(intended as superscript only\)";\s*beginchar\(oct"060"/u],
    // Computer Modern math extension. Only self-contained delimiters and
    // operators are enrolled; the extensible top, bottom, and module pieces are
    // fragments of a built-up delimiter rather than characters, so they stay
    // unmapped and are reported instead of guessed.
    ["bigdel.mf", /cmchar "\\big left parenthesis";\s*beginchar\(oct"000"/u],
    ["bigdel.mf", /cmchar "\\big right parenthesis";\s*beginchar\(oct"001"/u],
    ["bigdel.mf", /cmchar "\\big left bracket";\s*beginchar\(oct"002"/u],
    ["bigdel.mf", /cmchar "\\big right bracket";\s*beginchar\(oct"003"/u],
    ["bigdel.mf", /cmchar "\\Big left parenthesis";\s*beginchar\(oct"020"/u],
    ["bigdel.mf", /cmchar "\\Big right parenthesis";\s*beginchar\(oct"021"/u],
    ["bigdel.mf", /cmchar "\\bigg left parenthesis";\s*beginchar\(oct"022"/u],
    ["bigdel.mf", /cmchar "\\bigg right parenthesis";\s*beginchar\(oct"023"/u],
    ["bigdel.mf", /cmchar "\\bigg left bracket";\s*beginchar\(oct"024"/u],
    ["bigdel.mf", /cmchar "\\bigg right bracket";\s*beginchar\(oct"025"/u],
    ["bigop.mf", /cmchar "\\textstyle integral sign";\s*beginchar\(oct"122"/u],
    ["bigop.mf", /cmchar "\\displaystyle integral sign";\s*beginchar\(oct"132"/u],
    // Computer Modern math italic letters and relations beyond the first batch.
    ["greeku.mf", /cmchar "Uppercase Greek Delta";\s*beginchar\(oct"001"/u],
    ["greekl.mf", /cmchar "Lowercase Greek delta";\s*beginchar\(oct"016"/u],
    ["greekl.mf", /cmchar "Lowercase Greek epsilon";\s*beginchar\(oct"017"/u],
    ["greekl.mf", /cmchar "Lowercase Greek eta";\s*beginchar\(oct"021"/u],
    ["greekl.mf", /cmchar "Lowercase Greek theta";\s*beginchar\(oct"022"/u],
    ["greekl.mf", /cmchar "Lowercase Greek lambda";\s*beginchar\(oct"025"/u],
    ["greekl.mf", /cmchar "Lowercase Greek mu";\s*beginchar\(oct"026"/u],
    ["greekl.mf", /cmchar "Lowercase Greek nu";\s*beginchar\(oct"027"/u],
    ["greekl.mf", /cmchar "Lowercase Greek sigma";\s*beginchar\(oct"033"/u],
    ["greekl.mf", /cmchar "Lowercase Greek tau";\s*beginchar\(oct"034"/u],
    ["greekl.mf", /cmchar "Variant lowercase Greek phi";\s*beginchar\(oct"047"/u],
  ];
  const sources = new Map();
  for (const [filename, pattern] of checks) {
    if (!sources.has(filename)) sources.set(filename, fs.readFileSync(path.join(mfRoot, filename), "utf8"));
    if (!pattern.test(sources.get(filename))) throw new Error(`Official Computer Modern definition check failed: ${filename}`);
  }
}

function generateMetricModule(tfmRoot, archiveSha256) {
  const entries = fs.readdirSync(tfmRoot)
    .filter(filename => filename.endsWith(".tfm"))
    .sort()
    .map(filename => ({
      family: encodingFamily(filename),
      name: filename.replace(/\.tfm$/u, ""),
      widths: parseTfm(path.join(tfmRoot, filename)),
    }));
  // Keep the shipped table compact. It is generated and reviewed through the
  // provenance record rather than hand-edited, so pretty-printing only adds
  // extension bytes without improving maintainability.
  const payload = JSON.stringify(entries);
  return `// Generated by scripts/generate-type3-cm-reference.mjs. Do not edit by hand.\n`
    + `// Official CTAN cm-tfm archive SHA-256: ${archiveSha256}\n\n`
    + `export const CM_TFM_REFERENCE_VERSION = "ctan-cm-tfm-${archiveSha256.slice(0, 12)}";\n\n`
    + `export const CM_TFM_METRICS = Object.freeze(${payload});\n\n`
    + `export const CM_CODEPOINTS = Object.freeze({\n`
    + `  "computer-modern-math-italic": Object.freeze({\n`
    + `    1: "Δ", 11: "α", 14: "δ", 15: "ϵ", 17: "η", 18: "θ", 21: "λ", 22: "μ", 23: "ν",\n`
    + `    25: "π", 26: "ρ", 27: "σ", 28: "τ", 33: "ω", 39: "φ",\n`
    + `    58: ".", 59: ",", 61: "/",\n`
    + `  }),\n`
    + `  "computer-modern-math-symbol": Object.freeze({\n`
    + `    0: "−", 1: "⋅", 6: "±", 20: "≤", 21: "≥", 33: "→", 48: "′", 106: "|", 112: "√",\n`
    + `  }),\n`
    + `  "computer-modern-math-extension": Object.freeze({\n`
    + `    0: "(", 1: ")", 2: "[", 3: "]",\n`
    + `    16: "(", 17: ")", 18: "(", 19: ")", 20: "[", 21: "]",\n`
    + `    82: "∫", 90: "∫",\n`
    + `  }),\n`
    + `});\n\n`
    + `export const CM_WITNESS_CODEPOINTS = Object.freeze({\n`
    + `  // Plus-or-minus and the rightward arrow were corroboration-only while no\n`
    + `  // reviewed raster backed them. Both are now enrolled above and stay usable\n`
    + `  // as witnesses from there, so nothing is witness-only today.\n`
    + `});\n`;
}

function hexByte(code) {
  return code.toString(16).toUpperCase().padStart(2, "0");
}

/**
 * Wraps a label into PostScript-safe lines. The caller only ever passes text
 * built from hexadecimal codes and reviewed slot labels, so any character
 * that would need PostScript string escaping means the label table drifted
 * and generation should stop rather than emit a malformed program.
 */
function labelLines(text, maxCharacters) {
  if (!/^[A-Za-z0-9 ,:-]+$/u.test(text)) throw new Error(`Label is not PostScript-safe: ${text}`);
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && `${line} ${word}`.length > maxCharacters) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function generateFixture(type3Root, output) {
  const rawOutput = `${output}.ghostscript-tmp`;
  const program = [
    "/Helvetica findfont 10 scalefont setfont",
    "72 748 moveto (Official CTAN Computer Modern Type3 labeled reference) show",
  ];
  let cursor = 730;
  for (const entry of FIXTURE_FONTS) {
    const label = `${entry.font}: ${entry.codes
      .map(code => `${hexByte(code)} ${REVIEWED_SLOT_LABELS[entry.family][code]}`)
      .join(", ")}`;
    program.push("/Helvetica findfont 10 scalefont setfont");
    for (const line of labelLines(label, 80)) {
      program.push(`72 ${cursor} moveto (${line}) show`);
      cursor -= 12;
    }
    cursor -= entry.size;
    program.push(`/${entry.font} findfont ${entry.size} scalefont setfont`);
    program.push(`72 ${cursor} moveto <${entry.codes.map(hexByte).join("")}> show`);
    cursor -= entry.size * 2;
  }
  program.push("showpage");
  execFileSync("gs", [
    "-q", "-dBATCH", "-dNOPAUSE", "-dOmitInfoDate=true", "-dOmitID=true",
    "-sDEVICE=pdfwrite", "-dEmbedAllFonts=true", "-dSubsetFonts=false",
    `-sOutputFile=${rawOutput}`,
    ...FIXTURE_FONTS.flatMap(entry => ["-f", path.join(type3Root, `${entry.font}.ps`)]),
    "-c", program.join(" "),
  ]);
  execFileSync("qpdf", [
    "--remove-info", "--remove-metadata", "--deterministic-id",
    rawOutput, output,
  ]);
  fs.rmSync(rawOutput, { force: true });
}

/**
 * Reads the Type-3 fonts back out of the artifact that was just written and
 * asks the shipped resolver what each one classifies as. Nothing here trusts
 * FIXTURE_FONTS beyond using it to name the fonts: the drawn codes come from
 * each font's CharProcs and the family comes from its emitted /Widths, so the
 * provenance records measurements of the file rather than restated intent.
 */
async function measureFixture(output) {
  const document = await PDFDocument.load(fs.readFileSync(output), { updateMetadata: false });
  const context = document.context;
  const measured = [];
  for (const [, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;
    const subtype = object.lookup(PDFName.of("Subtype"));
    if (!(subtype instanceof PDFName) || subtype.asString() !== "/Type3") continue;
    const charProcs = object.lookup(PDFName.of("CharProcs"));
    const widthsArray = object.lookup(PDFName.of("Widths"));
    const firstChar = object.lookup(PDFName.of("FirstChar"));
    if (!(charProcs instanceof PDFDict) || !(widthsArray instanceof PDFArray) || !(firstChar instanceof PDFNumber)) {
      throw new Error("Type-3 font is not readable");
    }
    const first = firstChar.asNumber();
    if (!Number.isSafeInteger(first)) throw new Error("Type-3 font has a non-integer FirstChar");
    const drawn = charProcs.keys()
      .map(key => Number(/^char(\d+)$/u.exec(key.asString().slice(1))?.[1]))
      .sort((left, right) => left - right);
    if (drawn.some(code => !Number.isSafeInteger(code))) throw new Error("Unexpected CharProcs glyph name");
    const widths = new Map();
    for (let index = 0; index < widthsArray.size(); index += 1) {
      const width = widthsArray.lookup(index, PDFNumber)?.asNumber();
      if (width > 0) widths.set(first + index, width);
    }
    measured.push({ drawn, family: uniqueComputerModernFamily(widths) });
  }
  const drawnSlots = {};
  const resolvingSlots = {};
  for (const entry of FIXTURE_FONTS) {
    const codes = [...entry.codes].sort((left, right) => left - right);
    const matches = measured.filter(font => font.drawn.join() === codes.join());
    if (matches.length !== 1) throw new Error(`${entry.font} did not emit exactly the declared glyph set`);
    drawnSlots[entry.family] = codes;
    if (matches[0].family === null) continue;
    if (matches[0].family !== entry.family) {
      throw new Error(`${entry.font} resolved to ${matches[0].family}, not ${entry.family}`);
    }
    resolvingSlots[entry.family] = codes;
  }
  if (measured.length !== FIXTURE_FONTS.length) throw new Error("Unexpected Type-3 font count in the fixture");
  return { drawnSlots, resolvingSlots };
}

const shippedMetricModule = fs.readFileSync(OUTPUT_MODULE, "utf8");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-tools-type3-cm-"));
try {
  const tfmArchive = path.join(temporaryRoot, "cm-tfm.zip");
  const type3Archive = path.join(temporaryRoot, "cm-type3.zip");
  const mfArchive = path.join(temporaryRoot, "cm-mf.zip");
  download(TFM_ARCHIVE_URL, tfmArchive);
  download(TYPE3_ARCHIVE_URL, type3Archive);
  download(MF_ARCHIVE_URL, mfArchive);
  requireDigest(tfmArchive, TFM_ARCHIVE_SHA256);
  requireDigest(type3Archive, TYPE3_ARCHIVE_SHA256);
  requireDigest(mfArchive, MF_ARCHIVE_SHA256);

  const tfmExtracted = path.join(temporaryRoot, "tfm");
  const type3Extracted = path.join(temporaryRoot, "type3");
  const mfExtracted = path.join(temporaryRoot, "mf");
  unzip(tfmArchive, tfmExtracted);
  unzip(type3Archive, type3Extracted);
  unzip(mfArchive, mfExtracted);
  requireSourceDefinitions(path.join(mfExtracted, "mf"));
  const metricModule = generateMetricModule(path.join(tfmExtracted, "tfm"), TFM_ARCHIVE_SHA256);
  fs.writeFileSync(OUTPUT_MODULE, metricModule);
  fs.writeFileSync(OUTPUT_SHARE_MODULE, metricModule);
  // measureFixture asks the shipped resolver to classify the fixture, and the
  // resolver reads the metric table that was already imported at startup. If
  // this run rewrote that table, the measurement would describe the previous
  // one, so stop with the new table written rather than record a stale answer.
  if (metricModule !== shippedMetricModule) {
    throw new Error(
      `Pinned Computer Modern metrics changed. ${path.relative(REPO_ROOT, OUTPUT_MODULE)} and its share copy`
      + " were rewritten; re-run so the fixture is measured against them.",
    );
  }
  generateFixture(path.join(type3Extracted, "ps-type3"), OUTPUT_FIXTURE);
  const { drawnSlots, resolvingSlots } = await measureFixture(OUTPUT_FIXTURE);

  const provenance = {
    schema_version: 1,
    generated_by: "scripts/generate-type3-cm-reference.mjs",
    sources: [
      { url: TFM_ARCHIVE_URL, sha256: TFM_ARCHIVE_SHA256 },
      { url: TYPE3_ARCHIVE_URL, sha256: TYPE3_ARCHIVE_SHA256 },
      { url: MF_ARCHIVE_URL, sha256: MF_ARCHIVE_SHA256 },
    ],
    generator: {
      ghostscript: execFileSync("gs", ["--version"], { encoding: "utf8" }).trim(),
      qpdf: execFileSync("qpdf", ["--version"], { encoding: "utf8" }).trim(),
    },
    outputs: {
      "server/type3-cm-reference.js": sha256(fs.readFileSync(OUTPUT_MODULE)),
      "pdf-toolkit-mcp-share/server/type3-cm-reference.js": sha256(fs.readFileSync(OUTPUT_SHARE_MODULE)),
      "test/fixtures/eval/extraction/type3-cm-reference.pdf": sha256(fs.readFileSync(OUTPUT_FIXTURE)),
    },
    // Drawn is still recorded separately from resolved, because the two are
    // different claims and only the second is evidence. Both are now read back
    // out of the emitted PDF by measureFixture rather than restated by hand,
    // so a font that stopped classifying would drop out of the second field
    // instead of being papered over. They are equal as of this revision, and
    // test/type3-glyph-inventory.test.js re-measures that independently.
    fixture_drawn_slots: drawnSlots,
    fixture_family_resolving_slots: resolvingSlots,
    // Enrolled slots the labeled reference cannot draw. CTAN ps-type3 /Widths
    // are pre-rounded to integer 1/1000 em, lossy against the TFM by up to
    // three units, and metricScaleInterval needs one scale to fit every
    // observed code within half a unit, so adding any of these to its font
    // empties the feasible interval and costs the whole font its family. They
    // are recorded here so the drawn set is not mistaken for the enrolled set.
    fixture_undrawable_slots: Object.fromEntries(FIXTURE_FONTS.map(entry => [
      entry.family,
      Object.keys(REVIEWED_SLOT_LABELS[entry.family])
        .map(Number)
        .filter(code => !entry.codes.includes(code))
        .sort((left, right) => left - right),
    ])),
    reviewed_slot_labels: REVIEWED_SLOT_LABELS,
  };
  fs.writeFileSync(OUTPUT_PROVENANCE, `${JSON.stringify(provenance, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(provenance, null, 2)}\n`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
