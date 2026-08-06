#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    ["romms.mf", /cmchar "Less than sign";[\s\S]*?beginchar\("<"/u],
    ["romms.mf", /cmchar "Greater than sign";[\s\S]*?beginchar\(">"/u],
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
    + `    58: ".", 59: ",", 60: "<", 61: "/", 62: ">",\n`
    + `  }),\n`
    + `  "computer-modern-math-symbol": Object.freeze({ 0: "−", 1: "·", 20: "≤", 21: "≥", 48: "′", 106: "|", 112: "√" }),\n`
    + `  "computer-modern-math-extension": Object.freeze({\n`
    + `    0: "(", 1: ")", 2: "[", 3: "]",\n`
    + `    16: "(", 17: ")", 18: "(", 19: ")", 20: "[", 21: "]",\n`
    + `    82: "∫", 90: "∫",\n`
    + `  }),\n`
    + `});\n\n`
    + `export const CM_WITNESS_CODEPOINTS = Object.freeze({\n`
    + `  "computer-modern-math-symbol": Object.freeze({ 6: "±", 33: "→" }),\n`
    + `});\n`;
}

function generateFixture(type3Root, output) {
  const rawOutput = `${output}.ghostscript-tmp`;
  const program = [
    "/Helvetica findfont 10 scalefont setfont",
    "72 748 moveto (Official CTAN Computer Modern Type3 labeled reference) show",
    "72 730 moveto (cmmi10: 0B alpha, 19 pi, 1A rho, 21 omega, 3A period, 3B comma, 3D slash) show",
    "/cmmi10 findfont 30 scalefont setfont 72 680 moveto <0B191A213A3B3D> show",
    "/Helvetica findfont 10 scalefont setfont",
    "72 630 moveto (cmsy10: 00 minus, 06 plus-or-minus witness, 21 right-arrow witness, 15 greater-or-equal, 70 square-root) show",
    "/cmsy10 findfont 30 scalefont setfont 72 580 moveto <0006211570> show",
    "showpage",
  ].join(" ");
  execFileSync("gs", [
    "-q", "-dBATCH", "-dNOPAUSE", "-dOmitInfoDate=true", "-dOmitID=true",
    "-sDEVICE=pdfwrite", "-dEmbedAllFonts=true", "-dSubsetFonts=false",
    `-sOutputFile=${rawOutput}`,
    "-f", path.join(type3Root, "cmmi10.ps"),
    "-f", path.join(type3Root, "cmsy10.ps"),
    "-c", program,
  ]);
  execFileSync("qpdf", [
    "--remove-info", "--remove-metadata", "--deterministic-id",
    rawOutput, output,
  ]);
  fs.rmSync(rawOutput, { force: true });
}

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
  generateFixture(path.join(type3Extracted, "ps-type3"), OUTPUT_FIXTURE);

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
    visual_labels: {
      "computer-modern-math-italic": {
        1: "Delta", 11: "alpha", 14: "delta", 15: "epsilon", 17: "eta", 18: "theta",
        21: "lambda", 22: "mu", 23: "nu", 25: "pi", 26: "rho", 27: "sigma", 28: "tau",
        33: "omega", 39: "variant-phi", 58: "period", 59: "comma", 60: "less", 61: "slash", 62: "greater",
      },
      "computer-modern-math-symbol": {
        0: "minus", 1: "centered-dot", 6: "plus-or-minus-witness", 20: "less-or-equal",
        21: "greater-or-equal", 33: "right-arrow-witness", 48: "prime", 106: "vertical", 112: "square-root",
      },
      "computer-modern-math-extension": {
        0: "big-left-parenthesis", 1: "big-right-parenthesis", 2: "big-left-bracket", 3: "big-right-bracket",
        16: "Big-left-parenthesis", 17: "Big-right-parenthesis", 18: "bigg-left-parenthesis", 19: "bigg-right-parenthesis",
        20: "bigg-left-bracket", 21: "bigg-right-bracket",
        82: "textstyle-integral", 90: "displaystyle-integral",
      },
    },
  };
  fs.writeFileSync(OUTPUT_PROVENANCE, `${JSON.stringify(provenance, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(provenance, null, 2)}\n`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
