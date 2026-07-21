import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import {
  JsonlArrivalCollector,
  buildBatchManifest,
  buildCodexArgs,
  buildFinalAnswerAnnotations,
  buildObserver,
  buildRunPlan,
  campaignCommitmentSha256,
  canonicalJson,
  classifyRunOutcome,
  diffManifests,
  fixtureInstanceRecord,
  sha256,
  validateCampaign,
} from "../../scripts/eval-run-codex-comparison.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SUITE_PATH = path.join(REPO_ROOT, "test", "fixtures", "eval", "trajectories", "jobs.v1.json");
const JOB_ID = "pdf-tools.trajectory.v1.compare-and-explain";
const BEFORE_SHA = "bca00ea1e9c27e45c58ace3a80d4df0a56db91c15c0e3d812fe3d22a925b2168";
const AFTER_SHA = "8dcb160b21f450a388de112767ad3a25b026f32bfd8064cfcc85e8825374b7e0";

function arrival(lineNumber, observedAt, event) {
  return {
    arrival_schema_version: 1,
    line_number: lineNumber,
    observed_at: observedAt,
    line_sha256: sha256(JSON.stringify(event)),
    event,
    parse_error: null,
  };
}

function callEvents(id, tool, args, structured, ordinal) {
  const startedAt = `2026-07-21T10:00:${String(ordinal * 2).padStart(2, "0")}.000Z`;
  const finishedAt = `2026-07-21T10:00:${String(ordinal * 2 + 1).padStart(2, "0")}.000Z`;
  return [{
    type: "item.started",
    item: { id, type: "mcp_tool_call", server: "pdf_tools", tool, arguments: args, status: "in_progress" },
  }, {
    type: "item.completed",
    item: {
      id,
      type: "mcp_tool_call",
      server: "pdf_tools",
      tool,
      arguments: args,
      status: "completed",
      error: null,
      result: { content: [{ type: "text", text: "ok" }], structured_content: structured },
    },
  }].map((event, index) => arrival(ordinal * 2 + index, index === 0 ? startedAt : finishedAt, event));
}

function successfulArrivals() {
  return [
    ...callEvents("read-before", "read_pdf_pages", {
      pdf_path: "input/before.pdf", start_page: 1, end_page: 1,
    }, { pages: [{ page: 1, text: "PAGE ONE - PORTRAIT" }] }, 1),
    ...callEvents("read-after", "read_pdf_pages", {
      pdf_path: "input/after.pdf", start_page: 1, end_page: 1,
    }, { pages: [{ page: 1, text: "PAGE TWO - ROTATED" }] }, 2),
    ...callEvents("render-before", "render_pdf_page", {
      pdf_path: "input/before.pdf", page: 1, max_dimension_px: 1200,
    }, {
      page: 1, width_points: 360, height_points: 480,
      rendered_width_px: 900, rendered_height_px: 1200, scale: 2.5,
      renderer: "native-canvas", mime_type: "image/png",
    }, 3),
    ...callEvents("render-after", "render_pdf_page", {
      pdf_path: "input/after.pdf", page: 1, max_dimension_px: 1200,
    }, {
      page: 1, width_points: 480, height_points: 360,
      rendered_width_px: 1200, rendered_height_px: 900, scale: 2.5,
      renderer: "native-canvas", mime_type: "image/png",
    }, 4),
  ];
}

function workspaceManifest(extraEntries = []) {
  const entries = [{ path: "downloads", mode: 0o755, type: "directory" },
    { path: "input", mode: 0o755, type: "directory" },
    { path: "input/after.pdf", mode: 0o444, type: "file", size: 2380, sha256: AFTER_SHA },
    { path: "input/before.pdf", mode: 0o444, type: "file", size: 2308, sha256: BEFORE_SHA },
    { path: "state", mode: 0o755, type: "directory" },
    { path: "state/backups", mode: 0o755, type: "directory" },
    { path: "state/signatures", mode: 0o755, type: "directory" },
    { path: "tmp", mode: 0o755, type: "directory" },
    ...extraEntries].sort((left, right) => left.path.localeCompare(right.path));
  return {
    manifest_schema_version: 1,
    entries,
    manifest_sha256: sha256(canonicalJson(entries)),
  };
}

