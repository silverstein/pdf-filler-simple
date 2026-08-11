import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  boundTableProposalRegions,
  buildTableProposalRegion,
  MAX_TABLE_PROPOSALS_PER_DOCUMENT,
  MAX_TABLE_PROPOSAL_TEXT_ITEMS,
  validateTableProposalGapCoverage,
} from "../server/markdown-conversion.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTELLIGENCE_ROOT = path.join(REPO_ROOT, "test/fixtures/eval/extraction/intelligence");

const MERGED = "table-ruled-merged-negative.pdf";
const LINES = "table-ruled-lines.pdf";
const GRID = "table-ruled-grid.pdf";
const RULED_FIXTURES = [MERGED, LINES, GRID];

function fixturePath(name) {
  return path.join(INTELLIGENCE_ROOT, name);
}

// The handler binds each region to (source sha256, IR version, region_id) with
// this exact canonical string, so the token is verifiable purely from
// payload-visible provenance fields.
function expectedToken(sha256, irVersion, regionId) {
  return createHash("sha256")
    .update([sha256, irVersion, regionId].join("\n"), "utf8")
    .digest("hex");
}

describe("verified-vision proposal-packet emission (B1)", () => {
  let client;
  let transport;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server/index.js")],
      cwd: REPO_ROOT,
      env: { ALLOWED_DIRECTORIES: REPO_ROOT },
      stderr: "ignore",
    });
    client = new Client({ name: "verified-vision-proposal-packet", version: "1.0.0" });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await transport?.close();
  });

  async function convert(name, extra = {}) {
    const result = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: fixturePath(name), max_markdown_bytes: 200000, ...extra },
    });
    expect(result.isError).not.toBe(true);
    return result;
  }

  it("1. default-off is byte-identical and additive on all three ruled fixtures", async () => {
    for (const name of RULED_FIXTURES) {
      const off = await convert(name);
      const on = await convert(name, { emit_table_proposals: true });

      // With the flag absent, the structured result carries no packet key at all.
      expect(Object.hasOwn(off.structuredContent, "table_proposals")).toBe(false);
      expect(Object.hasOwn(off.structuredContent, "table_proposals_truncation")).toBe(false);

      // Markdown and its digest are untouched by the opt-in flag.
      expect(on.structuredContent.markdown).toBe(off.structuredContent.markdown);
      expect(on.structuredContent.markdown_sha256).toBe(off.structuredContent.markdown_sha256);
      expect(on.structuredContent.gaps).toEqual(off.structuredContent.gaps);

      // The packet is purely additive: stripping it reproduces the default result.
      const {
        table_proposals: _packets,
        table_proposals_truncation: _proposalTruncation,
        ...onWithoutPackets
      } = on.structuredContent;
      expect(onWithoutPackets).toEqual(off.structuredContent);
    }
  }, 60_000);

  it("2. emits exactly one packet for the abandoned merged-span region", async () => {
    const on = await convert(MERGED, { emit_table_proposals: true });
    const packets = on.structuredContent.table_proposals;
    expect(Array.isArray(packets)).toBe(true);
    expect(packets).toHaveLength(1);

    const packet = packets[0];
    expect(packet.region_id).toBe("p1-t1");
    expect(packet.page).toBe(1);
    expect(packet.reason).toBe("TABLE_TOPOLOGY_UNKNOWN");
    expect(packet.coordinate_space).toBe("pdfjs_viewport_top_left_points");

    // Region bbox is finite and non-degenerate.
    for (const key of ["x", "y", "width", "height"]) {
      expect(Number.isFinite(packet.bbox[key])).toBe(true);
    }
    expect(packet.bbox.width).toBeGreaterThan(0);
    expect(packet.bbox.height).toBeGreaterThan(0);

    // The merged-span region's items, carrying the cell-assignment metadata B2 needs.
    expect(packet.text_items.length).toBeGreaterThan(0);
    expect(packet.text_items.map(item => item.text)).toContain("Status");
    for (const item of packet.text_items) {
      expect(typeof item.id).toBe("string");
      expect(typeof item.text).toBe("string");
      expect(Number.isInteger(item.reading_order_index)).toBe(true);
      expect(item.line_id === null || typeof item.line_id === "string").toBe(true);
      expect(item.column_index === null || Number.isInteger(item.column_index)).toBe(true);
      expect(item.bbox).not.toBeNull();
    }

    // Ruled evidence intersecting the region is present; painted evidence is empty here.
    expect(packet.ruled_rects.length).toBe(1);
    expect(packet.ruled_rects[0].verb).toBe("stroke");
    expect(packet.ruling_segments).toContainEqual({
      orientation: "vertical",
      x1: 372,
      y1: 160,
      x2: 372,
      y2: 304,
      source_operator_index: 19,
    });
    expect(packet.ruling_segments).not.toContainEqual(expect.objectContaining({
      orientation: "vertical",
      x1: 372,
      y1: 112,
      y2: 304,
    }));
    expect(packet.painted_rectangles).toEqual([]);

    // Header hints ship the IR's own first-row-band signal, not a decision.
    expect(packet.header_hints.status).toBe("available");
    expect(["taller_than_body", "not_distinguished", "unavailable"]).toContain(
      packet.header_hints.first_row_band,
    );

    // Bounded, typed truncation status (not truncated for this small region).
    expect(packet.truncation).toEqual({
      text_items: "complete",
      ruled_rects: "complete",
      ruling_segments: "complete",
      painted_rectangles: "complete",
    });
    expect(on.structuredContent.table_proposals_truncation).toEqual({
      status: "complete",
      observed_regions: 1,
      returned_regions: 1,
      omitted_regions: 0,
    });

    // The token is present and well-formed.
    expect(packet.proposal_token).toMatch(/^[a-f0-9]{64}$/);

    // The abstention gap still fires unchanged alongside the packet.
    expect(on.structuredContent.gaps.map(gap => gap.code)).toEqual([
      "TABLE_TOPOLOGY_UNKNOWN",
      "VECTOR_CONTENT_NOT_INTERPRETED",
    ]);
  }, 30_000);

  it("2b. preserves the authored full-height cut in the ordinary line-ruled packet", async () => {
    const on = await convert(LINES, { emit_table_proposals: true });
    expect(on.structuredContent.table_proposals[0].ruling_segments).toContainEqual({
      orientation: "vertical",
      x1: 372,
      y1: 112,
      x2: 372,
      y2: 304,
      source_operator_index: 19,
    });
  }, 30_000);

  it("3. emits zero packets for the fixture that reconstructs", async () => {
    const on = await convert(GRID, { emit_table_proposals: true });
    expect(on.structuredContent.table_proposals).toEqual([]);
    expect(on.structuredContent.table_proposals_truncation).toEqual({
      status: "complete",
      observed_regions: 0,
      returned_regions: 0,
      omitted_regions: 0,
    });
    // Confirm this is the success path: the markdown carries a reconstructed table.
    expect(on.structuredContent.markdown.split("\n").some(line => /^\|.*\|$/.test(line))).toBe(true);
  }, 30_000);

  it("4. proposal_token is a pure function of source sha, IR version, and region_id", async () => {
    const merged = await convert(MERGED, { emit_table_proposals: true });
    const lines = await convert(LINES, { emit_table_proposals: true });

    const mergedPacket = merged.structuredContent.table_proposals[0];
    const linesPacket = lines.structuredContent.table_proposals[0];

    const mergedSha = merged.structuredContent.provenance.source.sha256;
    const mergedVer = merged.structuredContent.provenance.layout.version;
    const linesSha = lines.structuredContent.provenance.source.sha256;
    const linesVer = lines.structuredContent.provenance.layout.version;

    // Pure: recomputable from payload-visible provenance + region_id.
    expect(mergedPacket.proposal_token).toBe(
      expectedToken(mergedSha, mergedVer, mergedPacket.region_id),
    );
    expect(linesPacket.proposal_token).toBe(
      expectedToken(linesSha, linesVer, linesPacket.region_id),
    );

    // Stable across a second run of the same document.
    const mergedAgain = await convert(MERGED, { emit_table_proposals: true });
    expect(mergedAgain.structuredContent.table_proposals[0].proposal_token).toBe(
      mergedPacket.proposal_token,
    );

    // Differs across fixtures even though both regions share region_id p1-t1,
    // because the bound source sha256 differs.
    expect(mergedPacket.region_id).toBe(linesPacket.region_id);
    expect(mergedSha).not.toBe(linesSha);
    expect(mergedPacket.proposal_token).not.toBe(linesPacket.proposal_token);
  }, 60_000);

  it("5. is deterministic: two runs produce byte-identical packet JSON", async () => {
    const first = await convert(MERGED, { emit_table_proposals: true });
    const second = await convert(MERGED, { emit_table_proposals: true });
    expect(JSON.stringify(second.structuredContent.table_proposals)).toBe(
      JSON.stringify(first.structuredContent.table_proposals),
    );
  }, 30_000);

  it("6. bounds an over-cap region with typed truncation, not unbounded items", () => {
    // A synthetic run whose lines carry more items than the per-region cap. The
    // pure builder is exercised directly so the bound is proven without
    // synthesizing a fully validated IR.
    const total = MAX_TABLE_PROPOSAL_TEXT_ITEMS + 50;
    const makeItem = (index, lineId) => ({
      id: `i${index}`,
      text: `t${index}`,
      reading_order_index: index,
      line_id: lineId,
      column_index: 0,
      geometry_valid: true,
      text_kind: "non_whitespace",
      bbox: { x: 10 + index, y: 100, width: 5, height: 12 },
      quad: [
        { x: 10 + index, y: 100 },
        { x: 15 + index, y: 100 },
        { x: 10 + index, y: 112 },
        { x: 15 + index, y: 112 },
      ],
      raw_transform: [12, 0, 0, 12, 10 + index, 100],
      line_height: 12,
    });
    const perLine = Math.ceil(total / 2);
    const firstLineItems = Array.from({ length: perLine }, (_value, index) => makeItem(index, "L1"));
    const secondLineItems = Array.from(
      { length: total - perLine },
      (_value, index) => makeItem(perLine + index, "L2"),
    );
    const firstLine = {
      id: "L1",
      x: 10,
      y: 100,
      width: 300,
      height: 12,
      item_ids: firstLineItems.map(item => item.id),
    };
    const secondLine = {
      id: "L2",
      x: 10,
      y: 120,
      width: 300,
      height: 12,
      item_ids: secondLineItems.map(item => item.id),
    };
    const page = {
      page: 1,
      raw_items: [...firstLineItems, ...secondLineItems],
      ruled_rects: { items: [] },
      painted_rectangles: { items: [] },
      lines: [firstLine, secondLine],
    };
    const run = [
      { line: firstLine, cells: firstLineItems },
      { line: secondLine, cells: secondLineItems },
    ];

    const region = buildTableProposalRegion(page, run, "topology", 1);
    expect(region.region_id).toBe("p1-t1");
    expect(region.text_items).toHaveLength(MAX_TABLE_PROPOSAL_TEXT_ITEMS);
    expect(region.truncation.text_items).toBe("truncated");
    // The retained items are the first cap-many in reading order, never sampled.
    expect(region.text_items[0].id).toBe("i0");
    expect(region.text_items.at(-1).id).toBe(`i${MAX_TABLE_PROPOSAL_TEXT_ITEMS - 1}`);
  });

  it("7. reports document-level omission instead of silently dropping over-cap regions", () => {
    const observed = Array.from(
      { length: MAX_TABLE_PROPOSALS_PER_DOCUMENT + 3 },
      (_value, index) => ({ region_id: `p1-t${index + 1}` }),
    );
    const bounded = boundTableProposalRegions(observed);
    expect(bounded.regions).toEqual(observed.slice(0, MAX_TABLE_PROPOSALS_PER_DOCUMENT));
    expect(bounded.truncation).toEqual({
      status: "truncated",
      observed_regions: MAX_TABLE_PROPOSALS_PER_DOCUMENT + 3,
      returned_regions: MAX_TABLE_PROPOSALS_PER_DOCUMENT,
      omitted_regions: 3,
    });
  });

  it("8. fails closed if an abandonment gap has no source-bound proposal region", () => {
    const gaps = [{ code: "TABLE_TOPOLOGY_UNKNOWN", page: 2, message: "abandoned" }];
    expect(() => validateTableProposalGapCoverage(gaps, []))
      .toThrow("table abandonment gaps lack proposal regions on pages 2");
    expect(() => validateTableProposalGapCoverage(gaps, [{ page: 2 }])).not.toThrow();
  });
});
