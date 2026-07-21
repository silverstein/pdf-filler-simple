import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  JsonlArrivalCollector,
  buildBatchManifest,
  buildCallObservations,
  buildCodexArgs,
  buildFinalAnswerAnnotations,
  buildLaunchEnvironment,
  buildObserver,
  buildRunPlan,
  campaignCommitmentSha256,
  canonicalJson,
  classifyRunOutcome,
  captureLaunchEnvironment,
  diffManifests,
  fixtureInstanceRecord,
  finalizeCampaign,
  fingerprintResolvedPackageClosure,
  fingerprintRuntimeTree,
  planCampaign,
  runCampaignEntry,
  sha256,
  validateCampaign,
} from "../../scripts/eval-run-codex-comparison.mjs";
import { createTestTempDirectory, removeTestTempDirectory } from "../helpers/temp-directory.js";
import { renderTrustedFixturePng } from "./render-visual-oracle.js";

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

async function writeFakeCodex(filename, {
  timeout = false, completeThenTimeout = false, successfulCalls = false,
} = {}) {
  const answer = JSON.stringify({
    before_page_1: "PAGE ONE - PORTRAIT",
    after_page_1: "PAGE TWO - ROTATED",
    changed: true,
  });
  let events = [
    { type: "thread.started", thread_id: "fake-thread" },
    { type: "turn.started" },
    { type: "item.started", item: { id: "answer-1", type: "agent_message", status: "in_progress" } },
    { type: "item.completed", item: { id: "answer-1", type: "agent_message", status: "completed", text: answer } },
    { type: "turn.completed", usage: {} },
  ];
  if (successfulCalls) {
    const beforeSha256 = "bca00ea1e9c27e45c58ace3a80d4df0a56db91c15c0e3d812fe3d22a925b2168";
    const afterSha256 = "8dcb160b21f450a388de112767ad3a25b026f32bfd8064cfcc85e8825374b7e0";
    const [beforeImage, afterImage] = await Promise.all([
      renderTrustedFixturePng({ sourceSha256: beforeSha256, page: 1, scale: 2.5 }),
      renderTrustedFixturePng({ sourceSha256: afterSha256, page: 1, scale: 2.5 }),
    ]);
    const calls = [{
      id: "read-before",
      tool: "read_pdf_pages",
      arguments: { pdf_path: "input/before.pdf", start_page: 1, end_page: 1 },
      result: {
        content: [{ type: "text", text: "PAGE ONE - PORTRAIT" }],
        structured_content: { pages: [{ page: 1, text: "PAGE ONE - PORTRAIT" }] },
      },
    }, {
      id: "read-after",
      tool: "read_pdf_pages",
      arguments: { pdf_path: "input/after.pdf", start_page: 1, end_page: 1 },
      result: {
        content: [{ type: "text", text: "PAGE TWO - ROTATED" }],
        structured_content: { pages: [{ page: 1, text: "PAGE TWO - ROTATED" }] },
      },
    }, {
      id: "render-before",
      tool: "render_pdf_page",
      arguments: { pdf_path: "input/before.pdf", page: 1, max_dimension_px: 1200 },
      result: {
        content: [
          { type: "text", text: "Rendered before" },
          { type: "image", mimeType: "image/png", data: beforeImage.png.toString("base64") },
        ],
        structured_content: {
          page: 1, width_points: 360, height_points: 480,
          rendered_width_px: 900, rendered_height_px: 1200, scale: 2.5,
          renderer: "native-canvas", mime_type: "image/png",
        },
      },
    }, {
      id: "render-after",
      tool: "render_pdf_page",
      arguments: { pdf_path: "input/after.pdf", page: 1, max_dimension_px: 1200 },
      result: {
        content: [
          { type: "text", text: "Rendered after" },
          { type: "image", mimeType: "image/png", data: afterImage.png.toString("base64") },
        ],
        structured_content: {
          page: 1, width_points: 480, height_points: 360,
          rendered_width_px: 1200, rendered_height_px: 900, scale: 2.5,
          renderer: "native-canvas", mime_type: "image/png",
        },
      },
    }];
    events = [{ type: "thread.started", thread_id: "fake-thread" }, { type: "turn.started" }];
    for (const call of calls) {
      events.push({
        type: "item.started",
        item: {
          id: call.id, type: "mcp_tool_call", server: "pdf_tools", tool: call.tool,
          arguments: call.arguments, status: "in_progress",
        },
      }, {
        type: "item.completed",
        item: {
          id: call.id, type: "mcp_tool_call", server: "pdf_tools", tool: call.tool,
          arguments: call.arguments, status: "completed", error: null, result: call.result,
        },
      });
    }
    events.push(
      { type: "item.started", item: { id: "answer-1", type: "agent_message", status: "in_progress" } },
      { type: "item.completed", item: { id: "answer-1", type: "agent_message", status: "completed", text: answer } },
      { type: "turn.completed", usage: {} },
    );
  }
  const body = timeout
    ? `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli fake-timeout-1.0\\n");
} else {
  if (process.env.PDF_TOOLS_FORCE_SYSTEM_RENDERER) process.exit(91);
  const events = ${JSON.stringify(events)};
  if (${completeThenTimeout}) for (const event of events) process.stdout.write(JSON.stringify(event) + "\\n");
  setTimeout(() => {}, 60_000);
}
`
    : `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli fake-1.0\\n");
} else {
  if (process.env.PDF_TOOLS_FORCE_SYSTEM_RENDERER) process.exit(91);
  const events = ${JSON.stringify(events)};
  for (const event of events) process.stdout.write(JSON.stringify(event) + "\\n");
}
`;
  await fs.writeFile(filename, body, { mode: 0o700 });
  await fs.chmod(filename, 0o700);
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
      codex_executable: "/usr/bin/codex",
      codex_version: "codex-cli 0.144.6",
      node_runtime: { version: "v22.22.3", modules: "127", napi: "10", v8: "12" },
      runtime_fingerprints: {},
      environment_contract: captureLaunchEnvironment(),
      git_commit: "a".repeat(40),
      suite_sha256: plan.suite_sha256,
      plan_sha256: sha256(canonicalJson(plan)),
      plan_raw_sha256: "b".repeat(64),
      fixture_instance_sha256: plan.entries[0].fixture_instance_sha256,
      source_fingerprints: { "package.json": "9".repeat(64) },
      runs: plan.entries.map(entry => ({
        repeat_index: entry.repeat_index,
        invocation_id: entry.invocation_id,
        directory: `runs/repeat-${String(entry.repeat_index).padStart(2, "0")}`,
        workspace_manifest_sha256: "c".repeat(64),
        workspace_manifest_raw_sha256: "e".repeat(64),
        input_sha256: "d".repeat(64),
        prompt_sha256: "f".repeat(64),
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

    const emptyFingerprints = structuredClone(campaign);
    emptyFingerprints.source_fingerprints = {};
    emptyFingerprints.launch_contract_sha256 = campaignCommitmentSha256(emptyFingerprints);
    expect(() => validateCampaign(emptyFingerprints, plan))
      .toThrow("Campaign source fingerprints must be a non-empty safe SHA-256 map");

    const unsafeFingerprint = structuredClone(campaign);
    unsafeFingerprint.source_fingerprints = { "../outside": "9".repeat(64) };
    unsafeFingerprint.launch_contract_sha256 = campaignCommitmentSha256(unsafeFingerprint);
    expect(() => validateCampaign(unsafeFingerprint, plan))
      .toThrow("Campaign source fingerprints must be a non-empty safe SHA-256 map");
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

  it("preserves UTF-8 characters split across stdout buffer chunks", () => {
    const collector = new JsonlArrivalCollector();
    const line = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "café ✅" } });
    const bytes = Buffer.from(`${line}\n`, "utf8");
    const splitAt = bytes.indexOf(Buffer.from("✅")) + 1;
    expect(collector.push(bytes.subarray(0, splitAt), "2026-07-21T10:00:00.000Z")).toHaveLength(0);
    expect(collector.push(bytes.subarray(splitAt), "2026-07-21T10:00:01.000Z")).toHaveLength(1);
    expect(collector.finish()).toHaveLength(0);
    expect(collector.arrivals[0]).toMatchObject({
      line_sha256: sha256(line),
      event: { item: { text: "café ✅" } },
      parse_error: null,
    });
  });

  it("classifies any completed PDF call as a product trial even after a bad process exit", () => {
    const arrivals = successfulArrivals();
    expect(classifyRunOutcome(arrivals, { exit_code: 7 })).toBe("completed");
    expect(classifyRunOutcome([arrival(1, "2026-07-21T10:00:00.000Z", {
      type: "item.completed", item: { id: "warning", type: "error", message: "warning" },
    })])).toBe("harness_failure");
    const completedNoToolTurn = [arrival(1, "2026-07-21T10:00:00.000Z", {
      type: "turn.completed", usage: {},
    })];
    expect(classifyRunOutcome(completedNoToolTurn, { exit_code: 0 })).toBe("completed");
    expect(classifyRunOutcome(completedNoToolTurn, { exit_code: null, timed_out: true }))
      .toBe("completed");
  });

  it("requires started and completed call identities to agree before recording observations", () => {
    const arrivals = successfulArrivals();
    const started = arrivals.find(item => item.event?.type === "item.started"
      && item.event.item.id === "read-before");
    started.event.item.arguments = { ...started.event.item.arguments, end_page: 2 };
    const sourceObservations = new Map([
      ["input/before.pdf", { snapshot: { path: "input/before.pdf" } }],
      ["input/after.pdf", { snapshot: { path: "input/after.pdf" } }],
    ]);
    const observations = buildCallObservations(arrivals, sourceObservations);
    expect(observations).not.toHaveProperty("read-before");
    expect(observations).toHaveProperty("read-after");
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
      launchClaimRawSha256: "7".repeat(64),
      launcherStartRawSha256: "8".repeat(64),
      arrivalsRawSha256: "9".repeat(64),
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
      launchClaimRawSha256: "7".repeat(64),
      launcherStartRawSha256: "8".repeat(64),
      arrivalsRawSha256: "9".repeat(64),
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

describe("headless Codex comparison controller integration", () => {
  let testRoot;
  let documentsRoot;
  let fakeCodex;

  beforeAll(async () => {
    testRoot = await createTestTempDirectory(REPO_ROOT, "codex-controller");
    documentsRoot = path.join(testRoot, "documents");
    await fs.mkdir(documentsRoot);
    fakeCodex = path.join(testRoot, "fake-codex.mjs");
    await writeFakeCodex(fakeCodex);
  });

  afterAll(async () => {
    await removeTestTempDirectory(testRoot);
  });

  async function planOne(name, executable = fakeCodex, timeoutMs = 5_000) {
    return planCampaign({
      campaignPath: path.join(documentsRoot, name),
      count: 1,
      model: "fake-model",
      timeoutMs,
      documentsRoot,
      codexExecutable: executable,
    });
  }

  it("replays plan through claim, fake process, observer, and final grading", async () => {
    const { campaignRoot } = await planOne("complete-no-tool-turn");
    process.env.PDF_TOOLS_FORCE_SYSTEM_RENDERER = "1";
    let completed;
    try {
      completed = await runCampaignEntry({ campaignPath: campaignRoot, repeatIndex: 1, documentsRoot });
    } finally {
      delete process.env.PDF_TOOLS_FORCE_SYSTEM_RENDERER;
    }
    expect(completed.observer.outcome).toBe("completed");
    expect(completed.launcherRecord.completed_pdf_call_count).toBe(0);

    const sentinel = path.join(testRoot, "output-symlink-sentinel.txt");
    await fs.writeFile(sentinel, "preserve-me\n");
    await fs.symlink(sentinel, path.join(campaignRoot, "measured-trials.json"));
    const finalized = await finalizeCampaign(campaignRoot, { documentsRoot });
    expect(finalized.report).toMatchObject({
      attempted_trials: 1,
      product_trials: 1,
      harness_failures: 0,
      passed_trials: 0,
    });
    expect(await fs.readFile(sentinel, "utf8")).toBe("preserve-me\n");
    const measuredStat = await fs.lstat(path.join(campaignRoot, "measured-trials.json"));
    expect(measuredStat.isFile()).toBe(true);
    expect(measuredStat.isSymbolicLink()).toBe(false);

    await fs.appendFile(path.join(campaignRoot, "runs", "repeat-01", "jsonl-arrivals.jsonl"), "{}\n");
    await expect(finalizeCampaign(campaignRoot, { documentsRoot })).rejects.toThrow(
      /arrival ledger does not cover the raw transcript denominator/,
    );
  }, 30_000);

  it("changes a deterministic runtime-tree commitment after transitive file mutation", async () => {
    const tree = path.join(testRoot, "runtime-tree");
    await fs.mkdir(path.join(tree, "nested"), { recursive: true });
    await fs.writeFile(path.join(tree, "entry.js"), "export const value = 1;\n");
    await fs.writeFile(path.join(tree, "nested", "runtime.js"), "export const nested = 1;\n");
    const before = await fingerprintRuntimeTree(tree);
    await fs.writeFile(path.join(tree, "nested", "runtime.js"), "export const nested = 2;\n");
    const after = await fingerprintRuntimeTree(tree);
    expect(after.tree_sha256).not.toBe(before.tree_sha256);
    expect(after.file_count).toBe(before.file_count);
  });

  it("binds a hoisted runtime dependency into the resolved package closure", async () => {
    const modules = path.join(testRoot, "hoisted-runtime", "node_modules");
    const rootPackage = path.join(modules, "root-runtime");
    const dependencyPackage = path.join(modules, "hoisted-runtime-dependency");
    await fs.mkdir(rootPackage, { recursive: true });
    await fs.mkdir(dependencyPackage, { recursive: true });
    await fs.writeFile(path.join(rootPackage, "package.json"), JSON.stringify({
      name: "root-runtime",
      version: "1.0.0",
      main: "index.js",
      dependencies: { "hoisted-runtime-dependency": "1.0.0" },
    }));
    await fs.writeFile(path.join(rootPackage, "index.js"), "module.exports = require('hoisted-runtime-dependency');\n");
    await fs.writeFile(path.join(dependencyPackage, "package.json"), JSON.stringify({
      name: "hoisted-runtime-dependency",
      version: "1.0.0",
      main: "index.js",
    }));
    await fs.writeFile(path.join(dependencyPackage, "index.js"), "module.exports = 1;\n");

    const before = await fingerprintResolvedPackageClosure({ root_runtime: rootPackage });
    expect(before.packages.map(item => item.name)).toEqual([
      "hoisted-runtime-dependency",
      "root-runtime",
    ]);
    await fs.writeFile(path.join(dependencyPackage, "index.js"), "module.exports = 2;\n");
    const after = await fingerprintResolvedPackageClosure({ root_runtime: rootPackage });
    expect(after.closure_sha256).not.toBe(before.closure_sha256);
    expect(after.packages.find(item => item.name === "root-runtime")?.tree_sha256)
      .toBe(before.packages.find(item => item.name === "root-runtime")?.tree_sha256);
    expect(after.packages.find(item => item.name === "hoisted-runtime-dependency")?.tree_sha256)
      .not.toBe(before.packages.find(item => item.name === "hoisted-runtime-dependency")?.tree_sha256);
  });

  it("passes a complete four-call read/render trajectory through final grading", async () => {
    const successfulCodex = path.join(testRoot, "fake-codex-success.mjs");
    await writeFakeCodex(successfulCodex, { successfulCalls: true });
    const { campaignRoot } = await planOne("complete-four-call", successfulCodex);
    const completed = await runCampaignEntry({ campaignPath: campaignRoot, repeatIndex: 1, documentsRoot });
    expect(completed.observer.outcome).toBe("completed");
    expect(completed.launcherRecord.completed_pdf_call_count).toBe(4);
    const finalized = await finalizeCampaign(campaignRoot, { documentsRoot });
    expect(finalized.report).toMatchObject({
      attempted_trials: 1,
      product_trials: 1,
      passed_trials: 1,
      harness_failures: 0,
    });
  }, 30_000);

  it("builds only the frozen allowlisted launch environment", () => {
    const source = {
      HOME: "/home/test", PATH: "/bin", LANG: "C.UTF-8", OPENAI_API_KEY: "secret-value",
      PDF_TOOLS_FORCE_SYSTEM_RENDERER: "1", HTTP_PROXY: "http://untrusted.invalid",
    };
    const contract = captureLaunchEnvironment(source, "a".repeat(64));
    const launch = buildLaunchEnvironment(contract, source);
    expect(launch).toMatchObject({
      HOME: "/home/test", PATH: "/bin", LANG: "C.UTF-8", OPENAI_API_KEY: "secret-value",
    });
    expect(launch).not.toHaveProperty("PDF_TOOLS_FORCE_SYSTEM_RENDERER");
    expect(launch).not.toHaveProperty("HTTP_PROXY");
    expect(contract.secret_commitments.OPENAI_API_KEY).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects prompt tampering before acquiring a launch claim", async () => {
    const { campaignRoot } = await planOne("prompt-tamper");
    const runRoot = path.join(campaignRoot, "runs", "repeat-01");
    await fs.appendFile(path.join(runRoot, "prompt.txt"), "tampered\n");
    await expect(runCampaignEntry({ campaignPath: campaignRoot, repeatIndex: 1, documentsRoot }))
      .rejects.toThrow(/Prompt changed after planning/);
    await expect(fs.access(path.join(runRoot, "launch-claim.json"))).rejects.toThrow();
  }, 30_000);

  it("rejects descendant workspace symlinks before acquiring a launch claim", async () => {
    const { campaignRoot } = await planOne("workspace-symlink");
    const runRoot = path.join(campaignRoot, "runs", "repeat-01");
    await fs.rename(path.join(runRoot, "workspace"), path.join(runRoot, "workspace-backing"));
    await fs.symlink("workspace-backing", path.join(runRoot, "workspace"), "dir");
    await expect(runCampaignEntry({ campaignPath: campaignRoot, repeatIndex: 1, documentsRoot }))
      .rejects.toThrow(/ancestry must contain only real directories/);
    await expect(fs.access(path.join(runRoot, "launch-claim.json"))).rejects.toThrow();
  }, 30_000);

  it("rejects hash-equivalent prompt symlinks before acquiring a launch claim", async () => {
    const { campaignRoot } = await planOne("prompt-symlink");
    const runRoot = path.join(campaignRoot, "runs", "repeat-01");
    await fs.rename(path.join(runRoot, "prompt.txt"), path.join(runRoot, "prompt-backing.txt"));
    await fs.symlink("prompt-backing.txt", path.join(runRoot, "prompt.txt"));
    await expect(runCampaignEntry({ campaignPath: campaignRoot, repeatIndex: 1, documentsRoot }))
      .rejects.toThrow(/Expected a retained regular file/);
    await expect(fs.access(path.join(runRoot, "launch-claim.json"))).rejects.toThrow();
  }, 30_000);

  it("rejects symlinked authoritative campaign and pre-run plan files", async () => {
    const { campaignRoot } = await planOne("authoritative-file-symlink");
    const campaignPath = path.join(campaignRoot, "campaign.json");
    await fs.rename(campaignPath, path.join(campaignRoot, "campaign-backing.json"));
    await fs.symlink("campaign-backing.json", campaignPath);
    await expect(runCampaignEntry({ campaignPath: campaignRoot, repeatIndex: 1, documentsRoot }))
      .rejects.toThrow(/Expected a retained regular file/);

    await fs.unlink(campaignPath);
    await fs.rename(path.join(campaignRoot, "campaign-backing.json"), campaignPath);
    const planPath = path.join(campaignRoot, "pre-run-plan.json");
    await fs.rename(planPath, path.join(campaignRoot, "pre-run-plan-backing.json"));
    await fs.symlink("pre-run-plan-backing.json", planPath);
    await expect(runCampaignEntry({ campaignPath: campaignRoot, repeatIndex: 1, documentsRoot }))
      .rejects.toThrow(/Expected a retained regular file/);
  }, 30_000);

  it("allows exactly one concurrent claimant for a planned invocation", async () => {
    const { campaignRoot } = await planOne("concurrent-claim");
    const results = await Promise.allSettled([
      runCampaignEntry({ campaignPath: campaignRoot, repeatIndex: 1, documentsRoot }),
      runCampaignEntry({ campaignPath: campaignRoot, repeatIndex: 1, documentsRoot }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  }, 30_000);

  it("accounts a timed-out process as a retained harness failure", async () => {
    const timeoutCodex = path.join(testRoot, "fake-codex-timeout.mjs");
    await writeFakeCodex(timeoutCodex, { timeout: true });
    const { campaignRoot } = await planOne("timeout", timeoutCodex, 1_000);
    const completed = await runCampaignEntry({ campaignPath: campaignRoot, repeatIndex: 1, documentsRoot });
    expect(completed.observer.outcome).toBe("harness_failure");
    expect(completed.launcherRecord.exit.timed_out).toBe(true);
    const finalized = await finalizeCampaign(campaignRoot, { documentsRoot });
    expect(finalized.report).toMatchObject({
      attempted_trials: 1,
      product_trials: 0,
      harness_failures: 1,
      passed_trials: 0,
    });
  }, 30_000);

  it("keeps a completed no-tool turn in the product denominator after a later timeout", async () => {
    const timeoutCodex = path.join(testRoot, "fake-codex-complete-then-timeout.mjs");
    await writeFakeCodex(timeoutCodex, { timeout: true, completeThenTimeout: true });
    const { campaignRoot } = await planOne("complete-then-timeout", timeoutCodex, 1_000);
    const completed = await runCampaignEntry({ campaignPath: campaignRoot, repeatIndex: 1, documentsRoot });
    expect(completed.launcherRecord.exit.timed_out).toBe(true);
    expect(completed.observer.outcome).toBe("completed");
    const finalized = await finalizeCampaign(campaignRoot, { documentsRoot });
    expect(finalized.report).toMatchObject({
      attempted_trials: 1,
      product_trials: 1,
      harness_failures: 0,
      passed_trials: 0,
    });
  }, 30_000);
});
