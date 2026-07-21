#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFString,
  StandardFonts,
} from "pdf-lib";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_DIR = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "accessibility",
  "synthetic"
);
const FIXED_DATE = new Date("2026-07-21T00:00:00.000Z");

function configureMetadata(pdf, title) {
  pdf.setTitle(title);
  pdf.setAuthor("Open Document Alliance PDF Tools maintainers");
  pdf.setSubject("Synthetic accessibility screening fixture; contains no personal data");
  pdf.setCreator("scripts/eval-generate-accessibility-fixtures.mjs");
  pdf.setProducer("pdf-lib 1.17.1");
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);
}

async function createBase(title, visibleText) {
  const pdf = await PDFDocument.create();
  configureMetadata(pdf, title);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([420, 594]);
  page.drawText(visibleText, { x: 42, y: 520, size: 16, font });
  page.drawText("This file is synthetic and is not claimed to conform to PDF/UA.", {
    x: 42,
    y: 486,
    size: 10,
    font,
  });
  return pdf;
}

function addPdfUaIdentification(pdf, part = 1) {
  const xmp = `<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/">
      <pdfuaid:part>${part}</pdfuaid:part>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
  const stream = pdf.context.stream(new TextEncoder().encode(xmp), {
    Type: "Metadata",
    Subtype: "XML",
  });
  pdf.catalog.set(PDFName.of("Metadata"), pdf.context.register(stream));
}

function addCatalogSignals(pdf, { completeShape }) {
  const markInfo = pdf.context.obj({ Marked: true });
  pdf.catalog.set(PDFName.of("MarkInfo"), markInfo);
  pdf.catalog.set(PDFName.of("Lang"), PDFString.of("en-US"));
  pdf.catalog.set(
    PDFName.of("ViewerPreferences"),
    pdf.context.obj({ DisplayDocTitle: true })
  );

  const structure = { Type: "StructTreeRoot", K: [] };
  if (completeShape) {
    structure.ParentTree = pdf.context.register(pdf.context.obj({ Nums: [] }));
    pdf.getPages()[0].node.set(PDFName.of("StructParents"), PDFNumber.of(0));
  }
  pdf.catalog.set(
    PDFName.of("StructTreeRoot"),
    pdf.context.register(pdf.context.obj(structure))
  );
}

async function createUntagged() {
  return createBase(
    "Untagged accessibility screen failure",
    "UNTAGGED STRUCTURAL SCREEN FAILURE"
  );
}

async function createClaimOnly() {
  const pdf = await createBase(
    "Claim-only PDF/UA adversarial fixture",
    "PDF/UA IDENTIFIER IS NOT PROOF"
  );
  addCatalogSignals(pdf, { completeShape: false });
  addPdfUaIdentification(pdf, 1);
  return pdf;
}

async function createScreenPassNotConformance() {
  const pdf = await createBase(
    "Structural screen pass that is not conformance",
    "SUPERFICIAL SIGNALS CANNOT ESTABLISH CONFORMANCE"
  );
  addCatalogSignals(pdf, { completeShape: true });
  addPdfUaIdentification(pdf, 1);
  return pdf;
}

export async function generateAccessibilityFixtures(outputDir = DEFAULT_OUTPUT_DIR) {
  await fs.mkdir(outputDir, { recursive: true });
  const documents = new Map([
    ["untagged.pdf", await createUntagged()],
    ["claim-only.pdf", await createClaimOnly()],
    ["screen-pass-not-conformance.pdf", await createScreenPassNotConformance()],
  ]);

  for (const [filename, document] of documents) {
    const bytes = await document.save({ useObjectStreams: false });
    await fs.writeFile(path.join(outputDir, filename), bytes);
  }
  return [...documents.keys()];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputFlag = process.argv.indexOf("--output-dir");
  const outputDir = outputFlag >= 0
    ? path.resolve(process.argv[outputFlag + 1])
    : DEFAULT_OUTPUT_DIR;
  const generated = await generateAccessibilityFixtures(outputDir);
  process.stdout.write(`${generated.map(name => path.join(outputDir, name)).join("\n")}\n`);
}
