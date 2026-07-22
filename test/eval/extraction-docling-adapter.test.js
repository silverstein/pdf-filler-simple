import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSchema,
  canonicalJson,
  validateCandidateResponseSemantics,
} from "./extraction-phase1-protocol.js";
import { prepareDoclingMacHandoff } from "./extraction-docling-handoff.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXPORT_FIXTURE = path.join(REPO_ROOT, "test/fixtures/eval/extraction/phase1/docling-export.synthetic.v1.json");
const EXPORT_SCHEMA = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "test/fixtures/eval/extraction/phase1/docling-export.adapter-projection.schema.json"), "utf8"));
const RESPONSE_SCHEMA = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "test/fixtures/eval/extraction/phase1/candidate-response.schema.json"), "utf8"));
const temporaryRoots = [];

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requestFor(source, overrides = {}) {
  const targetSchema = overrides.targetSchema ?? {
    type: "object",
    additionalProperties: false,
    required: ["amount", "vendor"],
    properties: { amount: { type: "number" }, vendor: { type: "string" } },
  };
  const limits = {
    deadline_ms: 60000,
    max_stdout_bytes: 1024 * 1024,
    max_stderr_bytes: 1024 * 1024,
    max_request_bytes: 1024 * 1024,
    max_report_bytes: 16 * 1024 * 1024,
    max_source_bytes: 1024 * 1024,
    max_pages: 10,
    ...overrides.limits,
  };
  return {
    protocol: "pdf-tools.extraction-candidate.v1",
    request_id: "a".repeat(64),
    candidate_id: "candidate.direct_pdf.v1",
    input_mode: "direct_pdf",
    source: {
      path: "source.pdf",
      media_type: "application/pdf",
      sha256: digest(source),
      size_bytes: source.length,
      page_count: overrides.pageCount ?? 2,
    },
    inputs: { layout_ir: null, raster_manifest: null },
    task: {
      instruction: "Return source-supported observations or a typed gap.",
      target_schema: targetSchema,
      target_schema_sha256: digest(Buffer.from(canonicalJson(targetSchema))),
    },
    limits,
  };
}