describe("headless Codex comparison controller", () => {
  let suite;
  let job;
  let plan;

  beforeAll(async () => {
    suite = JSON.parse(await fs.readFile(SUITE_PATH, "utf8"));
    job = suite.jobs.find(item => item.id === JOB_ID);
    plan = buildRunPlan({
      suite,
      job,
      count: 3,
      trialSetId: "pdf-tools.trajectory.codex-comparison.test",
      plannedAt: "2026-07-21T09:59:00.000Z",
    });
  });

  it("freezes an exact three-entry denominator before launch", () => {
    expect(plan.entries).toHaveLength(3);
    expect(plan.entries.map(item => item.repeat_index)).toEqual([1, 2, 3]);
    expect(new Set(plan.entries.map(item => item.invocation_id)).size).toBe(3);
    expect(new Set(plan.entries.map(item => item.seed)).size).toBe(3);
    expect(new Set(plan.entries.map(item => item.fixture_instance_sha256))).toEqual(new Set([
      sha256(canonicalJson(fixtureInstanceRecord())),
    ]));
    expect(plan.suite_sha256).toBe(sha256(canonicalJson(suite)));
    expect(plan.entries[0].semantic_operation_sha256).toBe(sha256(canonicalJson(job.expected_semantics)));
    const pilot = buildRunPlan({
      suite,
      job,
      count: 1,
      trialSetId: "pdf-tools.trajectory.codex-comparison.pilot",
      plannedAt: "2026-07-21T09:59:00.000Z",
    });
    expect(pilot.entries).toHaveLength(1);
  });

  it("rejects campaign drift from the frozen plan before launch", () => {
    const campaign = {
      campaign_schema_version: 1,
      trial_set_id: plan.trial_set_id,
      suite_id: plan.suite_id,
      job_id: JOB_ID,
      count: 3,
      model: "gpt-5.6-sol",
      claim_boundary: plan.claim_boundary,
      created_at: plan.planned_at,
      timeout_ms: 900_000,
      codex_version: "codex-cli 0.144.6",
      node_runtime: { version: "v22.22.3", modules: "127", napi: "10", v8: "12" },
      git_commit: "a".repeat(40),
      suite_sha256: plan.suite_sha256,
      plan_sha256: sha256(canonicalJson(plan)),
      plan_raw_sha256: "b".repeat(64),
      fixture_instance_sha256: plan.entries[0].fixture_instance_sha256,
      source_fingerprints: {},
      runs: plan.entries.map(entry => ({
        repeat_index: entry.repeat_index,
        invocation_id: entry.invocation_id,
        directory: `runs/repeat-${String(entry.repeat_index).padStart(2, "0")}`,
        workspace_manifest_sha256: "c".repeat(64),
        input_sha256: "d".repeat(64),
      })),
    };
    campaign.launch_contract_sha256 = campaignCommitmentSha256(campaign);
    expect(() => validateCampaign(campaign, plan)).not.toThrow();
    for (const mutate of [
      candidate => { candidate.model = "different-model"; },
      candidate => { candidate.claim_boundary = "wider claim"; },
      candidate => { candidate.runs[0].invocation_id = "different-invocation"; },
      candidate => { candidate.runs[0].directory = "runs/repeat-99"; },
    ]) {
      const candidate = structuredClone(campaign);
      mutate(candidate);
      expect(() => validateCampaign(candidate, plan)).toThrow();
    }
  });

  it("constructs a fail-closed Codex command with only the PDF MCP tools enabled", () => {
    const workspace = "/home/mat/Documents/controller-test/runs/repeat-01/workspace";
    const args = buildCodexArgs({ workspace, model: "gpt-5.6-sol", serverPath: "/repo/server/index.js" });
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--ephemeral");
    expect(args).toContain("read-only");
    expect(args).toContain("project_doc_max_bytes=0");
    expect(args).toContain("mcp_servers.pdf_tools.enabled_tools=[\"read_pdf_pages\",\"render_pdf_page\"]");
    for (const feature of ["plugins", "shell_tool", "unified_exec", "browser_use", "computer_use", "multi_agent"]) {
      const index = args.findIndex((item, position) => item === "--disable" && args[position + 1] === feature);
      expect(index).toBeGreaterThanOrEqual(0);
    }
    expect(args.join(" ")).not.toContain("github");
    expect(args.join(" ")).not.toContain("playwright");
  });

  it("timestamps JSONL arrivals without losing chunk boundaries or parse failures", () => {
    const collector = new JsonlArrivalCollector();
    const first = collector.push('{"type":"thread.started","thread_id":"x"}\n{"type":"item.started",', "2026-07-21T10:00:00.000Z");
    expect(first).toHaveLength(1);
    const second = collector.push('"item":{"id":"item_1"}}\nnot-json', "2026-07-21T10:00:01.000Z");
    expect(second).toHaveLength(1);
    const tail = collector.finish("2026-07-21T10:00:02.000Z");
    expect(tail).toHaveLength(1);
    expect(collector.arrivals.map(item => item.line_number)).toEqual([1, 2, 3]);
    expect(collector.arrivals[1]).toMatchObject({
      observed_at: "2026-07-21T10:00:01.000Z",
      event: { type: "item.started", item: { id: "item_1" } },
      parse_error: null,
    });
    expect(collector.arrivals[2].event).toBeNull();
    expect(collector.arrivals[2].parse_error).toMatch(/JSON/);
  });

  it("classifies any completed PDF call as a product trial even after a bad process exit", () => {
    const arrivals = successfulArrivals();
    expect(classifyRunOutcome(arrivals)).toBe("completed");
    expect(classifyRunOutcome([arrival(1, "2026-07-21T10:00:00.000Z", {
      type: "item.completed", item: { id: "warning", type: "error", message: "warning" },
    })])).toBe("harness_failure");
  });

  it("binds four evidence records and one claim to exact successful result item IDs", () => {
    const annotations = buildFinalAnswerAnnotations(job, successfulArrivals());
    expect(annotations.evidence).toHaveLength(4);
    expect(annotations.evidence.map(item => item.result_item_id)).toEqual([
      "read-before", "read-after", "render-before", "render-after",
    ]);
    expect(annotations.evidence.filter(item => item.kind === "region").map(item => item.region)).toEqual([
      [0, 0, 360, 480],
      [0, 0, 480, 360],
    ]);
    expect(annotations.claims).toEqual([expect.objectContaining({
      important: true,
      evidence_ids: annotations.evidence.map(item => item.id),
    })]);
    expect(annotations.limitations.join(" ")).toMatch(/host-visible image/);
  });

  it("derives effects from independent pre/post manifests", () => {
    const before = workspaceManifest();
    const after = workspaceManifest([
      { path: "unexpected.txt", mode: 0o644, type: "file", size: 3, sha256: "a".repeat(64) },
    ]);
    expect(diffManifests(before, after)).toEqual({
      created: ["unexpected.txt"], modified: [], deleted: [],
    });
    const changed = structuredClone(before);
    changed.entries.find(item => item.path === "input/before.pdf").mode = 0o644;
    expect(diffManifests(before, changed).modified).toEqual(["input/before.pdf"]);
  });

  it("builds a strict observer and never relabels a product error as harness failure", () => {
    const campaign = {
      trial_set_id: plan.trial_set_id,
      suite_id: suite.suite_id,
      model: "gpt-5.6-sol",
      codex_version: "codex-cli 0.144.6",
      claim_boundary: plan.claim_boundary,
    };
    const manifest = workspaceManifest();
    const observer = buildObserver({
      campaign,
      plan,
      entry: plan.entries[0],
      job,
      arrivals: successfulArrivals(),
      preManifest: manifest,
      postManifest: manifest,
      preManifestRawSha256: "1".repeat(64),
      postManifestRawSha256: "2".repeat(64),
      planRawSha256: "3".repeat(64),
      stdoutSha256: "4".repeat(64),
      stderrSha256: "5".repeat(64),
      launcherRecordSha256: "6".repeat(64),
      startedAt: "2026-07-21T10:00:00.000Z",
      preObservedAt: "2026-07-21T10:00:01.000Z",
      effectsObservedAt: "2026-07-21T10:00:20.000Z",
      launcherObservedAt: "2026-07-21T10:00:21.000Z",
      finishedAt: "2026-07-21T10:00:22.000Z",
      exit: { exit_code: 1, signal: null, timed_out: false, spawn_error: null },
    });
    expect(observer.outcome).toBe("completed");
    expect(observer.harness_failure).toBeNull();
    expect(observer.call_observations["render-before"].observed_artifacts).toEqual([
      expect.objectContaining({ path: "input/before.pdf", sha256: BEFORE_SHA }),
    ]);
    expect(observer.run.events[0]).toMatchObject({
      type: "run_plan_committed",
      observed_at: observer.run.started_at,
      reference: `sha256:${sha256(canonicalJson(plan))}`,
    });
    expect(observer.effects).toMatchObject({ created: [], modified: [], deleted: [], external_requests: [] });
  });

  it("creates a harness record only when no PDF call completed", () => {
    const campaign = {
      trial_set_id: plan.trial_set_id,
      suite_id: suite.suite_id,
      model: "gpt-5.6-sol",
      codex_version: "codex-cli 0.144.6",
      claim_boundary: plan.claim_boundary,
    };
    const manifest = workspaceManifest();
    const observer = buildObserver({
      campaign,
      plan,
      entry: plan.entries[0],
      job,
      arrivals: [],
      preManifest: manifest,
      postManifest: manifest,
      preManifestRawSha256: "1".repeat(64),
      postManifestRawSha256: "2".repeat(64),
      planRawSha256: "3".repeat(64),
      stdoutSha256: "4".repeat(64),
      stderrSha256: "5".repeat(64),
      launcherRecordSha256: "6".repeat(64),
      startedAt: "2026-07-21T10:00:00.000Z",
      preObservedAt: "2026-07-21T10:00:01.000Z",
      effectsObservedAt: "2026-07-21T10:00:20.000Z",
      launcherObservedAt: "2026-07-21T10:00:21.000Z",
      finishedAt: "2026-07-21T10:00:22.000Z",
      exit: { exit_code: 7, signal: null, timed_out: false, spawn_error: null },
    });
    expect(observer.outcome).toBe("harness_failure");
    expect(observer.harness_failure).toMatchObject({ code: "codex_exit_7", phase: "host_session" });
    expect(observer.effects).toEqual({});
    expect(observer.call_observations).toEqual({});
  });

  it("builds a complete batch manifest from the frozen denominator", () => {
    const campaign = {
      runs: plan.entries.map(entry => ({
        directory: `runs/repeat-${String(entry.repeat_index).padStart(2, "0")}`,
      })),
    };
    expect(buildBatchManifest(campaign)).toEqual({
      runs: [1, 2, 3].map(repeat => ({
        raw: `runs/repeat-0${repeat}/codex.jsonl`,
        observer: `runs/repeat-0${repeat}/observer.json`,
      })),
    });
  });
});
