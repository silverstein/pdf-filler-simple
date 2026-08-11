import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  evaluateTableGridConsistency,
  validateTableProposalVerificationResult,
  verifyTableProposalAgainstRegion,
} from "../server/table-proposal-verification.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_ROOT = path.join(REPO_ROOT, "test/fixtures/eval/verified-vision");
const BORDERLESS = path.join(FIXTURE_ROOT, "table-borderless-ambiguous.pdf");
const LINES = path.join(FIXTURE_ROOT, "table-ruled-lines.pdf");
const MERGED = path.join(FIXTURE_ROOT, "table-ruled-merged-negative.pdf");

function tokenFor(packet, result) {
  return createHash("sha256")
    .update([
      result.structuredContent.provenance.source.sha256,
      result.structuredContent.provenance.layout.version,
      packet.region_id,
    ].join("\n"), "utf8")
    .digest("hex");
}

function cellsFromReferences(packet, proposal) {
  const occurrences = new Map();
  const byReference = new Map();
  for (const item of packet.text_items) {
    const occurrence = (occurrences.get(item.text) ?? 0) + 1;
    occurrences.set(item.text, occurrence);
    byReference.set(`${item.text}\u0000${occurrence}`, item.id);
  }
  return proposal.cells.map(cell => ({
    row: cell.row,
    column: cell.column,
    rowspan: cell.rowspan,
    colspan: cell.colspan,
    item_ids: cell.item_refs.map(reference => {
      const id = byReference.get(`${reference.text}\u0000${reference.occurrence}`);
      if (!id) throw new Error(`Missing fixture item reference ${reference.text}#${reference.occurrence}`);
      return id;
    }),
  }));
}

