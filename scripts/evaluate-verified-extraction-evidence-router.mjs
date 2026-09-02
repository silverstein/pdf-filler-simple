import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  readSourceBoundDocumentChunk,
} from "../server/document-map.js";
import {
  buildSchemaDirectedEvidencePlan,
  canonicalizeSchemaDirectedExtraction,
} from "./verified-extraction-evidence-router.mjs";

const canonicalJson = value => Array.isArray(value) ? `[${value.map(canonicalJson).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const sha256 = value => createHash("sha256").update(value).digest("hex");

function assertion(condition, message) {
  if (!condition) throw new Error(`Evidence-router evaluation failed: ${message}`);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    assertion(/^--[a-z-]+$/u.test(key ?? "") && typeof value === "string",
      "arguments must be --key value pairs");
    assertion(!values.has(key), `duplicate argument ${key}`);
    values.set(key, value);
  }
  const expected = ["--admission-root", "--mode", "--output", "--state-root"];
  assertion(canonicalJson([...values.keys()].sort()) === canonicalJson(expected),
    "exactly --admission-root, --mode, --output, and --state-root are required");
  assertion(["plan-only", "project-completed"].includes(values.get("--mode")),
    "--mode must be plan-only or project-completed");
  return {
    admissionRoot: path.resolve(values.get("--admission-root")),
    mode: values.get("--mode"),
    output: path.resolve(values.get("--output")),
    stateRoot: path.resolve(values.get("--state-root")),
  };
}

async function readPhysicalFile(filePath) {
  const before = await fsp.lstat(filePath);
  assertion(before.isFile() && !before.isSymbolicLink(), `${filePath} must be a physical file`);
  const bytes = await fsp.readFile(filePath);
  const after = await fsp.lstat(filePath);
  assertion(before.dev === after.dev && before.ino === after.ino && before.size === after.size,
    `${filePath} changed while being read`);
  return bytes;
}

async function readJson(filePath) {
  return JSON.parse((await readPhysicalFile(filePath)).toString("utf8"));
}

async function readLayouts(documentDirectory) {
  const layoutsDirectory = path.join(documentDirectory, "layouts");
  const entries = await fsp.readdir(layoutsDirectory, { withFileTypes: true });
  const names = entries.filter(entry => entry.isFile() && /^page-[0-9]{5}\.layout\.json$/u.test(entry.name))
    .map(entry => entry.name).sort();
  assertion(names.length > 0, `${documentDirectory} has no retained layouts`);
  return Promise.all(names.map(name => readJson(path.join(layoutsDirectory, name))));
}

function receiptPath(documentDirectory) {
  return path.join(documentDirectory, "attempt-receipt.unscored.v1.json");
}

async function documentEvaluation({ document, mode, schemaBytes, stateRoot }) {
  const documentDirectory = path.join(stateRoot, document.id);
  const [documentMap, documentSourcePages, sourceBytes, layouts] = await Promise.all([
    readJson(path.join(documentDirectory, "document-map.v1.json")),
    readJson(path.join(documentDirectory, "document-source-pages.v1.json")),
    readPhysicalFile(document.artifacts.pdf.path),
    readLayouts(documentDirectory),
  ]);
  assertion(sha256(sourceBytes) === document.artifacts.pdf.sha256,
    `${document.id} source bytes drifted`);
  const chunks = documentMap.chunks.descriptors.map(descriptor => readSourceBoundDocumentChunk({
    documentMap,
    chunkId: descriptor.chunk_id,
    sourceBytes,
    schemaBytes,
    layouts,
  }));
  const documentChunks = chunks.map((chunk, index) => ({
    document_id: document.id,
    chunk_id: chunk.chunk_id,
    page_range: chunk.page_range,
    starts_at_heading: documentMap.chunks.descriptors[index].starts_at_heading,
    content: chunk.content,
    content_sha256: chunk.content_sha256,
  }));
  const plan = buildSchemaDirectedEvidencePlan({
    documentId: document.id,
    documentMapSha256: documentMap.document_map_sha256,
    sourceSha256: document.artifacts.pdf.sha256,
    documentChunks,
    documentTableRegions: documentMap.table_regions,
    documentSourcePages,
  });
  let receipt = null;
  let originalModelCallCount = null;
  let projection = null;
  if (mode === "project-completed") {
    [receipt] = await Promise.all([readJson(receiptPath(documentDirectory))]);
    const trace = await readJson(path.join(documentDirectory, "tool-model-trace.v1.json"));
    originalModelCallCount = trace.events.filter(event => event.kind === "model_call").length;
    projection = receipt.result === null ? null : canonicalizeSchemaDirectedExtraction({
      plan,
      documentChunks,
      documentTableRegions: documentMap.table_regions,
      documentSourcePages,
      result: receipt.result,
    });
  }
  return {
    document_id: document.id,
    receipt_outcome: receipt === null ? null : structuredClone(receipt.outcome),
    page_count: document.stratification.pages,
    total_chunk_count: plan.total_chunk_count,
    original_model_call_count: originalModelCallCount,
    routed_model_call_upper_bound: plan.maximum_model_calls_after_context_splitting,
    citation_page_one_based: plan.citation_page_one_based,
    byline_page_one_based: plan.byline_page_one_based,
    first_actual_table_page_one_based: plan.first_actual_table.page_one_based,
    selected_pages: plan.selected_pages.map(item => item.page_one_based),
    selected_chunk_count: plan.selected_chunk_count,
    evidence_plan_sha256: plan.plan_sha256,
    canonical_projection: projection,
  };
}

async function main() {
  const { admissionRoot, mode, output, stateRoot } = parseArguments(process.argv.slice(2));
  const [register, schemaBytes] = await Promise.all([
    readJson(path.join(admissionRoot, "admission-register.v1.json")),
    readPhysicalFile(path.join(admissionRoot, "schema.v1.json")),
  ]);
  assertion(sha256(schemaBytes) === register.artifacts.schema.sha256,
    "schema bytes drifted from the admission register");
  const available = [];
  for (const document of register.documents) {
    if (!fs.existsSync(path.join(stateRoot, document.id, "document-map.v1.json"))) continue;
    available.push(await documentEvaluation({ document, mode, schemaBytes, stateRoot }));
  }
  assertion(available.length > 0, "the state root contains no complete document-map evidence");
  const completed = available.filter(item => item.canonical_projection !== null);
  const body = {
    version: 1,
    mode,
    qualification: mode === "plan-only"
      ? "zero_inference_source_evidence_routing_plan_only"
      : "zero_inference_source_evidence_routing_and_projection_only",
    inputs: {
      admission_register_sha256: sha256(await readPhysicalFile(path.join(admissionRoot,
        "admission-register.v1.json"))),
      schema_sha256: sha256(schemaBytes),
      state_root: stateRoot,
    },
    coverage: {
      admitted_document_count: register.documents.length,
      evaluated_document_count: available.length,
      projected_completed_document_count: completed.length,
    },
    call_accounting: {
      original_model_calls: mode === "plan-only" ? null
        : available.reduce((sum, item) => sum + item.original_model_call_count, 0),
      routed_model_call_upper_bound: available.reduce((sum, item) => (
        sum + item.routed_model_call_upper_bound
      ), 0),
    },
    documents: available,
    model_or_provider_calls_made: 0,
    oracle_accessed: false,
    benchmark_claim_ready: false,
  };
  const report = { ...body, report_sha256: sha256(Buffer.from(canonicalJson(body), "utf8")) };
  const handle = await fsp.open(output, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    report_sha256: report.report_sha256,
    evaluated_documents: available.length,
    projected_documents: completed.length,
    original_model_calls: body.call_accounting.original_model_calls,
    routed_model_call_upper_bound: body.call_accounting.routed_model_call_upper_bound,
  })}\n`);
}

await main();
