import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

const SHA256 = /^[a-f0-9]{64}$/;
const REQUIRED_CATEGORIES = [
  "flat_schema",
  "nested_schema",
  "layout_order",
  "table",
  "ocr_clean",
  "ocr_degraded",
  "mixed_modality",
  "no_answer_contradiction",
];
const REQUIRED_PARTITIONS = ["development", "held_out_calibration"];

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function resolveJsonPointer(value, pointer) {
  if (pointer === "/") return { found: true, value };
  let current = value;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current === null || current === undefined || !Object.hasOwn(current, key)) {
      return { found: false, value: undefined };
    }
    current = current[key];
  }
  return { found: true, value: current };
}

function boxWithinPage(box, geometry) {
  const page = geometry.media_box;
  return box.x >= page.x
    && box.y >= page.y
    && box.x + box.width <= page.x + page.width
    && box.y + box.height <= page.y + page.height;
}

function assertExactSet(actualValues, expectedValues, label) {
  const actual = [...new Set(actualValues)].sort();
  const expected = [...expectedValues].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`Extraction manifest must contain exactly the required ${label}: ${expected.join(", ")}`);
  }
}

export async function loadExtractionManifest(manifestPath, schemaPath) {
  const [manifestText, schemaText] = await Promise.all([
    fs.readFile(manifestPath, "utf8"),
    fs.readFile(schemaPath, "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  const schema = JSON.parse(schemaText);
  const validation = new AjvJsonSchemaValidator().getValidator(schema)(manifest);
  if (!validation.valid) throw new Error(`Invalid extraction manifest: ${validation.errorMessage}`);

  const ids = new Set();
  const factIds = new Set();
  assertExactSet(manifest.fixtures.map(fixture => fixture.category), REQUIRED_CATEGORIES, "categories");
  if (new Set(manifest.fixtures.map(fixture => fixture.category)).size !== manifest.fixtures.length) {
    throw new Error("Extraction manifest categories must be unique");
  }
  assertExactSet(manifest.fixtures.map(fixture => fixture.partition), REQUIRED_PARTITIONS, "partitions");
  for (const fixture of manifest.fixtures) {
    if (ids.has(fixture.id)) throw new Error(`Duplicate extraction fixture ID: ${fixture.id}`);
    ids.add(fixture.id);
    const fixturePath = resolveExtractionFixture(manifestPath, fixture);
    const digest = sha256(await fs.readFile(fixturePath));
    if (!SHA256.test(fixture.sha256) || digest !== fixture.sha256) {
      throw new Error(`Extraction fixture hash mismatch for ${fixture.id}`);
    }
    const targetValidation = new AjvJsonSchemaValidator().getValidator(fixture.target_schema)(fixture.ground_truth);
    if (!targetValidation.valid) {
      throw new Error(`Ground truth violates target schema for ${fixture.id}: ${targetValidation.errorMessage}`);
    }

    const pages = new Map();
    for (const page of fixture.expected.pages) {
      if (pages.has(page.page)) throw new Error(`Duplicate expected page ${page.page} for ${fixture.id}`);
      pages.set(page.page, page);
    }
    const geometry = new Map();
    for (const page of fixture.expected.page_geometry) {
      if (geometry.has(page.page)) throw new Error(`Duplicate page geometry ${page.page} for ${fixture.id}`);
      geometry.set(page.page, page);
    }
    if (canonicalJson([...pages.keys()].sort((a, b) => a - b)) !== canonicalJson([...geometry.keys()].sort((a, b) => a - b))) {
      throw new Error(`Expected pages and page geometry differ for ${fixture.id}`);
    }
    if (fixture.expected.table && (!pages.has(fixture.expected.table.page) || !geometry.has(fixture.expected.table.page))) {
      throw new Error(`Table references missing page or geometry for ${fixture.id}`);
    }
    if (fixture.expected.answer_state === "contradictory_and_absent"
      && fixture.ground_truth.answer_state !== "contradictory_and_absent") {
      throw new Error(`Contradictory answer state is inconsistent with ground truth for ${fixture.id}`);
    }
    if (fixture.expected.answer_state === "answerable"
      && fixture.ground_truth.answer_state === "contradictory_and_absent") {
      throw new Error(`Answerable state is inconsistent with ground truth for ${fixture.id}`);
    }
    if (fixture.expected.table) {
      const table = fixture.expected.table;
      const coordinates = new Set();
      for (const cell of table.cells) {
        if (cell.row > table.row_count || cell.column > table.column_count) {
          throw new Error(`Table cell is outside declared bounds for ${fixture.id}: R${cell.row}C${cell.column}`);
        }
        const coordinate = `${cell.row}:${cell.column}`;
        if (coordinates.has(coordinate)) throw new Error(`Duplicate table cell coordinate for ${fixture.id}: R${cell.row}C${cell.column}`);
        coordinates.add(coordinate);
      }
      const mergedRanges = new Set();
      for (const range of table.merged_cells) {
        const match = /^R([1-9][0-9]*)C([1-9][0-9]*):R([1-9][0-9]*)C([1-9][0-9]*)$/.exec(range);
        if (!match) throw new Error(`Malformed merged cell range for ${fixture.id}: ${range}`);
        const [, startRowText, startColumnText, endRowText, endColumnText] = match;
        const [startRow, startColumn, endRow, endColumn] = [startRowText, startColumnText, endRowText, endColumnText].map(Number);
        if (startRow > endRow || startColumn > endColumn
          || endRow > table.row_count || endColumn > table.column_count
          || (startRow === endRow && startColumn === endColumn)) {
          throw new Error(`Invalid or out-of-range merged cell range for ${fixture.id}: ${range}`);
        }
        const canonicalRange = `${startRow}:${startColumn}:${endRow}:${endColumn}`;
        if (mergedRanges.has(canonicalRange)) throw new Error(`Duplicate merged cell range for ${fixture.id}: ${range}`);
        mergedRanges.add(canonicalRange);
      }
    }
    for (const fact of fixture.expected.facts) {
      if (factIds.has(fact.id)) throw new Error(`Duplicate extraction fact ID: ${fact.id}`);
      factIds.add(fact.id);
      if (!resolveJsonPointer(fixture.ground_truth, fact.field_path).found) {
        throw new Error(`Fact field path does not resolve for ${fixture.id}: ${fact.field_path}`);
      }
      const expectedPage = pages.get(fact.page);
      const expectedGeometry = geometry.get(fact.page);
      if (!expectedPage || !expectedGeometry) {
        throw new Error(`Fact ${fact.id} references missing page or geometry`);
      }
      if (!boxWithinPage(fact.bbox, expectedGeometry)) {
        throw new Error(`Fact ${fact.id} has a truth bbox outside page bounds`);
      }
      const anchor = normalizedText(fact.anchor_text);
      const visibleText = normalizedText(`${expectedPage.transcript} ${expectedPage.ordered_fragments.join(" ")}`);
      if (!visibleText.includes(anchor)) {
        throw new Error(`Fact ${fact.id} anchor is not visible in its expected page text`);
      }
    }
  }
  return {
    manifest,
    manifest_sha256: sha256(Buffer.from(canonicalJson(manifest))),
    schema_sha256: sha256(Buffer.from(canonicalJson(schema))),
  };
}

export function resolveExtractionFixture(manifestPath, fixture) {
  const resolved = path.resolve(path.dirname(manifestPath), fixture.path);
  const root = path.resolve(path.dirname(manifestPath));
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Fixture escapes extraction root: ${fixture.path}`);
  return resolved;
}
