import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  generateVerifiedVisionFixtures,
  VERIFIED_VISION_FIXTURE_FILES,
} from "../scripts/eval-generate-verified-vision-fixtures.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_ROOT = path.join(REPO_ROOT, "test", "fixtures", "eval", "verified-vision");
const MANIFEST_PATH = path.join(FIXTURE_ROOT, "manifest.v1.json");
const PROPOSALS_PATH = path.join(FIXTURE_ROOT, "known-proposals.v1.json");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixtureTexts(fixture) {
  if (Array.isArray(fixture.truth.rows)) return fixture.truth.rows.flat();
  if (Array.isArray(fixture.truth.source_rows)) return fixture.truth.source_rows.flat();
  return fixture.truth.cells.flatMap(cell => cell.texts);
}

function occurrenceRefs(texts) {
  const counts = new Map();
  return texts.map(text => {
    const occurrence = (counts.get(text) ?? 0) + 1;
    counts.set(text, occurrence);
    return `${text}\u0000${occurrence}`;
  });
}

function proposalRefs(proposal) {
  return proposal.cells.flatMap(cell => cell.item_refs.map(
    item => `${item.text}\u0000${item.occurrence}`,
  ));
}

function coverageVerdict(proposal, fixture) {
  const sourceRefs = occurrenceRefs(fixtureTexts(fixture));
  const assignedRefs = proposalRefs(proposal);
  return {
    unique: new Set(assignedRefs).size === assignedRefs.length,
    complete: JSON.stringify([...assignedRefs].sort()) === JSON.stringify([...sourceRefs].sort()),
  };
}

function cellsFromRows(rows) {
  return rows.flatMap((row, rowIndex) => row.map((text, columnIndex) => ({
    row: rowIndex,
    column: columnIndex,
    rowspan: 1,
    colspan: 1,
    item_refs: [{ text, occurrence: 1 }],
  })));
}

function topologySignature({ row_count: rowCount, column_count: columnCount, cells }) {
  return JSON.stringify({
    row_count: rowCount,
    column_count: columnCount,
    cells: cells.map(cell => ({
      row: cell.row,
      column: cell.column,
      rowspan: cell.rowspan,
      colspan: cell.colspan,
      item_refs: cell.item_refs,
    })),
  });
}

