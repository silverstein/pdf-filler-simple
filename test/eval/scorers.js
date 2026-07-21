import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PDFDocument } from "pdf-lib";

const SCORER_VERSION = 1;
const require = createRequire(import.meta.url);
let pdfjs;

function check(id, passed, expected, actual) {
  return { id, passed, expected, actual };
}

function result(graderId, checks) {
  const passed = checks.every(item => item.passed);
  return {
    grader_id: graderId,
    grader_version: SCORER_VERSION,
    passed,
    score: checks.length === 0 ? 1 : checks.filter(item => item.passed).length / checks.length,
    checks,
  };
}

function withinTolerance(actual, expected, tolerance) {
  return Math.abs(actual - expected) <= tolerance;
}

function normalizeRotation(value) {
  return ((value % 360) + 360) % 360;
}

async function loadPdf(candidatePath) {
  const bytes = await fs.readFile(candidatePath);
  const document = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return { bytes, document };
}

async function loadPdfjs() {
  if (pdfjs) return pdfjs;
  pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const packageDirectory = path.dirname(require.resolve("pdfjs-dist/package.json"));
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    path.join(packageDirectory, "legacy", "build", "pdf.worker.mjs")
  ).href;
  return pdfjs;
}

export async function scoreDocumentStructure(candidatePath, expected) {
  const checks = [];
  let loaded;
  try {
    loaded = await loadPdf(candidatePath);
    checks.push(check("parseable_pdf", true, true, true));
  } catch (error) {
    checks.push(check("parseable_pdf", false, true, error.message));
    return result("pdf_document_structure", checks);
  }

  const { bytes, document } = loaded;
  checks.push(check("non_empty_file", bytes.length > 0, "> 0 bytes", bytes.length));
  if (Number.isInteger(expected.page_count)) {
    checks.push(check(
      "page_count",
      document.getPageCount() === expected.page_count,
      expected.page_count,
      document.getPageCount()
    ));
  }
  if (Number.isInteger(expected.form_field_count)) {
    let fieldCount;
    try {
      fieldCount = document.getForm().getFields().length;
    } catch {
      fieldCount = 0;
    }
    checks.push(check(
      "form_field_count",
      fieldCount === expected.form_field_count,
      expected.form_field_count,
      fieldCount
    ));
  }
  return result("pdf_document_structure", checks);
}

function scoreBox(checks, pageNumber, name, actual, expected, tolerance) {
  for (const coordinate of ["x", "y", "width", "height"]) {
    if (typeof expected[coordinate] !== "number") continue;
    checks.push(check(
      `page_${pageNumber}_${name}_${coordinate}`,
      withinTolerance(actual[coordinate], expected[coordinate], tolerance),
      expected[coordinate],
      actual[coordinate]
    ));
  }
}

export async function scorePageGeometry(candidatePath, expected) {
  const checks = [];
  let document;
  try {
    ({ document } = await loadPdf(candidatePath));
    checks.push(check("parseable_pdf", true, true, true));
  } catch (error) {
    checks.push(check("parseable_pdf", false, true, error.message));
    return result("pdf_page_geometry", checks);
  }

  const tolerance = expected.tolerance_points ?? 0.01;
  const pages = document.getPages();
  for (const pageExpectation of expected.pages ?? []) {
    const pageNumber = pageExpectation.page;
    const page = pages[pageNumber - 1];
    checks.push(check(
      `page_${pageNumber}_exists`,
      Boolean(page),
      true,
      Boolean(page)
    ));
    if (!page) continue;
    if (typeof pageExpectation.rotation === "number") {
      const actualRotation = normalizeRotation(page.getRotation().angle);
      const expectedRotation = normalizeRotation(pageExpectation.rotation);
      checks.push(check(
        `page_${pageNumber}_rotation`,
        actualRotation === expectedRotation,
        expectedRotation,
        actualRotation
      ));
    }
    if (pageExpectation.media_box) {
      scoreBox(checks, pageNumber, "media_box", page.getMediaBox(), pageExpectation.media_box, tolerance);
    }
    if (pageExpectation.crop_box) {
      scoreBox(checks, pageNumber, "crop_box", page.getCropBox(), pageExpectation.crop_box, tolerance);
    }
  }
  return result("pdf_page_geometry", checks);
}

