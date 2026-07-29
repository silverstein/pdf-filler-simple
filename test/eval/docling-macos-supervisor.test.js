import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  compileDoclingMacosSupervisor,
  parseCanonicalCandidateJson,
  runSupervisedCandidate,
  runSupervisedCandidateForTest,
  supervisorTestCapability,
  validateSupervisorEvidence,
  validateSupervisorLease,
} from "./docling-macos-supervisor.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE = path.join(ROOT, "test/eval/native/docling-macos-supervisor.c");
const CANDIDATE_SOURCE = path.join(ROOT, "test/eval/native/docling-macos-supervisor-candidate.c");
const EVIDENCE_SCHEMA = path.join(ROOT, "test/fixtures/eval/extraction/phase1/docling-macos-supervisor-evidence.schema.json");
const RUNS_ON_DARWIN = process.platform === "darwin";

describe.runIf(RUNS_ON_DARWIN)("native macOS structured-extraction supervisor", () => {
  let root;
  let production;
  let testing;
  let candidate;
  let attemptRoot;
  let recordValidator;

  beforeAll(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-docling-supervisor-")),
    );
    await fs.chmod(root, 0o700);
    attemptRoot = path.join(root, "attempt");
    await fs.mkdir(attemptRoot, { mode: 0o700 });
    production = await compileDoclingMacosSupervisor({
      sourcePath: SOURCE,
      outputPath: path.join(root, "supervisor"),
    });
    testing = await compileDoclingMacosSupervisor({
      sourcePath: SOURCE,
      outputPath: path.join(root, "supervisor-testing"),
      testing: true,
    });
    candidate = path.join(root, "hostile-candidate");
    const architecture = process.arch === "x64" ? "x86_64" : process.arch;
    const result = spawnSync(production.compiler.path, [
      "-std=c17", "-Os", "-Wall", "-Wextra", "-Werror", "-Wconversion",
      "-Wsign-conversion", "-mmacosx-version-min=13.0",
      "-arch", architecture, "-isysroot", production.sdk.path,
      "-o", candidate, CANDIDATE_SOURCE,
    ], {
      cwd: root,
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin", TMPDIR: root },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0 || result.signal !== null || result.stdout !== "") {
      throw new Error(`Unable to compile hostile candidate: ${(result.stderr || result.error?.message || "unknown").slice(0, 1000)}`);
    }
    await fs.chmod(candidate, 0o700);
    recordValidator = new AjvJsonSchemaValidator().getValidator(
      JSON.parse(await fs.readFile(EVIDENCE_SCHEMA, "utf8")),
    );
  }, 120000);

  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: false });
  });

  function options(mode, args = [], overrides = {}) {
    return {
      binaryPath: production.binary.path,
      expectedBinary: production.binary,
      cwd: attemptRoot,
      command: [candidate, mode, ...args.map(String)],
      stdin: Buffer.from("{}\n"),
      environment: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      deadlineMs: 2000,
      leaderExitGraceMs: 1000,
      sampleIntervalMs: 5,
      stdoutMaxBytes: 1024,
      stderrMaxBytes: 1024,
      physicalFootprintMaxBytes: 1024 * 1024 * 1024,
      addressSpaceBytes: 512 * 1024 * 1024 * 1024,
      cpuSeconds: 10,
      fileSizeBytes: 1024 * 1024,
      nofile: 128,
      ...overrides,
    };
  }

  async function run(mode, args = [], overrides = {}) {
    return runSupervisedCandidate(options(mode, args, overrides));
  }

  async function runFault(fault, mode = "sleep", args = [5000], overrides = {}) {
    return runSupervisedCandidateForTest({
      ...options(mode, args, overrides),
      binaryPath: testing.binary.path,
      expectedBinary: testing.binary,
      testCapability: supervisorTestCapability(),
    }, fault);
  }

  async function waitForFile(filename, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await fs.access(filename);
        return;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
    throw new Error(`Timed out waiting for test sentinel: ${filename}`);
  }

  it("builds one hash-bound binary reproducibly and accepts canonical output", async () => {
    expect(production).toMatchObject({
      protocol: "pdf-tools.macos-eval-supervisor-build.v1",
      testing: false,
      binary: { mode: 0o700, links: 1 },
    });
    expect(production.source.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(production.compiler.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(production.binary.sha256).toMatch(/^[a-f0-9]{64}$/);
    const result = await run("success");
    expect(recordValidator(result.lease)).toMatchObject({ valid: true });
    expect(recordValidator(result.evidence)).toMatchObject({ valid: true });
    expect(result.evidence).toMatchObject({
      controller_accepted: true,
      controller_failure: "none",
      child_setup_stage: 0,
      leader: { exit_code: 0, signal: null },
      observations: {
        original_process_group_empty: true,
        escaped_session_detected: false,
      },
    });
    expect(result.cwd).toMatchObject({
      path: attemptRoot,
      mode: 0o700,
    });
    expect(result.cwd.dev).toMatch(/^[0-9]+$/);
    expect(result.cwd.ino).toMatch(/^[0-9]+$/);
    expect(parseCanonicalCandidateJson(result.stdout, 1024)).toEqual({ ok: true });
    expect(() => validateSupervisorLease({
      ...result.lease,
      leader_pid: 2147483648,
      process_group_id: 2147483648,
    })).toThrow(/lease/);
    expect(() => validateSupervisorEvidence({
      ...structuredClone(result.evidence),
      controller_failure: "unrecognized_failure",
    }, result.lease, options("success"))).toThrow(/envelope/);
    expect(() => validateSupervisorEvidence({
      ...structuredClone(result.evidence),
      observations: {
        ...structuredClone(result.evidence.observations),
        max_group_members: 4097,
      },
    }, result.lease, options("success"))).toThrow(/observation/);
  });

  it("accepts only after sampling proves the reserved leader became terminal", async () => {
    const result = await runFault(
      "sampling_terminal_leader",
      "terminal-during-sampling",
      [15],
      { sampleIntervalMs: 1 },
    );
    expect(result.evidence).toMatchObject({
      controller_accepted: true,
      controller_failure: "none",
      leader: { exit_code: 0, signal: null },
      observations: { original_process_group_empty: true },
    });
    expect(result.evidence.observations.sample_count).toBeGreaterThan(0);
    expect(result.evidence.observations.sample_race_count).toBeGreaterThan(0);
  });

  it("proves every installed hard limit cannot be raised", async () => {
    const result = await run("raise-limits");
    expect(result.evidence.controller_accepted).toBe(true);
    expect(parseCanonicalCandidateJson(result.stdout, 1024)).toEqual({
      hard_limits_unraiseable: true,
      ok: true,
    });
  });

  it("returns schema-valid fail-closed evidence when RLIMIT_AS cannot be installed", async () => {
    const sentinel = path.join(root, "pre-exec-sentinel");
    const result = await run("leader-exit-live-descendant", [sentinel], {
      addressSpaceBytes: 8 * 1024 * 1024 * 1024,
      stdin: Buffer.alloc(1024 * 1024, 0x41),
    });
    expect(result.lease).toBeNull();
    expect(result.stdout).toHaveLength(0);
    expect(result.evidence).toMatchObject({
      controller_accepted: false,
      controller_failure: "child_setup",
      child_setup_stage: 7,
      leader: {
        exit_code: 122,
        process_group_id: -1,
        signal: null,
        start_abstime: 0,
      },
      observations: { original_process_group_empty: true },
    });
    expect(recordValidator(result.evidence)).toMatchObject({ valid: true });
    await expect(fs.access(sentinel)).rejects.toThrow();
  });

  it.each([
    ["spam-stdout", [1024 * 1024], "stdout_limit"],
    ["continuous-stdout", [], "stdout_limit"],
    ["spam-stderr", [1024 * 1024], "stderr_limit"],
    ["sleep", [1000], "deadline", { deadlineMs: 100 }],
    ["ignore-signals", [1000], "deadline", { deadlineMs: 100 }],
    ["memory-growth", [128 * 1024 * 1024], "physical_footprint_limit", {
      deadlineMs: 3000,
      physicalFootprintMaxBytes: 64 * 1024 * 1024,
    }],
    ["crash", [], "leader_exit"],
  ])("fails closed for %s", async (mode, args, failure, overrides = {}) => {
    const result = await run(mode, args, overrides);
    expect(result.stdout).toHaveLength(0);
    expect(result.evidence).toMatchObject({
      controller_accepted: false,
      controller_failure: failure,
      observations: { original_process_group_empty: true },
    });
  });

  it("drains multiple children and labels short-lived CPU evidence as sampled", async () => {
    const multiple = await run("multiple-children", [4, 100], { deadlineMs: 3000 });
    expect(multiple.evidence).toMatchObject({
      controller_accepted: true,
      observations: { max_group_members: 5, original_process_group_empty: true },
    });
    const shortLived = await run("short-lived-cpu-children", [12, 20], { deadlineMs: 5000 });
    expect(shortLived.evidence.controller_accepted).toBe(true);
    expect(shortLived.evidence.observations.max_group_members).toBeGreaterThan(1);
    expect(shortLived.evidence.observations.max_sampled_group_cpu_ns).toBeGreaterThan(0);
    expect(shortLived.evidence.claim_boundary).toContain("Sampled resource observations");
  });

  it("revalidates a transient sampling EPERM only after the child becomes inspectable", async () => {
    const result = await runFault(
      "sampling_transient_eperm",
      "multiple-children",
      [1, 250],
      { sampleIntervalMs: 1 },
    );
    expect(result.evidence).toMatchObject({
      controller_accepted: true,
      controller_failure: "none",
      observations: { original_process_group_empty: true },
    });
    expect(result.evidence.observations.sample_race_count).toBeGreaterThan(0);
    expect(result.evidence.observations.observed_process_identity_count).toBeGreaterThan(1);
  });

  it("rejects a persistently inaccessible live child after the bounded sampling window", async () => {
    const result = await runFault(
      "sampling_persistent_eperm",
      "multiple-children",
      [1, 1000],
      { sampleIntervalMs: 1 },
    );
    expect(result.stdout).toHaveLength(0);
    expect(result.evidence).toMatchObject({
      controller_accepted: false,
      controller_errno: 1,
      controller_failure: "enumeration",
      observations: { original_process_group_empty: true },
    });
    expect(result.evidence.observations.sample_race_count).toBeGreaterThan(0);
  });

  it("does not accept an injected ESRCH while the sampled child remains live", async () => {
    const result = await runFault(
      "sampling_false_esrch",
      "multiple-children",
      [1, 1000],
      { sampleIntervalMs: 1 },
    );
    expect(result.stdout).toHaveLength(0);
    expect(result.evidence).toMatchObject({
      controller_accepted: false,
      controller_errno: 3,
      controller_failure: "enumeration",
      observations: { original_process_group_empty: true },
    });
  });

  it("accepts sampling EPERM only after the real child is absent between two ESRCH probes", async () => {
    const result = await runFault(
      "sampling_vanish_eperm",
      "multiple-children",
      [1, 8],
      { sampleIntervalMs: 1 },
    );
    expect(result.evidence).toMatchObject({
      controller_accepted: true,
      controller_failure: "none",
      observations: { original_process_group_empty: true },
    });
    expect(result.evidence.observations.max_group_members).toBeGreaterThan(1);
    expect(result.evidence.observations.sample_race_count).toBeGreaterThan(0);
  });

  it("blocks when child-source re-enumeration fails inside disappearance proof", async () => {
    const result = await runFault(
      "sampling_child_source_reenumeration_failure",
      "child-source-short-lived-escape",
      [15],
      { deadlineMs: 3000, sampleIntervalMs: 1 },
    );
    expect(result.stdout).toHaveLength(0);
    expect(result.evidence).toMatchObject({
      controller_accepted: false,
      controller_errno: 5,
      controller_failure: "enumeration",
      observations: { original_process_group_empty: true },
    });
    expect(result.evidence.observations.sample_race_count).toBeGreaterThan(0);
  });

  it("does not mistake an inaccessible child leaving the group for disappearance", async () => {
    const sentinel = path.join(root, "sampling-escape-eperm-sentinel");
    const result = await runFault(
      "sampling_escape_eperm",
      "delayed-escaped-session",
      [sentinel],
      { sampleIntervalMs: 1 },
    );
    expect(result.stdout).toHaveLength(0);
    expect(result.evidence).toMatchObject({
      controller_accepted: false,
      controller_errno: 1,
      controller_failure: "enumeration",
      observations: { original_process_group_empty: true },
    });
    expect(result.evidence.observations.max_group_members).toBeGreaterThan(1);
    await waitForFile(sentinel, 2500);
  });

  it("shares one monotonic retry budget across multiple inaccessible PIDs", async () => {
    const result = await runFault(
      "sampling_shared_budget_eperm",
      "barrier-children",
      [32, 1000],
      { deadlineMs: 3000, sampleIntervalMs: 1 },
    );
    expect(result.stdout).toHaveLength(0);
    expect(result.evidence).toMatchObject({
      controller_accepted: false,
      controller_errno: 1,
      controller_failure: "enumeration",
      observations: { original_process_group_empty: true },
    });
    expect(result.evidence.observations.max_group_members).toBe(33);
    expect(result.evidence.observations.sample_race_count).toBeGreaterThan(2);
    expect(result.evidence.observations.elapsed_continuous_ns)
      .toBeLessThan(500 * 1e6);
  });

  it("blocks before disappearance proof when sampling reaches the outer deadline", async () => {
    const result = await runFault(
      "sampling_outer_deadline_eperm",
      "multiple-children",
      [1, 1000],
      { deadlineMs: 100, sampleIntervalMs: 1 },
    );
    expect(result.stdout).toHaveLength(0);
    expect(result.evidence).toMatchObject({
      controller_accepted: false,
      controller_errno: 1,
      controller_failure: "enumeration",
      observations: { original_process_group_empty: true },
    });
    expect(result.evidence.observations.elapsed_continuous_ns)
      .toBeGreaterThanOrEqual(100 * 1e6);
  });

  it("survives repeated real /bin/ps exec windows on the release host", async () => {
    const result = await run("repeated-ps", [256], {
      deadlineMs: 15000,
      sampleIntervalMs: 1,
    });
    expect(result.evidence).toMatchObject({
      controller_accepted: true,
      controller_failure: "none",
      observations: { original_process_group_empty: true },
    });
    expect(result.evidence.observations.max_group_members).toBeGreaterThan(1);
    expect(result.evidence.observations.sample_race_count).toBeGreaterThan(0);
  }, 30000);

  it("rejects a successful leader that leaves a live descendant", async () => {
    const sentinel = path.join(root, "leader-exit-sentinel");
    const result = await run("leader-exit-live-descendant", [sentinel], {
      leaderExitGraceMs: 0,
    });
    expect(result.evidence).toMatchObject({
      controller_accepted: false,
      controller_failure: "live_descendants",
      observations: { original_process_group_empty: true },
    });
    await new Promise(resolve => setTimeout(resolve, 1000));
    await expect(fs.access(sentinel)).rejects.toThrow();
  });

  it("enforces physical footprint limits during leader-exit grace", async () => {
    const result = await run(
      "leader-exit-memory-descendant",
      [128 * 1024 * 1024],
      {
        deadlineMs: 3000,
        leaderExitGraceMs: 1000,
        physicalFootprintMaxBytes: 64 * 1024 * 1024,
        sampleIntervalMs: 5,
      },
    );
    expect(result.stdout).toHaveLength(0);
    expect(result.evidence).toMatchObject({
      controller_accepted: false,
      controller_failure: "physical_footprint_limit",
      observations: {
        max_group_members: 2,
        original_process_group_empty: true,
      },
    });
    expect(result.evidence.observations.observed_process_identity_count)
      .toBeGreaterThan(1);
    expect(result.evidence.observations.max_sampled_group_physical_footprint_bytes)
      .toBeGreaterThan(64 * 1024 * 1024);
  });

  it("continues sampling through leader-exit grace and kills a delayed escape", async () => {
    const sentinel = path.join(root, "leader-exit-delayed-escape-sentinel");
    const result = await run("leader-exit-delayed-escape", [sentinel], {
      deadlineMs: 3000,
      leaderExitGraceMs: 1000,
      sampleIntervalMs: 5,
    });
    expect(result.stdout).toHaveLength(0);
    expect(result.evidence).toMatchObject({
      controller_accepted: false,
      controller_failure: "escaped_session",
      observations: {
        escaped_session_detected: true,
        original_process_group_empty: true,
      },
    });
    expect(result.evidence.observations.max_group_members).toBe(2);
    expect(result.evidence.observations.observed_process_identity_count)
      .toBeGreaterThan(1);
    await new Promise(resolve => setTimeout(resolve, 1500));
    await expect(fs.access(sentinel)).rejects.toThrow();
  });

  it.each([
    "final_identity_query_race",
    "final_post_stop_query_failure",
    "final_pre_signal_race",
  ])("returns containment-unproven while a closed-stdio escape remains live after final-pass %s", async fault => {
    const sentinel = path.join(root, `${fault}-sentinel`);
    let observed;
    try {
      await runFault(
        fault,
        "leader-exit-closed-fd-delayed-escape",
        [sentinel],
        {
          deadlineMs: 5000,
          leaderExitGraceMs: 1000,
          sampleIntervalMs: 5,
        },
      );
    } catch (error) {
      observed = error;
    }
    expect(observed).toMatchObject({
      code: "SUPERVISOR_CONTAINMENT_UNPROVEN",
      evidence: {
        controller_accepted: false,
        controller_failure: "cleanup",
        observations: {
          escaped_session_detected: true,
          original_process_group_empty: false,
        },
      },
    });
    expect(observed).not.toHaveProperty("stdout");
    expect(observed.evidence.observations.elapsed_continuous_ns)
      .toBeGreaterThanOrEqual(2 * 1e9);
    await waitForFile(sentinel, 4500);
  });

  it("recursively freezes and cleans a remembered escaped resource tree before rejecting output", async () => {
    const sentinel = path.join(root, "escaped-resource-tree-sentinel");
    const result = await runFault(
      "final_escape_resource_tree",
      "leader-exit-escaped-resource-tree",
      [15, 16, sentinel, 128 * 1024 * 1024],
      {
        deadlineMs: 3000,
        leaderExitGraceMs: 1000,
        sampleIntervalMs: 5,
        physicalFootprintMaxBytes: 64 * 1024 * 1024,
      },
    );
    expect(result.stdout).toHaveLength(0);
    expect(result.evidence).toMatchObject({
      controller_accepted: false,
      controller_failure: "escaped_session",
      observations: {
        escaped_session_detected: true,
        original_process_group_empty: true,
      },
    });
    expect(result.evidence.observations.observed_process_identity_count)
      .toBeGreaterThanOrEqual(3);
    await new Promise(resolve => setTimeout(resolve, 1500));
    await expect(fs.access(sentinel)).rejects.toThrow();
  });

  it("detects an observed escaped session, rejects output, and kills the known child", async () => {
    const sentinel = path.join(root, "escaped-session-sentinel");
    const result = await run("escaped-session", [sentinel]);
    expect(result.evidence).toMatchObject({
      controller_accepted: false,
      controller_failure: "escaped_session",
      observations: {
        escaped_session_detected: true,
        original_process_group_empty: true,
      },
    });
    await new Promise(resolve => setTimeout(resolve, 1500));
    await expect(fs.access(sentinel)).rejects.toThrow();
  });

  it.each([
    "escaped_identity_query_race",
    "escaped_post_stop_query_failure",
    "escaped_pre_signal_race",
  ])("reports cleanup failure without killing an escaped PID after the %s identity boundary changes", async fault => {
    const sentinel = path.join(root, `${fault}-sentinel`);
    const result = await runFault(fault, "escaped-session", [sentinel]);
    expect(result.evidence).toMatchObject({
      controller_accepted: false,
      controller_failure: "cleanup",
      observations: {
        escaped_session_detected: true,
        original_process_group_empty: true,
      },
    });
    await waitForFile(sentinel, 2500);
  });

  it.each([
    ["enumeration_failure", "enumeration"],
    ["pid_reuse", "pid_reuse"],
    ["continuous_clock_jump", "deadline"],
  ])("rejects injected controller fault %s", async (fault, expectedFailure) => {
    const result = await runFault(fault);
    expect(result.evidence).toMatchObject({
      controller_accepted: false,
      controller_failure: expectedFailure,
      observations: { original_process_group_empty: true },
    });
  });

  it.each([
    ["prelease_enumeration", "enumeration", {}, 0],
    ["prelease_lease_failure", "lease", {}, 0],
    ["prelease_timeout", "child_setup", { deadlineMs: 100 }, 0],
  ])("publishes bounded lease-free evidence for %s", async (fault, expectedFailure, overrides, expectedStage) => {
    const result = await runFault(fault, "sleep", [5000], overrides);
    expect(result.lease).toBeNull();
    expect(result.stdout).toHaveLength(0);
    expect(result.evidence).toMatchObject({
      controller_accepted: false,
      controller_failure: expectedFailure,
      child_setup_stage: expectedStage,
      observations: { original_process_group_empty: true },
    });
    expect(
      result.evidence.leader.exit_code !== null
      || result.evidence.leader.signal !== null,
    ).toBe(true);
    expect(recordValidator(result.evidence)).toMatchObject({ valid: true });
  });

  it("uses the parent-owned lease to clean up a crashed supervisor", async () => {
    let observed;
    try {
      await runFault("supervisor_crash");
    } catch (error) {
      observed = error;
    }
    expect(observed).toMatchObject({
      code: "SUPERVISOR_EVIDENCE_MISSING",
      cleanup: {
        identity_matched: true,
        original_process_group_empty: true,
      },
      exit: { code: 99, signal: null },
    });
    expect(recordValidator(observed.cleanup)).toMatchObject({ valid: true });
  });

  it.each([
    ["post_cleanup_evidence_write_failure", 12],
    ["partial_output_evidence_write_failure", 6],
  ])("discards %s native stdout unless valid accepted evidence commits it", async (fault, discardedBytes) => {
    let observed;
    try {
      await runFault(fault, "success", []);
    } catch (error) {
      observed = error;
    }
    expect(observed).toMatchObject({
      code: "SUPERVISOR_CONTAINMENT_UNPROVEN",
      transport: {
        candidate_stdout_committed_bytes: 0,
        discarded_candidate_stdout_bytes: discardedBytes,
      },
    });
    expect(observed).not.toHaveProperty("stdout");
    expect(observed).not.toHaveProperty("evidence");
  });

  it.each([
    "supervisor_crash_cleanup_identity_query_race",
    "supervisor_crash_cleanup_post_stop_query_failure",
    "supervisor_crash_cleanup_pre_signal_race",
  ])("refuses destructive crash cleanup after the %s identity boundary changes", async fault => {
    const sentinel = path.join(root, `${fault}-sentinel`);
    let observed;
    try {
      await runFault(fault, "sentinel-after", [sentinel, 750]);
    } catch (error) {
      observed = error;
    }
    expect(observed).toMatchObject({
      code: "SUPERVISOR_CONTAINMENT_UNPROVEN",
      exit: { code: 99, signal: null },
      lease: { process_group_id: expect.any(Number) },
    });
    await waitForFile(sentinel, 2500);
  });

  it("never returns normally when native cleanup proof is unavailable", async () => {
    let observed;
    try {
      await runFault("cleanup_unproven", "crash", []);
    } catch (error) {
      observed = error;
    }
    expect(observed).toMatchObject({
      code: "SUPERVISOR_CONTAINMENT_UNPROVEN",
      evidence: {
        controller_accepted: false,
        observations: { original_process_group_empty: false },
      },
    });
  });

  it("escalates a nonresponsive supervisor and performs lease-bound cleanup", async () => {
    const started = Date.now();
    let observed;
    try {
      await runFault("supervisor_hang_ignore_term", "sleep", [10000], {
        deadlineMs: 100,
      });
    } catch (error) {
      observed = error;
    }
    expect(Date.now() - started).toBeLessThan(8000);
    expect(observed).toMatchObject({
      code: "SUPERVISOR_EVIDENCE_MISSING",
      cleanup: {
        identity_matched: true,
        original_process_group_empty: true,
      },
    });
  }, 10000);

  it("keeps process acceptance separate from canonical response acceptance", async () => {
    const partial = await run("partial-json");
    expect(partial.evidence.controller_accepted).toBe(true);
    expect(() => parseCanonicalCandidateJson(partial.stdout, 1024)).toThrow(/not JSON/);
    const justInTime = await run("just-in-time", [50], { deadlineMs: 250 });
    expect(justInTime.evidence.controller_accepted).toBe(true);
    expect(parseCanonicalCandidateJson(justInTime.stdout, 1024)).toEqual({ ok: true });
  });

  it("accepts canonical candidate JSON above the evidence ceiling under its explicit stdout ceiling", async () => {
    const contentBytes = 96 * 1024;
    const stdoutMaxBytes = 128 * 1024;
    const result = await run("large-json", [contentBytes], { stdoutMaxBytes });
    const parsed = parseCanonicalCandidateJson(result.stdout, stdoutMaxBytes);
    expect(parsed).toMatchObject({ ok: true });
    expect(parsed.data).toHaveLength(contentBytes);
    expect(() => parseCanonicalCandidateJson(result.stdout, 64 * 1024)).toThrow(/ceiling/);
    expect(() => parseCanonicalCandidateJson(result.stdout)).toThrow(/explicit stdout/);
  });

  it("snapshots all caller-owned inputs before asynchronous binary verification", async () => {
    const command = [candidate, "assert-input-env", "original-token"];
    const environment = {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      PDF_TEST_TOKEN: "original-token",
    };
    const stdin = Buffer.from("ORIGINAL\n");
    const expectedBinary = { ...production.binary };
    const promise = runSupervisedCandidate({
      ...options("success"),
      command,
      environment,
      stdin,
      expectedBinary,
    });
    command.splice(0, command.length, "/usr/bin/false");
    environment.PDF_TEST_TOKEN = "mutated-token";
    stdin.fill(0x58);
    expectedBinary.sha256 = "0".repeat(64);
    const result = await promise;
    expect(result.evidence.controller_accepted).toBe(true);
  });

  it("requires a hash-bound binary identity for the production API", async () => {
    await expect(runSupervisedCandidate({
      ...options("success"),
      expectedBinary: null,
    })).rejects.toThrow(/required expected identity/);
  });

  it("requires a canonical private working directory and rejects identity substitution", async () => {
    await expect(runSupervisedCandidate({
      ...options("success"),
      cwd: `${attemptRoot}/.`,
    })).rejects.toThrow(/canonical absolute path/);

    const mutable = path.join(root, "mutable-attempt");
    const moved = path.join(root, "mutable-attempt-moved");
    await fs.mkdir(mutable, { mode: 0o700 });
    const sentinel = path.join(root, "cwd-mutation-started");
    const promise = runSupervisedCandidate({
      ...options("signal-and-sleep", [sentinel, 250]),
      cwd: mutable,
    });
    await waitForFile(sentinel);
    await fs.rename(mutable, moved);
    await fs.mkdir(mutable, { mode: 0o700 });
    await expect(promise).rejects.toMatchObject({
      code: "SUPERVISOR_CWD_MUTATED",
      evidence: { observations: { original_process_group_empty: true } },
    });
  });

  it("rejects a same-path binary mutation before spawning", async () => {
    const mutant = path.join(root, "mutated-supervisor");
    await fs.copyFile(production.binary.path, mutant, fsConstants.COPYFILE_EXCL);
    await fs.chmod(mutant, 0o700);
    await fs.appendFile(mutant, Buffer.from([0]));
    await expect(runSupervisedCandidate({
      ...options("success"),
      binaryPath: mutant,
      expectedBinary: production.binary,
    })).rejects.toThrow(/differs from its required expected identity/);
  });

  it("rejects same-path binary mutation during an otherwise complete run", async () => {
    const mutant = path.join(root, "runtime-mutated-supervisor");
    await fs.copyFile(production.binary.path, mutant, fsConstants.COPYFILE_EXCL);
    await fs.chmod(mutant, 0o700);
    const sentinel = path.join(root, "runtime-mutation-started");
    const promise = runSupervisedCandidate({
      ...options("signal-and-sleep", [sentinel, 250]),
      binaryPath: mutant,
      expectedBinary: { ...production.binary, path: mutant },
    });
    await waitForFile(sentinel);
    await fs.appendFile(mutant, Buffer.from([0]));
    await expect(promise).rejects.toMatchObject({
      code: "SUPERVISOR_BINARY_MUTATED",
      evidence: { observations: { original_process_group_empty: true } },
    });
  });

  it("refuses a mutated cleanup binary after a delayed supervisor crash", async () => {
    const mutant = path.join(root, "crash-mutated-supervisor");
    await fs.copyFile(testing.binary.path, mutant, fsConstants.COPYFILE_EXCL);
    await fs.chmod(mutant, 0o700);
    const sentinel = path.join(root, "crash-mutation-started");
    const promise = runSupervisedCandidateForTest({
      ...options("signal-and-sleep", [sentinel, 5000]),
      binaryPath: mutant,
      expectedBinary: { ...testing.binary, path: mutant },
      testCapability: supervisorTestCapability(),
    }, "supervisor_crash_delayed");
    await waitForFile(sentinel);
    await fs.appendFile(mutant, Buffer.from([0]));
    let observed;
    try {
      await promise;
    } catch (error) {
      observed = error;
    } finally {
      if (observed?.lease?.process_group_id) {
        try {
          process.kill(-observed.lease.process_group_id, "SIGKILL");
        } catch {}
      }
    }
    expect(observed).toMatchObject({
      code: "SUPERVISOR_CONTAINMENT_UNPROVEN",
      lease: { process_group_id: expect.any(Number) },
    });
  });
});
