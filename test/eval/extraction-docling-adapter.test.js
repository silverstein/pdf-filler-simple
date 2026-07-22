import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSchema,
  canonicalJson,
  validateCandidateResponseSemantics,
} from "./extraction-phase1-protocol.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ADAPTER = path.join(REPO_ROOT, "test/eval/candidates/docling/adapter.py");
const CONFIG = path.join(REPO_ROOT, "test/fixtures/eval/extraction/phase1/docling-candidate-config.v1.json");
const EXPORT_FIXTURE = path.join(REPO_ROOT, "test/fixtures/eval/extraction/phase1/docling-export.synthetic.v1.json");
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

async function runAdapter({ request, source, exported = EXPORT_FIXTURE, config = CONFIG, environment = {}, extraArgs = [] }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-docling-adapter-"));
  temporaryRoots.push(root);
  await fs.writeFile(path.join(root, "source.pdf"), source, { mode: 0o400 });
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [ADAPTER, "--config", config, "--artifacts-path", root, "--translate-export", exported, ...extraArgs], {
      cwd: root,
      env: { PATH: process.env.PATH, PDF_TOOLS_DOCLING_TEST_EXPORT: "1", ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("evaluation-only Docling direct-PDF adapter", () => {
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

  it("preserves empty string, zero, null, missing coordinates, and canonical spans as distinct table states", async () => {
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
        { row: 1, column: 3, row_span: 1, column_span: 1, present: true, value: 0 },
        { row: 2, column: 1, row_span: 1, column_span: 1, present: true, value: null },
        { row: 2, column: 3, row_span: 1, column_span: 1, present: true, value: "paid" },
      ],
    }));
    expect(response.tables[0].cells.some(cell => cell.row === 2 && cell.column === 2)).toBe(false);
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

  it("refuses an enabled TableFormer config before importing Docling", async () => {
    const source = Buffer.from("%PDF-1.7\ntable license gate\n%%EOF\n");
    const request = requestFor(source);
    const config = JSON.parse(await fs.readFile(CONFIG, "utf8"));
    config.table_model.enabled = true;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-docling-config-"));
    temporaryRoots.push(root);
    const configPath = path.join(root, "config.json");
    await fs.writeFile(configPath, JSON.stringify(config));
    const result = await runAdapter({ request, source, config: configPath });
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "error", diagnostics: { code: "TABLE_MODEL_NOT_REVIEWED" } });
  });

  it("turns malformed package configuration into a typed fail-closed response", async () => {
    const source = Buffer.from("%PDF-1.7\npackage identity\n%%EOF\n");
    const request = requestFor(source);
    const config = JSON.parse(await fs.readFile(CONFIG, "utf8"));
    config.packages.pop();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-docling-package-config-"));
    temporaryRoots.push(root);
    const configPath = path.join(root, "config.json");
    await fs.writeFile(configPath, JSON.stringify(config));
    const result = await runAdapter({ request, source, config: configPath });
    expect(result.code, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "error", diagnostics: { code: "PACKAGE_SET_MISMATCH" } });
  });
});
