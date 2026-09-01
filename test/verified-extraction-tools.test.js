import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { extractPdfLayoutForMarkdown } from "../server/layout-extraction.js";
import {
  VERIFIED_EXTRACTION_TOOL_DEFINITIONS,
  createVerifiedExtractionToolHandler,
} from "../server/verified-extraction-tools.js";
import { validateStructuredToolResult } from "../server/output-schemas.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_PATH = path.join(
  REPO_ROOT,
  "test/fixtures/eval/extraction/synthetic/born-digital-flat.pdf",
);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function expectValidOutput(toolName, structuredContent) {
  const result = { content: [], structuredContent };
  expect(validateStructuredToolResult(toolName, result)).toBe(result);
}

describe("verified extraction MCP lifecycle", () => {
  let pdfjsLib;
  let parentPath;
  let workspaceRoot;
  let handle;

  beforeAll(async () => {
    pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  }, 60_000);

  beforeEach(async () => {
    parentPath = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-mcp-e9e7-")));
    await fs.chmod(parentPath, 0o700);
    workspaceRoot = path.join(parentPath, "workspaces");
    handle = createVerifiedExtractionToolHandler({
      workspaceRoot,
      resolvePdfPath: value => path.resolve(value),
      readPdfBytes: filename => fs.readFile(filename),
      extractLayouts: async ({ resolvedPath, sourceBytes, maxPages }) => {
        const sourceSha256 = sha256(sourceBytes);
        const first = await extractPdfLayoutForMarkdown({
          pdfjsLib,
          pdfBytes: sourceBytes,
          sourcePath: resolvedPath,
          sourceFileName: path.basename(resolvedPath),
          sourceSha256,
          requestedStartPage: 1,
          requestedEndPage: 1,
          maxItems: 5000,
          maxCharacters: 100000,
          maxOutputCharacters: 200000,
          deadlineMs: 20000,
        });
        expect(first.page_range.total_pages).toBeLessThanOrEqual(maxPages);
        return [first];
      },
    });
  });

  afterEach(async () => {
    await fs.rm(parentPath, { recursive: true, force: true });
  });

  it("ships seven bounded tools and persists a source-replayed exact value", async () => {
    expect(VERIFIED_EXTRACTION_TOOL_DEFINITIONS.map(tool => tool.name)).toEqual([
      "create_extraction_workspace",
      "inspect_extraction_state",
      "read_extraction_workspace",
      "read_extraction_chunk",
      "submit_extraction_proposal",
      "verify_extraction_proposal",
      "delete_extraction_workspace",
    ]);
    const created = await handle("create_extraction_workspace", {
      pdf_path: SOURCE_PATH,
      workspace_id: "invoice-extraction",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["invoice_id"],
        properties: { invoice_id: { type: "string" } },
      },
    });
    expect(created).toMatchObject({
      state: "complete",
      generation_sequence: 0,
      leaf_obligations: ["/invoice_id"],
    });
    expectValidOutput("create_extraction_workspace", created);

    const chunkPage = await handle("read_extraction_workspace", {
      workspace_id: "invoice-extraction",
      workspace_identity_sha256: created.workspace_identity_sha256,
      collection: "document_map_chunks",
      limit: 10,
    });
    expect(chunkPage.items).toHaveLength(1);
    expectValidOutput("read_extraction_workspace", chunkPage);
    const chunk = await handle("read_extraction_chunk", {
      pdf_path: SOURCE_PATH,
      workspace_id: "invoice-extraction",
      workspace_identity_sha256: created.workspace_identity_sha256,
      chunk_id: chunkPage.items[0].chunk_id,
    });
    expectValidOutput("read_extraction_chunk", chunk);
    const quote = Buffer.from("INV-1001", "utf8");
    const content = Buffer.from(chunk.content, "utf8");
    const start = content.indexOf(quote);
    expect(start).toBeGreaterThanOrEqual(0);

    const proposed = await handle("submit_extraction_proposal", {
      workspace_id: "invoice-extraction",
      workspace_identity_sha256: created.workspace_identity_sha256,
      parent_generation_sha256: created.generation_sha256,
      leaf_pointer: "/invoice_id",
      proposed_value: "INV-1001",
      chunk_ids: [chunk.chunk_id],
    });
    expectValidOutput("submit_extraction_proposal", proposed);
    const verified = await handle("verify_extraction_proposal", {
      pdf_path: SOURCE_PATH,
      workspace_id: "invoice-extraction",
      workspace_identity_sha256: created.workspace_identity_sha256,
      proposal_generation_sha256: proposed.generation_sha256,
      proposal_event_id: proposed.event.event_id,
      citations: [{
        chunk_id: chunk.chunk_id,
        start_utf8_byte: start,
        end_utf8_byte: start + quote.length,
        quote_sha256: sha256(quote),
      }],
      method: { kind: "exact_projection", citation_index: 0, normalization: "identity" },
    });
    expect(verified).toMatchObject({
      generation_sequence: 2,
      result: { status: "verified_exact", derived_value: "INV-1001" },
    });
    expectValidOutput("verify_extraction_proposal", verified);
    const pending = await handle("read_extraction_workspace", {
      workspace_id: "invoice-extraction",
      workspace_identity_sha256: created.workspace_identity_sha256,
      collection: "pending_leaves",
      limit: 10,
    });
    expect(pending.items).toEqual([]);
    const inspection = await handle("inspect_extraction_state", {
      workspace_id: "invoice-extraction",
      workspace_identity_sha256: created.workspace_identity_sha256,
    });
    expect(inspection).toMatchObject({
      state: "complete",
      current_generation_sha256: verified.generation_sha256,
      current_generation_sequence: 2,
    });
    expectValidOutput("inspect_extraction_state", inspection);
    const deleted = await handle("delete_extraction_workspace", {
      workspace_id: "invoice-extraction",
      workspace_identity_sha256: created.workspace_identity_sha256,
      current_generation_sha256: verified.generation_sha256,
      confirm: "DELETE",
    });
    expect(deleted).toMatchObject({ state: "deleted", recoverable: false });
    expectValidOutput("delete_extraction_workspace", deleted);
  }, 60_000);

  it("rejects unknown arguments for every verified-extraction tool", async () => {
    for (const { name } of VERIFIED_EXTRACTION_TOOL_DEFINITIONS) {
      await expect(handle(name, { unexpected_argument: true }))
        .rejects.toThrow(/unknown argument/u);
    }
  });

  it("rejects stale generations, source drift, and deletion without exact confirmation", async () => {
    const created = await handle("create_extraction_workspace", {
      pdf_path: SOURCE_PATH,
      workspace_id: "hostile-workspace",
      schema: { type: "object", properties: { invoice_id: { type: "string" } } },
    });
    const chunks = await handle("read_extraction_workspace", {
      workspace_id: "hostile-workspace",
      workspace_identity_sha256: created.workspace_identity_sha256,
      collection: "document_map_chunks",
      limit: 10,
    });
    const proposed = await handle("submit_extraction_proposal", {
      workspace_id: "hostile-workspace",
      workspace_identity_sha256: created.workspace_identity_sha256,
      parent_generation_sha256: created.generation_sha256,
      leaf_pointer: "/invoice_id",
      proposed_value: "INV-1001",
      chunk_ids: [chunks.items[0].chunk_id],
    });
    await expect(handle("submit_extraction_proposal", {
      workspace_id: "hostile-workspace",
      workspace_identity_sha256: created.workspace_identity_sha256,
      parent_generation_sha256: created.generation_sha256,
      leaf_pointer: "/invoice_id",
      proposed_value: "forged",
      chunk_ids: [chunks.items[0].chunk_id],
    })).rejects.toThrow(/exact expected parent/u);
    await expect(handle("delete_extraction_workspace", {
      workspace_id: "hostile-workspace",
      workspace_identity_sha256: created.workspace_identity_sha256,
      current_generation_sha256: proposed.generation_sha256,
      confirm: "NO",
    })).rejects.toThrow(/literal DELETE/u);

    const changedPath = path.join(parentPath, "changed.pdf");
    await fs.writeFile(changedPath, Buffer.concat([await fs.readFile(SOURCE_PATH), Buffer.from([0])]));
    await expect(handle("read_extraction_chunk", {
      pdf_path: changedPath,
      workspace_id: "hostile-workspace",
      workspace_identity_sha256: created.workspace_identity_sha256,
      chunk_id: chunks.items[0].chunk_id,
    })).rejects.toThrow(/source|hash|byte|different inputs/u);
  }, 60_000);
});