describe("verified-vision B0 adversarial baseline", () => {
  let client;
  let transport;
  let manifest;
  let proposalManifest;

  beforeAll(async () => {
    [manifest, proposalManifest] = await Promise.all([
      fs.readFile(MANIFEST_PATH, "utf8").then(JSON.parse),
      fs.readFile(PROPOSALS_PATH, "utf8").then(JSON.parse),
    ]);
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server", "index.js")],
      cwd: REPO_ROOT,
      env: { ALLOWED_DIRECTORIES: REPO_ROOT },
      stderr: "ignore",
    });
    client = new Client({ name: "verified-vision-b0-baseline", version: "1.0.0" });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await transport?.close();
  });

  it("binds three synthetic born-digital fixtures to exact provenance and digests", async () => {
    expect(manifest.manifest_version).toBe(1);
    expect(manifest.suite_id).toBe("pdf-tools.verified-vision.baseline");
    expect(manifest.generator).toBe("scripts/eval-generate-verified-vision-fixtures.mjs");
    expect(manifest.proposal_manifest).toBe("known-proposals.v1.json");
    expect(sha256(await fs.readFile(PROPOSALS_PATH))).toBe(manifest.proposal_manifest_sha256);
    expect(manifest.claim_boundary).toEqual(expect.objectContaining({
      benchmark_claim_ready: false,
      calibration_claim_ready: false,
      production_claim_ready: false,
      born_digital_only: true,
    }));
    expect(manifest.fixtures.map(fixture => fixture.path)).toEqual(VERIFIED_VISION_FIXTURE_FILES);
    for (const fixture of manifest.fixtures) {
      expect(fixture.provenance.kind).toBe("synthetic");
      expect(fixture.provenance.source_url).toBeNull();
      expect(fixture.license).toMatchObject({ spdx_id: "MIT", redistribution: "allowed" });
      expect(fixture.privacy).toEqual({ class: "synthetic", contains_personal_data: false });
      const bytes = await fs.readFile(path.join(FIXTURE_ROOT, fixture.path));
      expect(bytes).toHaveLength(fixture.bytes);
      expect(sha256(bytes)).toBe(fixture.sha256);
    }
  });

  it("regenerates every PDF byte-identically in two independent directories", async () => {
    const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-verified-vision-first-"));
    const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-verified-vision-second-"));
    try {
      expect(await generateVerifiedVisionFixtures(firstRoot)).toEqual(VERIFIED_VISION_FIXTURE_FILES);
      expect(await generateVerifiedVisionFixtures(secondRoot)).toEqual(VERIFIED_VISION_FIXTURE_FILES);
      for (const filename of VERIFIED_VISION_FIXTURE_FILES) {
        const [committed, first, second] = await Promise.all([
          fs.readFile(path.join(FIXTURE_ROOT, filename)),
          fs.readFile(path.join(firstRoot, filename)),
          fs.readFile(path.join(secondRoot, filename)),
        ]);
        expect(first.equals(committed), filename).toBe(true);
        expect(second.equals(first), filename).toBe(true);
      }
    } finally {
      await Promise.all([
        fs.rm(firstRoot, { recursive: true, force: true }),
        fs.rm(secondRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it("freezes current mainline abstention and never mistakes it for recovery", async () => {
    for (const fixture of manifest.fixtures) {
      const layout = await client.callTool({
        name: "read_pdf_layout",
        arguments: {
          pdf_path: path.join(FIXTURE_ROOT, fixture.path),
          max_output_characters: 200000,
        },
      });
      const result = await client.callTool({
        name: "convert_pdf_to_markdown",
        arguments: {
          pdf_path: path.join(FIXTURE_ROOT, fixture.path),
          max_markdown_bytes: 200000,
        },
      });
      expect(layout.isError).not.toBe(true);
      expect(layout.structuredContent.pages[0].raw_items
        .filter(item => item.text_kind === "non_whitespace")
        .sort((left, right) => left.reading_order_index - right.reading_order_index)
        .map(item => item.text)).toEqual(fixtureTexts(fixture));
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent.conversion_status).toBe(fixture.expected_current.conversion_status);
      expect(result.structuredContent.gaps.map(gap => gap.code)).toEqual(fixture.expected_current.gap_codes);
      expect(result.structuredContent.gaps.some(
        gap => gap.message.includes(fixture.expected_current.message_contains),
      )).toBe(true);
      expect(result.structuredContent.markdown).not.toMatch(/^\|.*\|$/m);
      expect(fixture.expected_current.table_reconstructed).toBe(false);
    }
  }, 60_000);

  it("carries the required correct, wrong, and ambiguous proposal classes", () => {
    expect(proposalManifest.proposal_manifest_version).toBe(1);
    expect(proposalManifest.proposals).toHaveLength(6);
    expect(proposalManifest.proposals.map(proposal => proposal.adversarial_class)).toEqual([
      "recoverable_control",
      "wrong_merged_header_topology",
      "wrong_column_merge",
      "wrong_row_split",
      "ambiguous_topology_candidate",
      "ambiguous_topology_candidate",
    ]);
    expect(proposalManifest.proposals.map(proposal => proposal.expected_verifier_outcome)).toEqual([
      "accepted",
      "rejected",
      "rejected",
      "rejected",
      "rejected",
      "rejected",
    ]);
    expect(proposalManifest.proposals[0].acceptance_prerequisites).toContain("pdf-toolkit-mcp-14o.8");
    expect(proposalManifest.proposals[1].rejection_evidence_prerequisite).toBe("pdf-toolkit-mcp-14o.8");
  });

  it("proves every proposal conserves all source text exactly once", () => {
    const fixtures = new Map(manifest.fixtures.map(fixture => [fixture.id, fixture]));
    for (const proposal of proposalManifest.proposals) {
      const fixture = fixtures.get(proposal.fixture_id);
      expect(fixture, proposal.fixture_id).toBeDefined();
      expect(proposal.text_conservation).toBe("required");
      expect(coverageVerdict(proposal, fixture), proposal.id).toEqual({ unique: true, complete: true });

      const occupied = new Set();
      for (const cell of proposal.cells) {
        expect(Number.isInteger(cell.row) && cell.row >= 0).toBe(true);
        expect(Number.isInteger(cell.column) && cell.column >= 0).toBe(true);
        expect(Number.isInteger(cell.rowspan) && cell.rowspan >= 1).toBe(true);
        expect(Number.isInteger(cell.colspan) && cell.colspan >= 1).toBe(true);
        expect(cell.row + cell.rowspan).toBeLessThanOrEqual(proposal.row_count);
        expect(cell.column + cell.colspan).toBeLessThanOrEqual(proposal.column_count);
        for (let row = cell.row; row < cell.row + cell.rowspan; row += 1) {
          for (let column = cell.column; column < cell.column + cell.colspan; column += 1) {
            const slot = `${row}:${column}`;
            expect(occupied.has(slot), `${proposal.id} overlapping slot ${slot}`).toBe(false);
            occupied.add(slot);
          }
        }
      }
      expect(occupied.size, `${proposal.id} rectangular grid coverage`).toBe(
        proposal.row_count * proposal.column_count,
      );
    }
  });

  it("fails its own coverage predicate for seeded drop and duplicate mutations", () => {
    const fixtures = new Map(manifest.fixtures.map(fixture => [fixture.id, fixture]));
    const control = proposalManifest.proposals[0];
    const fixture = fixtures.get(control.fixture_id);
    const dropped = structuredClone(control);
    dropped.cells[0].item_refs = [];
    expect(coverageVerdict(dropped, fixture)).toEqual({ unique: true, complete: false });

    const duplicated = structuredClone(control);
    duplicated.cells[1].item_refs.push(structuredClone(duplicated.cells[0].item_refs[0]));
    expect(coverageVerdict(duplicated, fixture)).toEqual({ unique: false, complete: false });
  });

  it("separates text conservation from known topology truth", () => {
    const fixtures = new Map(manifest.fixtures.map(fixture => [fixture.id, fixture]));
    const byId = new Map(proposalManifest.proposals.map(proposal => [proposal.id, proposal]));
    const merged = fixtures.get("pdf-tools.verified-vision.table-ruled-merged-negative");
    const mergedTruth = topologySignature({
      row_count: merged.truth.row_count,
      column_count: merged.truth.column_count,
      cells: merged.truth.cells.map(cell => ({
        ...cell,
        item_refs: cell.texts.map(text => ({ text, occurrence: 1 })),
      })),
    });
    expect(topologySignature(byId.get("merged-span-authored-control"))).toBe(mergedTruth);
    expect(topologySignature(byId.get("merged-span-invented-header-cut"))).not.toBe(mergedTruth);

    const lines = fixtures.get("pdf-tools.verified-vision.table-ruled-lines");
    const lineTruth = topologySignature({
      row_count: lines.truth.rows.length,
      column_count: lines.truth.rows[0].length,
      cells: cellsFromRows(lines.truth.rows),
    });
    expect(topologySignature(byId.get("line-table-column-merge"))).not.toBe(lineTruth);
    expect(topologySignature(byId.get("line-table-row-split"))).not.toBe(lineTruth);
  });

  it("keeps materially different borderless proposals rejected under abstention truth", () => {
    const fixture = manifest.fixtures.find(item => (
      item.id === "pdf-tools.verified-vision.table-borderless-ambiguous"
    ));
    const candidates = proposalManifest.proposals.filter(proposal => proposal.fixture_id === fixture.id);
    expect(fixture.truth.status).toBe("abstention");
    expect(fixture.expected_current.permanent_abstention).toBe(true);
    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map(topologySignature)).size).toBe(2);
    expect(candidates.every(proposal => proposal.topology_truth === "unresolved_by_source")).toBe(true);
    expect(candidates.every(proposal => proposal.expected_verifier_outcome === "rejected")).toBe(true);
  });
});
