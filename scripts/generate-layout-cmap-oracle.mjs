import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIRECTORY = path.join(REPO_ROOT, "test", "fixtures", "eval", "extraction", "oracles");
const FIXTURE_NAME = "layout-unijis-vertical.pdf";
const PROVENANCE_NAME = "layout-unijis-vertical.provenance.json";
const EXACT_TEXT = "日本語";
const RUNTIME_ASSETS = Object.freeze([
  "node_modules/pdfjs-dist/cmaps/UniJIS-UTF16-V.bcmap",
  "node_modules/pdfjs-dist/cmaps/UniJIS-UTF16-H.bcmap",
  "node_modules/pdfjs-dist/cmaps/Adobe-Japan1-UCS2.bcmap",
  "node_modules/pdfjs-dist/cmaps/LICENSE",
  "node_modules/pdfjs-dist/LICENSE",
  "node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf",
  "node_modules/pdfjs-dist/standard_fonts/LICENSE_FOXIT",
  "node_modules/pdfjs-dist/standard_fonts/LICENSE_LIBERATION",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalLfSha256(bytes) {
  const canonical = Buffer.from(bytes).toString("utf8").replace(/\r\n?/g, "\n");
  return sha256(Buffer.from(canonical, "utf8"));
}

function posixRelative(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

function utf16beHex(value) {
  return [...value]
    .map(character => character.codePointAt(0))
    .map(codePoint => {
      if (codePoint > 0xffff) throw new Error("The minimal oracle intentionally supports BMP code points only.");
      return codePoint.toString(16).padStart(4, "0");
    })
    .join("")
    .toUpperCase();
}

function stream(dictionary, value) {
  const bytes = Buffer.from(value, "binary");
  return `<< ${dictionary} /Length ${bytes.length} >>\nstream\n${value}\nendstream`;
}

function serializePdf(objects) {
  const chunks = [Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "binary")];
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.concat(chunks).length);
    chunks.push(Buffer.from(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`, "binary"));
  }
  const xrefOffset = Buffer.concat(chunks).length;
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    "0000000000 65535 f \n",
    ...offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 8 0 R >>\n`,
    `startxref\n${xrefOffset}\n%%EOF\n`,
  ].join("");
  return Buffer.concat([...chunks, Buffer.from(xref, "binary")]);
}

export function generateLayoutCMapOracle() {
  const content = [
    "BT",
    "/F0 24 Tf",
    "1 0 0 1 150 340 Tm",
    `<${utf16beHex(EXACT_TEXT)}> Tj`,
    "ET",
  ].join("\n");
  return serializePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F0 5 0 R >> >> /Contents 4 0 R >>",
    stream("", content),
    "<< /Type /Font /Subtype /Type0 /BaseFont /ODAOracleMincho /Encoding /UniJIS-UTF16-V /DescendantFonts [6 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /ODAOracleMincho /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 7 >> /FontDescriptor 7 0 R /DW 1000 /DW2 [880 -1000] >>",
    "<< /Type /FontDescriptor /FontName /ODAOracleMincho /Flags 4 /FontBBox [0 -1000 1000 1000] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 >>",
    "<< /Title (ODA deterministic UniJIS vertical extraction oracle) /Author (Open Document Alliance) /Creator (scripts/generate-layout-cmap-oracle.mjs) /Producer (Open Document Alliance minimal PDF writer) /Subject (Synthetic text-only test fixture; no personal data or embedded font program) /CreationDate (D:20260722000000Z) /ModDate (D:20260722000000Z) >>",
  ]);
}