async function runAdapter({ request, source, exported = EXPORT_FIXTURE, environment = {}, extraArgs = [], mutateSnapshot = null, requestBytes = null }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-docling-adapter-"));
  temporaryRoots.push(root);
  const sourcePath = path.join(root, "source.pdf");
  const uvPath = path.join(root, "uv-test-binary");
  await Promise.all([
    fs.writeFile(sourcePath, source, { mode: 0o400 }),
    fs.writeFile(uvPath, "#!/bin/sh\nprintf 'uv 0.8.15\\n'\n", { mode: 0o700 }),
  ]);
  const handoff = await prepareDoclingMacHandoff({
    repoRoot: REPO_ROOT,
    cacheRoot: path.join(root, "Library/Caches/oda-pdf-tools-extraction"),
    sidecarRoot: path.join(root, "Sites/pdf-tools-extraction-sidecars"),
    protectedRoots: [path.join(root, "Documents"), path.join(root, "Dropbox"), path.join(root, "Library/Mobile Documents")],
    fixturePaths: [sourcePath],
    testOnlyHost: { platform: "darwin", architecture: "arm64", os_build: "25G88", kernel_release: "25.6.0", node_version: process.version },
    testOnlyUv: { path: uvPath, version: "uv 0.8.15" },
  });
  const snapshot = handoff.receipt.roots.sidecar_snapshot;
  const adapter = path.join(snapshot, handoff.receipt.inputs.find(item => item.role === "adapter_entrypoint").filename);
  const config = path.join(snapshot, handoff.receipt.inputs.find(item => item.role === "candidate_config").filename);
  if (mutateSnapshot) await mutateSnapshot({ snapshot, adapter, config, handoff });
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [adapter, "--config", config, "--artifacts-path", handoff.receipt.roots.models,
      "--receipt", handoff.receiptPath, "--expected-receipt-sha256", handoff.receipt_sha256,
      "--translate-export", exported, ...extraArgs], {
      cwd: root,
      env: { PATH: process.env.PATH, PDF_TOOLS_DOCLING_TEST_EXPORT: "1", PYTHONDONTWRITEBYTECODE: "1", ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), handoff }));
    child.stdin.end(requestBytes ?? `${JSON.stringify(request)}\n`);
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("evaluation-only Docling direct-PDF adapter", () => {
  it("pins the exact DoclingDocument 1.10 adapter projection and string-only table cells", async () => {
    const exported = JSON.parse(await fs.readFile(EXPORT_FIXTURE, "utf8"));
    expect(() => assertSchema(exported, EXPORT_SCHEMA, "Docling export projection")).not.toThrow();
    const withNumericCell = structuredClone(exported);
    withNumericCell.tables[0].data.table_cells[0].text = 0;
    expect(() => assertSchema(withNumericCell, EXPORT_SCHEMA, "Docling export projection")).toThrow(/Docling export projection/);
  });

  it("matches Phase 1 JavaScript canonical JSON for hostile numeric and UTF-16 key-order cases", () => {
    const payload = {
      "\u{1F600}": 2,
      "\uE000": 1,
      tiny: 1e-7,
      fixedTiny: 1e-6,
      huge: 1e21,
      fixedHuge: 1e20,
      roundedInteger: 9007199254740993,
    };
    const program = [
      "import importlib.util,json,sys",
      "spec=importlib.util.spec_from_file_location('adapter',sys.argv[1])",
      "module=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "sys.stdout.buffer.write(module.canonical_json(module.strict_json_loads(sys.stdin.buffer.read())))",
    ].join(";");
    const result = spawnSync("python3", ["-c", program, path.join(REPO_ROOT, "test/eval/candidates/docling/adapter.py")], {
      input: JSON.stringify(payload),
      env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(canonicalJson(payload));
  });

  it("emits parser observations, native-only provenance, and exact arbitrary-schema abstention", async () => {
    const source = Buffer.from("%PDF-1.7\nsynthetic adapter source\n%%EOF\n");
    const request = requestFor(source);
    const result = await runAdapter({ request, source });
    expect(result.code, result.stderr.toString()).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(() => assertSchema(response, RESPONSE_SCHEMA, "Docling response")).not.toThrow();
    expect(() => validateCandidateResponseSemantics(response, request, { targetSchema: request.task.target_schema })).not.toThrow();
    expect(response).toMatchObject({
      status: "abstained",
      decision: "abstain",
      structured_candidate: null,
      evidence: [],
      field_evidence: [],
      gaps: [
        { field_path: "/amount", reason: "unsupported_modality" },
        { field_path: "/vendor", reason: "unsupported_modality" },
      ],
    });
    expect(response.page_texts).toEqual([
      expect.objectContaining({ page: 1, text: "Invoice 1007", text_kind: "visual_parser", source_item_ids: [] }),
      expect.objectContaining({ page: 2, text: "Continuation", text_kind: "visual_parser", source_item_ids: [] }),
    ]);
    expect(response.native_evidence).not.toHaveLength(0);
    expect(response.native_evidence.every(item => item.coordinate_space !== "pdf-tools.display-top-left-points.v1")).toBe(true);
    expect(response.native_evidence.every(item => item.page_geometry.user_unit_handling === "unknown")).toBe(true);
  });

  it("treats truth-like target property names as schema, not leaked evaluation metadata", async () => {
    const source = Buffer.from("%PDF-1.7\nschema property names\n%%EOF\n");
    const targetSchema = {
      type: "object",
      additionalProperties: false,
      required: ["category", "expected"],
      properties: { category: { type: "string" }, expected: { type: "boolean" } },
    };
    const request = requestFor(source, { targetSchema });
    const result = await runAdapter({ request, source });
    expect(result.code, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "abstained",
      gaps: [{ field_path: "/category" }, { field_path: "/expected" }],
    });
  });

  it("preserves empty, literal zero/null strings, missing coordinates, and canonical spans as distinct table states", async () => {
    const source = Buffer.from("%PDF-1.7\ntable distinctions\n%%EOF\n");
    const request = requestFor(source);
    const result = await runAdapter({ request, source });
    const response = JSON.parse(result.stdout);
    expect(response.tables).toHaveLength(1);
    expect(response.tables[0]).toEqual(expect.objectContaining({
      row_count: 2,
      column_count: 3,
      merged_regions: [{ start_row: 1, start_column: 1, end_row: 1, end_column: 2 }],
      cells: [
        { row: 1, column: 1, row_span: 1, column_span: 2, present: true, value: "" },
        { row: 1, column: 3, row_span: 1, column_span: 1, present: true, value: "0" },
        { row: 2, column: 1, row_span: 1, column_span: 1, present: true, value: "null" },
        { row: 2, column: 3, row_span: 1, column_span: 1, present: true, value: "paid" },
      ],
    }));
    expect(response.tables[0].cells.some(cell => cell.row === 2 && cell.column === 2)).toBe(false);
  });

  it("slices quotes per text provenance and never invents a page for ambiguous multi-page table cells", async () => {
    const source = Buffer.from("%PDF-1.7\nmulti provenance\n%%EOF\n");
    const request = requestFor(source);
    const exported = JSON.parse(await fs.readFile(EXPORT_FIXTURE, "utf8"));
    exported.texts = [{
      self_ref: "#/texts/0",
      text: "AlphaBeta",
      prov: [
        { page_no: 1, bbox: { l: 72, t: 72, r: 120, b: 90, coord_origin: "TOPLEFT" }, charspan: [0, 5] },
        { page_no: 2, bbox: { l: 72, t: 72, r: 120, b: 90, coord_origin: "TOPLEFT" }, charspan: [5, 9] },
      ],
    }];
    exported.tables[0].prov.push({
      page_no: 2,
      bbox: { l: 72, t: 120, r: 360, b: 240, coord_origin: "TOPLEFT" },
      charspan: [0, 0],
    });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-docling-provenance-"));
    temporaryRoots.push(root);
    const exportPath = path.join(root, "export.json");
    await fs.writeFile(exportPath, JSON.stringify(exported), { mode: 0o600 });
    const response = JSON.parse((await runAdapter({ request, source, exported: exportPath })).stdout);
    expect(response.page_texts.map(item => item.text)).toEqual(["Alpha", "Beta"]);
    expect(response.native_evidence.filter(item => item.id.startsWith("docling.text")).map(item => item.quote)).toEqual(["Alpha", "Beta"]);
    expect(response.native_evidence.some(item => item.id.includes(".cell."))).toBe(false);
    expect(response.tables[0].pages).toEqual([1, 2]);
  });

  it("fails closed when Docling pages do not match the runner-owned page binding", async () => {
    const source = Buffer.from("%PDF-1.7\npage mismatch\n%%EOF\n");
    const request = requestFor(source, { pageCount: 1 });
    const result = await runAdapter({ request, source });
    expect(result.code).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response).toMatchObject({ status: "error", diagnostics: { code: "PAGE_BINDING_MISMATCH" } });
    expect(response.page_texts).toEqual([]);
    expect(response.tables).toEqual([]);
    expect(response.native_evidence).toEqual([]);
    expect(() => validateCandidateResponseSemantics(response, request, { targetSchema: request.task.target_schema })).not.toThrow();
  });

  it("rejects array-shaped, malformed, and non-finite export data as typed errors", async () => {
    const source = Buffer.from("%PDF-1.7\nmalformed export\n%%EOF\n");
    const request = requestFor(source);
    for (const raw of ["[]", "{", '{"schema_name":"DoclingDocument","version":"1.10.0","pages":{"1":{"page_no":1,"size":{"width":1e999,"height":792}}},"texts":[],"tables":[]}']) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-docling-malformed-"));
      temporaryRoots.push(root);
      const exportPath = path.join(root, "export.json");
      await fs.writeFile(exportPath, raw, { mode: 0o600 });
      const result = await runAdapter({ request, source, exported: exportPath });
      expect(result.code, result.stderr.toString()).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "error", diagnostics: { code: "DOCLING_EXPORT_INVALID" } });
    }
  });

  it("fails closed on source digest changes and exposes no parser output", async () => {
    const source = Buffer.from("%PDF-1.7\nsource identity\n%%EOF\n");
    const request = requestFor(Buffer.from("different bytes"));
    request.source.size_bytes = source.length;
    const result = await runAdapter({ request, source });
    const response = JSON.parse(result.stdout);
    expect(response).toMatchObject({ status: "error", diagnostics: { code: "SOURCE_DIGEST_MISMATCH" } });
    expect(response.page_texts).toEqual([]);
    expect(response.native_evidence).toEqual([]);
  });

  it("converts oversized parser output into a bounded typed error", async () => {
    const source = Buffer.from("%PDF-1.7\noutput limit\n%%EOF\n");
    const request = requestFor(source, { limits: { max_stdout_bytes: 1024 } });
    const exported = JSON.parse(await fs.readFile(EXPORT_FIXTURE, "utf8"));
    exported.texts[0].text = "x".repeat(5000);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-docling-export-"));
    temporaryRoots.push(root);
    const exportPath = path.join(root, "export.json");
    await fs.writeFile(exportPath, JSON.stringify(exported));
    const result = await runAdapter({ request, source, exported: exportPath });
    expect(result.code, result.stderr.toString()).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(1024);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "error", diagnostics: { code: "OUTPUT_LIMIT_EXCEEDED" } });
  });

  it("keeps the synthetic export seam unavailable to real candidate runs", async () => {
    const source = Buffer.from("%PDF-1.7\ntest seam\n%%EOF\n");
    const request = requestFor(source);
    const result = await runAdapter({ request, source, environment: { PDF_TOOLS_DOCLING_TEST_EXPORT: "0" } });
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "error", diagnostics: { code: "TEST_SEAM_FORBIDDEN" } });
  });

  it("rejects configuration mutation before importing Docling", async () => {
    const source = Buffer.from("%PDF-1.7\ntable license gate\n%%EOF\n");
    const request = requestFor(source);
    const result = await runAdapter({
      request,
      source,
      mutateSnapshot: async ({ config }) => fs.appendFile(config, " "),
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "error", diagnostics: { code: "HANDOFF_INPUT_MISMATCH" } });
  });

  it("requires an explicit SUCCESS conversion result in the synthetic status seam", async () => {
    const source = Buffer.from("%PDF-1.7\nconversion status\n%%EOF\n");
    const request = requestFor(source);
    for (const status of ["PARTIAL_SUCCESS", "FAILURE", "timeout"] ) {
      const result = await runAdapter({ request, source, extraArgs: ["--test-conversion-status", status] });
      expect(result.code, result.stderr.toString()).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "error", diagnostics: { code: "DOCLING_CONVERSION_INCOMPLETE" } });
    }
    const success = await runAdapter({ request, source, extraArgs: ["--test-conversion-status", "SUCCESS"] });
    expect(JSON.parse(success.stdout)).toMatchObject({ status: "abstained" });
  });

  it("enforces the request-declared input ceiling and schema complexity ceiling", async () => {
    const source = Buffer.from("%PDF-1.7\nrequest limits\n%%EOF\n");
    const oversized = requestFor(source, { limits: { max_request_bytes: 1024 } });
    oversized.task.instruction = "x".repeat(2048);
    const oversizedResult = await runAdapter({ request: oversized, source });
    expect(JSON.parse(oversizedResult.stdout)).toMatchObject({ status: "error", diagnostics: { code: "REQUEST_TOO_LARGE" } });

    let nested = { type: "string" };
    for (let index = 0; index < 40; index += 1) {
      nested = { type: "object", additionalProperties: false, required: ["x"], properties: { x: nested } };
    }
    const complex = requestFor(source, { targetSchema: nested });
    const complexResult = await runAdapter({ request: complex, source });
    expect(JSON.parse(complexResult.stdout)).toMatchObject({ status: "error", diagnostics: { code: "TARGET_SCHEMA_TOO_COMPLEX" } });
  });
});