function normalizeText(value) {
  return value.replace(/\s+/g, " ").trim();
}

export async function scoreTextExtraction(candidatePath, expected) {
  const checks = [];
  let loadingTask;
  let document;
  try {
    const library = await loadPdfjs();
    const packageDirectory = path.dirname(require.resolve("pdfjs-dist/package.json"));
    loadingTask = library.getDocument({
      data: new Uint8Array(await fs.readFile(candidatePath)),
      isEvalSupported: false,
      standardFontDataUrl: `${path.join(packageDirectory, "standard_fonts")}${path.sep}`,
      useWorkerFetch: false,
    });
    document = await loadingTask.promise;
    checks.push(check("independent_parser_load", true, true, true));
  } catch (error) {
    checks.push(check("independent_parser_load", false, true, error.message));
    await loadingTask?.destroy();
    return result("pdf_text_extraction", checks);
  }

  try {
    for (const pageExpectation of expected.pages ?? []) {
      const page = await document.getPage(pageExpectation.page);
      const content = await page.getTextContent();
      const actual = normalizeText(content.items.map(item => item.str).join(" "));
      for (const requiredText of pageExpectation.required_text ?? []) {
        checks.push(check(
          `page_${pageExpectation.page}_contains_${requiredText}`,
          actual.includes(normalizeText(requiredText)),
          requiredText,
          actual
        ));
      }
    }
  } finally {
    await document.destroy();
  }
  return result("pdf_text_extraction", checks);
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function walkFiles(root, current = root) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(root, absolute));
    } else if (entry.isFile()) {
      const bytes = await fs.readFile(absolute);
      files.push([
        path.relative(root, absolute).split(path.sep).join("/"),
        { sha256: hashBytes(bytes), size: bytes.length },
      ]);
    }
  }
  return files;
}

export async function snapshotFilesystem(root) {
  return Object.fromEntries(await walkFiles(path.resolve(root)));
}

export function scoreFileSideEffects(before, after, expected) {
  const checks = [];
  const beforePaths = new Set(Object.keys(before));
  const afterPaths = new Set(Object.keys(after));
  const created = [...afterPaths].filter(file => !beforePaths.has(file)).sort();
  const deleted = [...beforePaths].filter(file => !afterPaths.has(file)).sort();
  const modified = [...afterPaths]
    .filter(file => beforePaths.has(file) && before[file].sha256 !== after[file].sha256)
    .sort();
  const expectedCreated = [...(expected.created ?? [])].sort();
  const expectedDeleted = [...(expected.deleted ?? [])].sort();
  const expectedModified = [...(expected.modified ?? [])].sort();

  checks.push(check(
    "created_files",
    JSON.stringify(created) === JSON.stringify(expectedCreated),
    expectedCreated,
    created
  ));
  checks.push(check(
    "deleted_files",
    JSON.stringify(deleted) === JSON.stringify(expectedDeleted),
    expectedDeleted,
    deleted
  ));
  checks.push(check(
    "modified_files",
    JSON.stringify(modified) === JSON.stringify(expectedModified),
    expectedModified,
    modified
  ));
  for (const unchangedPath of expected.unchanged ?? []) {
    const unchanged = before[unchangedPath] && after[unchangedPath]
      && before[unchangedPath].sha256 === after[unchangedPath].sha256;
    checks.push(check(
      `unchanged_${unchangedPath}`,
      Boolean(unchanged),
      before[unchangedPath]?.sha256 ?? "present before and after",
      after[unchangedPath]?.sha256 ?? "missing"
    ));
  }
  return result("filesystem_side_effects", checks);
}

export async function scorePdfFixture(candidatePath, expected) {
  const results = [];
  if (expected.document) {
    results.push(await scoreDocumentStructure(candidatePath, expected.document));
  }
  if (expected.geometry) {
    results.push(await scorePageGeometry(candidatePath, expected.geometry));
  }
  if (expected.extraction) {
    results.push(await scoreTextExtraction(candidatePath, expected.extraction));
  }
  return {
    passed: results.every(item => item.passed),
    scorers: results,
  };
}