export function validateMinimalPdfStructure(bytes) {
  const source = Buffer.from(bytes).toString("binary");
  if (!source.startsWith("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n")) throw new Error("Invalid deterministic PDF header.");
  const startxrefMatch = /startxref\n(\d+)\n%%EOF\n$/.exec(source);
  if (!startxrefMatch) throw new Error("Missing terminal startxref.");
  const xrefOffset = Number(startxrefMatch[1]);
  const xrefSource = source.slice(xrefOffset);
  if (!xrefSource.startsWith("xref\n")) throw new Error("startxref does not address xref.");
  const xrefLines = xrefSource.split("\n");
  if (xrefLines[0] !== "xref" || xrefLines[1] !== "0 9") throw new Error("xref must contain exactly the canonical 0 9 subsection.");
  const trailerIndex = xrefLines.indexOf("trailer");
  if (trailerIndex !== 11) throw new Error("xref must contain exactly nine fixed-format entries.");
  const entries = xrefLines.slice(2, trailerIndex);
  if (entries[0] !== "0000000000 65535 f ") throw new Error("xref object 0 must use the canonical free entry.");
  for (let objectNumber = 1; objectNumber <= 8; objectNumber += 1) {
    if (!/^\d{10} 00000 n $/.test(entries[objectNumber] ?? "")) {
      throw new Error(`xref object ${objectNumber} must use a fixed-format generation-0 in-use entry.`);
    }
  }
  if (xrefLines[trailerIndex + 1] !== "<< /Size 9 /Root 1 0 R /Info 8 0 R >>") {
    throw new Error("trailer must declare exactly /Size 9 /Root 1 0 R /Info 8 0 R.");
  }
  if (xrefLines[trailerIndex + 2] !== "startxref"
    || xrefLines[trailerIndex + 3] !== String(xrefOffset)
    || xrefLines[trailerIndex + 4] !== "%%EOF"
    || xrefLines[trailerIndex + 5] !== ""
    || xrefLines.length !== trailerIndex + 6) {
    throw new Error("xref trailer termination is not canonical.");
  }
  const objectMatches = [...source.slice(0, xrefOffset).matchAll(/(?:^|\n)(\d+) (\d+) obj\n/g)];
  if (objectMatches.length !== 8) throw new Error("Unexpected indirect object count.");
  for (let index = 0; index < objectMatches.length; index += 1) {
    const match = objectMatches[index];
    const objectNumber = Number(match[1]);
    const generation = Number(match[2]);
    if (objectNumber !== index + 1 || generation !== 0) {
      throw new Error(`Indirect object ${index + 1} must be numbered ${index + 1} with generation 0.`);
    }
    const recordedOffset = Number(entries[objectNumber].slice(0, 10));
    const actualOffset = match.index + (source[match.index] === "\n" ? 1 : 0);
    if (recordedOffset !== actualOffset) throw new Error(`xref mismatch for object ${objectNumber}.`);
  }
  const requiredFragments = [
    "/Subtype /Type0",
    "/Encoding /UniJIS-UTF16-V",
    "/Subtype /CIDFontType0",
    "/Registry (Adobe)",
    "/Ordering (Japan1)",
    `<${utf16beHex(EXACT_TEXT)}> Tj`,
  ];
  for (const fragment of requiredFragments) {
    if (!source.includes(fragment)) throw new Error(`Missing required PDF structure: ${fragment}`);
  }
  if (/\/FontFile(?:2|3)?\b/.test(source)) throw new Error("The ODA oracle must not embed font bytes.");
  if (/\/ToUnicode\b/.test(source)) throw new Error("The causal CMap oracle must not embed a ToUnicode override.");
  return {
    object_count: objectMatches.length,
    object_numbers: objectMatches.map(match => Number(match[1])),
    xref_offset: xrefOffset,
    xref_subsection: "0 9",
    xref_entry_count: entries.length,
    trailer: { size: 9, root: "1 0 R", info: "8 0 R" },
    named_encoding: "UniJIS-UTF16-V",
    embedded_font_programs: 0,
    embedded_to_unicode_maps: 0,
  };
}

async function main() {
  const fixture = generateLayoutCMapOracle();
  const structure = validateMinimalPdfStructure(fixture);
  const generatorPath = fileURLToPath(import.meta.url);
  const generator = await fs.readFile(generatorPath);
  const pdfjsPackage = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "node_modules", "pdfjs-dist", "package.json"), "utf8"));
  if (pdfjsPackage.version !== "5.4.624") throw new Error(`Expected pdfjs-dist 5.4.624, found ${pdfjsPackage.version}.`);
  const runtimeAssets = await Promise.all(RUNTIME_ASSETS.map(async assetPath => {
    const bytes = await fs.readFile(path.join(REPO_ROOT, assetPath));
    return { path: assetPath, sha256: sha256(bytes), size_bytes: bytes.length };
  }));
  const fixturePath = path.join(OUTPUT_DIRECTORY, FIXTURE_NAME);
  const provenancePath = path.join(OUTPUT_DIRECTORY, PROVENANCE_NAME);
  const provenance = {
    schema_version: 1,
    fixture_id: "pdf-tools.oracle.layout-unijis-vertical.v1",
    ownership: "Open Document Alliance generated synthetic fixture",
    license: "CC0-1.0",
    privacy: "Synthetic text-only fixture; no personal data",
    redistribution: "allowed",
    generator: {
      path: posixRelative(REPO_ROOT, generatorPath),
      sha256: canonicalLfSha256(generator),
      hash_contract: "SHA-256 of UTF-8 generator source after CRLF or CR line endings are normalized to LF",
      runtime: "Node.js standard library only",
      command: "node scripts/generate-layout-cmap-oracle.mjs",
    },
    fixture: {
      path: posixRelative(REPO_ROOT, fixturePath),
      sha256: sha256(fixture),
      size_bytes: fixture.length,
    },
    oracle: {
      exact_unicode_text: EXACT_TEXT,
      named_encoding: "UniJIS-UTF16-V",
      descendant_collection: "Adobe-Japan1-7",
      requires_packaged_cmaps: ["UniJIS-UTF16-V.bcmap", "UniJIS-UTF16-H.bcmap", "Adobe-Japan1-UCS2.bcmap"],
      geometry_claim: "PDF.js 5.4.624 TextItem vertical advance-box approximation only; not glyph ink bounds or rendered-visibility proof",
    },
    runtime_assets: {
      pdfjs_dist_version: pdfjsPackage.version,
      files: runtimeAssets,
      license_note: "The named CMaps and their terms are retained from pdfjs-dist; Foxit and Liberation notices are retained for the packaged PDF.js standard-font assets even though this fixture embeds no font program.",
    },
    font_program: {
      embedded: false,
      bytes: 0,
      note: "The synthetic PDF contains only an ODA-authored font dictionary and references named Adobe CMaps shipped under pdfjs-dist/cmaps/LICENSE.",
    },
    independent_structure_check: structure,
  };
  await fs.mkdir(OUTPUT_DIRECTORY, { recursive: true });
  await fs.writeFile(fixturePath, fixture);
  await fs.writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  process.stdout.write(`${posixRelative(REPO_ROOT, fixturePath)} sha256=${provenance.fixture.sha256}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