describe("verified-vision B2 source-replayed table proposal verifier", () => {
  let client;
  let transport;
  let proposals;
  let borderlessPacket;
  let borderlessToken;
  let borderlessCells;
  let linePacket;
  let lineToken;
  let mergedPacket;
  let mergedToken;

  beforeAll(async () => {
    proposals = JSON.parse(await readFile(
      path.join(FIXTURE_ROOT, "known-proposals.v1.json"),
      "utf8",
    )).proposals;
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server/index.js")],
      cwd: REPO_ROOT,
      env: { ALLOWED_DIRECTORIES: `${REPO_ROOT}${path.delimiter}${os.tmpdir()}` },
      stderr: "ignore",
    });
    client = new Client({ name: "verified-vision-verifier", version: "1.0.0" });
    await client.connect(transport);

    const borderless = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: BORDERLESS, max_markdown_bytes: 200000, emit_table_proposals: true },
    });
    borderlessPacket = borderless.structuredContent.table_proposals[0];
    borderlessToken = tokenFor(borderlessPacket, borderless);
    borderlessCells = cellsFromReferences(
      borderlessPacket,
      proposals.find(proposal => proposal.id === "borderless-three-column-plausible"),
    );

    const lines = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: LINES, max_markdown_bytes: 200000, emit_table_proposals: true },
    });
    linePacket = lines.structuredContent.table_proposals[0];
    lineToken = tokenFor(linePacket, lines);

    const merged = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: MERGED, max_markdown_bytes: 200000, emit_table_proposals: true },
    });
    mergedPacket = merged.structuredContent.table_proposals[0];
    mergedToken = tokenFor(mergedPacket, merged);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await transport?.close();
  });

  async function verify(pdfPath, packet, proposalToken, cells, extra = {}) {
    return client.callTool({
      name: "verify_table_proposal",
      arguments: {
        pdf_path: pdfPath,
        region_id: packet.region_id,
        proposal_token: proposalToken,
        cells,
        ...extra,
      },
    });
  }

  it("1. discovers a strictly read-only verifier contract", async () => {
    const listed = await client.listTools();
    const tool = listed.tools.find(candidate => candidate.name === "verify_table_proposal");
    expect(tool).toBeDefined();
    expect(tool.annotations).toEqual({
      title: "Verify Table Proposal",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.outputSchema).toBeDefined();
  });

  it("2. reparses source and recomputes token identity before checking structure", async () => {
    const result = await verify(BORDERLESS, borderlessPacket, borderlessToken, borderlessCells);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.source_reparsed).toBe(true);
    expect(result.structuredContent.checks.token_binding).toBe("passed");
    expect(result.structuredContent.source.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.structuredContent.status).toBe("rejected");
    expect(result.structuredContent.reason_codes).toContain("TABLE_PROPOSAL_HEADER_UNSUPPORTED");
  }, 30_000);

  it("3. rejects a stale token after the source bytes change", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pdf-tools-b2-"));
    const mutated = path.join(tempRoot, "mutated.pdf");
    try {
      await copyFile(BORDERLESS, mutated);
      await appendFile(mutated, "\n% deterministic token-mutation fixture\n", "utf8");
      const result = await verify(mutated, borderlessPacket, borderlessToken, borderlessCells);
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent.status).toBe("rejected");
      expect(result.structuredContent.reason_codes).toEqual(["TABLE_PROPOSAL_TOKEN_MISMATCH"]);
      expect(result.structuredContent.checks.token_binding).toBe("failed");
      expect(result.structuredContent.checks.region_evidence).toBe("not_run");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("4. distinguishes missing, duplicated, and unknown source item failures", async () => {
    const missing = structuredClone(borderlessCells);
    missing[0].item_ids = [];
    const missingResult = await verify(BORDERLESS, borderlessPacket, borderlessToken, missing);
    expect(missingResult.structuredContent.reason_codes).toContain("TABLE_PROPOSAL_ITEM_MISSING");

    const duplicated = structuredClone(borderlessCells);
    duplicated[1].item_ids.push(duplicated[0].item_ids[0]);
    const duplicatedResult = await verify(BORDERLESS, borderlessPacket, borderlessToken, duplicated);
    expect(duplicatedResult.structuredContent.reason_codes).toContain("TABLE_PROPOSAL_ITEM_DUPLICATED");

    const unknown = structuredClone(borderlessCells);
    unknown[0].item_ids[0] = "p0001-i999999";
    const unknownResult = await verify(BORDERLESS, borderlessPacket, borderlessToken, unknown);
    expect(unknownResult.structuredContent.reason_codes).toContain("TABLE_PROPOSAL_ITEM_UNKNOWN");
  }, 45_000);

  it("5. rejects a source line split across proposed rows", async () => {
    const rowSplit = proposals.find(proposal => proposal.id === "line-table-row-split");
    const cells = cellsFromReferences(linePacket, rowSplit);
    const result = await verify(LINES, linePacket, lineToken, cells);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.reason_codes).toContain("TABLE_PROPOSAL_LINE_STRADDLE");
  }, 30_000);

  it("6. rejects non-monotone proposed row and column order", async () => {
    const rowCells = structuredClone(borderlessCells);
    for (const cell of rowCells) cell.row = 3 - cell.row;
    const rowResult = await verify(BORDERLESS, borderlessPacket, borderlessToken, rowCells);
    expect(rowResult.structuredContent.reason_codes).toContain("TABLE_PROPOSAL_ROW_ORDER");

    const columnCells = structuredClone(borderlessCells);
    for (const cell of columnCells) cell.column = 2 - cell.column;
    const columnResult = await verify(BORDERLESS, borderlessPacket, borderlessToken, columnCells);
    expect(columnResult.structuredContent.reason_codes).toContain("TABLE_PROPOSAL_COLUMN_ORDER");
  }, 30_000);

  it("7. refuses both plausible borderless structures without independent header evidence", async () => {
    for (const id of ["borderless-three-column-plausible", "borderless-one-column-plausible"]) {
      const proposal = proposals.find(candidate => candidate.id === id);
      const result = await verify(
        BORDERLESS,
        borderlessPacket,
        borderlessToken,
        cellsFromReferences(borderlessPacket, proposal),
      );
      expect(result.structuredContent.status).toBe("rejected");
      expect(result.structuredContent.reason_codes).toContain("TABLE_PROPOSAL_HEADER_UNSUPPORTED");
      expect(result.structuredContent.reason_codes).toContain("TABLE_PROPOSAL_TOPOLOGY_AMBIGUOUS");
      expect(result.structuredContent.table).toBeNull();
    }
  }, 30_000);

  it("8. accepts a pure taller-header case and derives every output character from source items", () => {
    const token = "a".repeat(64);
    const source = { file_name: "synthetic.pdf", sha256: "b".repeat(64), size_bytes: 123 };
    const layout = {
      name: "pdf-tools.extraction-ir",
      version: "1.6.0",
      parser_name: "pdfjs-dist",
      parser_version: "5.4.624",
    };
    const region = {
      region_id: "p1-t1",
      page: 1,
      reason: "TABLE_TOPOLOGY_UNKNOWN",
      text_items: [
        { id: "i1", text: "NA", reading_order_index: 0, line_id: "l1", bbox: { x: 10, y: 10, width: 10, height: 8 } },
        { id: "i2", text: "ME", reading_order_index: 1, line_id: "l1", bbox: { x: 21, y: 10, width: 10, height: 8 } },
        { id: "i3", text: "VALUE", reading_order_index: 2, line_id: "l1", bbox: { x: 60, y: 10, width: 20, height: 8 } },
        { id: "i4", text: "North", reading_order_index: 3, line_id: "l2", bbox: { x: 10, y: 40, width: 20, height: 8 } },
        { id: "i5", text: "1200", reading_order_index: 4, line_id: "l2", bbox: { x: 60, y: 40, width: 20, height: 8 } },
      ],
      bbox: { x: 10, y: 10, width: 70, height: 38 },
      ruling_segments: [
        { orientation: "vertical", x1: 50, y1: 0, x2: 50, y2: 60, source_operator_index: 1 },
        { orientation: "horizontal", x1: 0, y1: 30, x2: 90, y2: 30, source_operator_index: 2 },
      ],
      header_hints: { status: "available", first_row_band: "taller_than_body" },
      truncation: { text_items: "complete", ruled_rects: "complete", ruling_segments: "complete", painted_rectangles: "complete" },
    };
    const result = verifyTableProposalAgainstRegion({
      source,
      layout,
      regionId: "p1-t1",
      page: 1,
      region,
      proposalToken: token,
      expectedProposalToken: token,
      cells: [
        { row: 0, column: 0, rowspan: 1, colspan: 1, item_ids: ["i1", "i2"] },
        { row: 0, column: 1, rowspan: 1, colspan: 1, item_ids: ["i3"] },
        { row: 1, column: 0, rowspan: 1, colspan: 1, item_ids: ["i4"] },
        { row: 1, column: 1, rowspan: 1, colspan: 1, item_ids: ["i5"] },
      ],
    });
    expect(validateTableProposalVerificationResult(result)).toBe(result);
    expect(result.status).toBe("accepted");
    expect(result.reason_codes).toEqual([]);
    expect(result.table.cells.map(cell => cell.text)).toEqual(["NAME", "VALUE", "North", "1200"]);
    expect(result.table.content_origin).toBe("reparsed_pdf_text_layer");
    expect(result.claim_boundary).toContain("Consistency is not proof of unique topology");
  });

  it("9. B3 accepts the authored merged span and rejects both text-conserving topology errors", async () => {
    const authored = proposals.find(proposal => proposal.id === "merged-span-authored-control");
    const invented = proposals.find(proposal => proposal.id === "merged-span-invented-header-cut");
    const columnMerge = proposals.find(proposal => proposal.id === "line-table-column-merge");

    const authoredResult = await verify(
      MERGED,
      mergedPacket,
      mergedToken,
      cellsFromReferences(mergedPacket, authored),
    );
    expect(authoredResult.structuredContent.status).toBe("accepted");
    expect(authoredResult.structuredContent.reason_codes).toEqual([]);
    expect(authoredResult.structuredContent.table).toMatchObject({ row_count: 4, column_count: 3 });
    expect(authoredResult.structuredContent.checks).toMatchObject({
      rectangular_grid: "passed",
      cut_line_consistency: "passed",
      ruled_line_agreement: "passed",
      topology_ambiguity: "passed",
      header_evidence: "passed",
    });

    const inventedResult = await verify(
      MERGED,
      mergedPacket,
      mergedToken,
      cellsFromReferences(mergedPacket, invented),
    );
    expect(inventedResult.structuredContent.status).toBe("rejected");
    expect(inventedResult.structuredContent.reason_codes).toContain("TABLE_PROPOSAL_RULING_CONFLICT");
    expect(inventedResult.structuredContent.reason_codes).not.toContain("TABLE_PROPOSAL_HEADER_UNSUPPORTED");

    const mergeResult = await verify(
      LINES,
      linePacket,
      lineToken,
      cellsFromReferences(linePacket, columnMerge),
    );
    expect(mergeResult.structuredContent.status).toBe("rejected");
    expect(mergeResult.structuredContent.reason_codes).toEqual(expect.arrayContaining([
      "TABLE_PROPOSAL_CUTS_INCONSISTENT",
      "TABLE_PROPOSAL_RULING_CONFLICT",
    ]));
    expect(mergeResult.structuredContent.reason_codes).not.toContain("TABLE_PROPOSAL_HEADER_UNSUPPORTED");

    // Incremental seeded catch delta: coverage/one-cell/order/header all pass
    // these two text-conserving proposals; only B3's geometry checks reject.
    for (const result of [inventedResult, mergeResult]) {
      expect(result.structuredContent.checks).toMatchObject({
        coverage: "passed",
        one_cell: "passed",
        row_non_straddle: "passed",
        row_order: "passed",
        column_order: "passed",
        header_evidence: "passed",
      });
    }
  }, 45_000);

  it("10. B3 refuses grid holes, overlaps, excessive slot surfaces, and evidence-free topology", () => {
    const region = {
      bbox: { x: 0, y: 0, width: 100, height: 100 },
      ruling_segments: [
        { orientation: "vertical", x1: 50, y1: 0, x2: 50, y2: 100, source_operator_index: 1 },
        { orientation: "horizontal", x1: 0, y1: 50, x2: 100, y2: 50, source_operator_index: 2 },
      ],
    };
    const itemById = new Map([
      ["i1", { id: "i1", bbox: { x: 10, y: 10, width: 10, height: 10 } }],
      ["i2", { id: "i2", bbox: { x: 60, y: 60, width: 10, height: 10 } }],
    ]);
    const hole = evaluateTableGridConsistency({
      region,
      itemById,
      cells: [
        { row: 0, column: 0, rowspan: 1, colspan: 1, item_ids: ["i1"] },
        { row: 1, column: 1, rowspan: 1, colspan: 1, item_ids: ["i2"] },
      ],
    });
    expect(hole.reasons).toEqual(["TABLE_PROPOSAL_GRID_INVALID"]);

    const overlap = evaluateTableGridConsistency({
      region,
      itemById,
      cells: [
        { row: 0, column: 0, rowspan: 1, colspan: 2, item_ids: ["i1"] },
        { row: 0, column: 1, rowspan: 1, colspan: 1, item_ids: ["i2"] },
      ],
    });
    expect(overlap.reasons).toEqual(["TABLE_PROPOSAL_GRID_INVALID"]);

    const excessive = evaluateTableGridConsistency({
      region,
      itemById,
      cells: [{ row: 0, column: 0, rowspan: 101, colspan: 100, item_ids: ["i1", "i2"] }],
    });
    expect(excessive.reasons).toEqual(["TABLE_PROPOSAL_GRID_INVALID"]);

    const ambiguous = evaluateTableGridConsistency({
      region: { ...region, ruling_segments: [] },
      itemById,
      cells: [{ row: 0, column: 0, rowspan: 1, colspan: 1, item_ids: ["i1", "i2"] }],
    });
    expect(ambiguous.reasons).toEqual(["TABLE_PROPOSAL_TOPOLOGY_AMBIGUOUS"]);
  });

  it("11. rejects caller-supplied text, geometry, and unknown top-level arguments", async () => {
    const textCells = structuredClone(borderlessCells);
    textCells[0].text = "invented";
    const textResult = await verify(BORDERLESS, borderlessPacket, borderlessToken, textCells);
    expect(textResult.isError).toBe(true);

    const geometryCells = structuredClone(borderlessCells);
    geometryCells[0].bbox = { x: 0, y: 0, width: 1, height: 1 };
    const geometryResult = await verify(BORDERLESS, borderlessPacket, borderlessToken, geometryCells);
    expect(geometryResult.isError).toBe(true);

    const unknownResult = await verify(
      BORDERLESS,
      borderlessPacket,
      borderlessToken,
      borderlessCells,
      { confidence: 0.99 },
    );
    expect(unknownResult.isError).toBe(true);
  }, 30_000);

  it("12. is deterministic across repeated full source replays", async () => {
    const first = await verify(BORDERLESS, borderlessPacket, borderlessToken, borderlessCells);
    const second = await verify(BORDERLESS, borderlessPacket, borderlessToken, borderlessCells);
    expect(JSON.stringify(second.structuredContent)).toBe(JSON.stringify(first.structuredContent));
  }, 30_000);
});
