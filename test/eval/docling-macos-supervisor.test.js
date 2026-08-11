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

  // EPERM and ESRCH are the only two errnos the bounded sampling-revalidation
  // budget can surface for a live workload: a process the supervisor saw was
  // either not inspectable (EPERM) or already gone (ESRCH) for longer than
  // SAMPLE_REVALIDATION_BUDGET_NS. Every other errno means something other
  // than CPU starvation went wrong and must still fail the suite.
  const SAMPLING_RACE_ERRNOS = [os.constants.errno.EPERM, os.constants.errno.ESRCH];

  /*
   * CONTAINMENT VS ACCEPTANCE -- the policy this family follows.
   *
   * Containment is the contract. "Never certifies what it could not observe",
   * "never leaks a live process group", "never escapes its session", "declines
   * cleanly with a truthful reason", and "never emits candidate stdout without
   * certifying" hold on every host under every load. They are asserted
   * unconditionally by expectSupervisedInvariants, which every test in this
   * family calls, and they are the only assertions that may sit outside a
   * branch.
   *
   * Acceptance is not a universal property, but it is also not automatically a
   * host-dependent one. What determines whether it may be asserted flatly is
   * *what decides the outcome*:
   *
   *   1. Host-determined runs -- a real churning workload under the production
   *      binary, no injected fault. Certification requires completing an
   *      observation inside a sealed window that a starved host can deny, so
   *      the outcome is a genuine disjunction. Use expectContainedRun and keep
   *      the test's own named property above the branch.
   *
   *   2. Fault-determined declines -- the injected fault makes declining
   *      inevitable. Assert the exact failure code and errno with
   *      expectDeclinedRun.
   *
   *   3. Fault-determined acceptances -- the injected fault is supposed to make
   *      accepting inevitable. Assert it flatly with expectAcceptedRun. When
   *      such a test flakes under load, the defect is in the injector, not in
   *      the assertion: an injector must *establish* the state it wants the
   *      supervisor to observe before reporting its errno, because everything
   *      it waits for afterwards is charged to the product's sealed 20ms
   *      SAMPLE_REVALIDATION_BUDGET_NS. Weakening these into disjunctions would
   *      delete the suite's only coverage of the accept path, since a
   *      starvation decline is indistinguishable from the decline their
   *      sibling tests already assert.
   *
   * Consequence: no test here needs a quiet host to test what it is named for,
   * and none is skipped. Category-1 tests keep a visible branch; every other
   * test asserts one fixed outcome on any host.
   */

  /**
   * The load-independent contract of a supervised run. Asserted by every test
   * in this family, never inside a branch.
   *
   * `drained` and `escaped` are opt-in because a few tests deliberately
   * exercise a run that could not be drained; leaving them unset asserts
   * nothing rather than guessing.
   */
  function expectSupervisedInvariants(result, expected = {}) {
    const evidence = result.evidence;
    const observations = evidence.observations;

    // The envelope is schema-valid and honestly labelled.
    expect(recordValidator(evidence)).toMatchObject({ valid: true });
    expect(evidence.claim_boundary).toContain("Sampled resource observations");

    // Acceptance is exactly the conjunction of the clean observations, so no
    // branch can be reached by mislabelling another. Duplicated from
    // validateSupervisorEvidence on purpose -- the test keeps the invariant if
    // the harness ever stops enforcing it.
    expect(evidence.controller_accepted).toBe(
      evidence.controller_failure === "none"
      && evidence.controller_errno === 0
      && evidence.child_setup_stage === 0
      && evidence.leader.exit_code === 0
      && evidence.leader.signal === null
      && !evidence.capture.stdout_limit_exceeded
      && !evidence.capture.stderr_limit_exceeded
      && !observations.escaped_session_detected
      && observations.original_process_group_empty,
    );

    // Candidate stdout is only ever released by a certified run.
    if (!evidence.controller_accepted) {
      expect(result.stdout).toHaveLength(0);
    }

    if (expected.drained !== undefined) {
      expect(observations.original_process_group_empty).toBe(expected.drained);
    }
    if (expected.escaped !== undefined) {
      expect(observations.escaped_session_detected).toBe(expected.escaped);
    }
  }

  /**
   * A fault-determined acceptance: the injected fault, not the host, decides
   * the outcome, so acceptance is asserted flatly. See the policy note above.
   */
  function expectAcceptedRun(result, expected = {}) {
    expectSupervisedInvariants(result, { drained: true, escaped: false, ...expected });
    expect(result.evidence).toMatchObject({
      controller_accepted: true,
      controller_failure: "none",
      controller_errno: 0,
      leader: { exit_code: 0, signal: null },
    });
  }

  /**
   * A fault-determined decline: pinned to one exact failure code and errno, so
   * a supervisor that starts failing closed for some *other* reason -- or that
   * reports a truthless errno -- still fails the suite.
   */
  function expectDeclinedRun(result, failure, errno, expected = {}) {
    expectSupervisedInvariants(result, { drained: true, ...expected });
    expect(result.evidence).toMatchObject({
      controller_accepted: false,
      controller_failure: failure,
      controller_errno: errno,
    });
    expect(result.stdout).toHaveLength(0);
  }

  /**
   * A host-determined run: assert every load-independent property, then assert
   * the branch the supervisor actually took.
   *
   * Certifying a run requires observing the whole process group inside a
   * sealed sampling window. On a CPU-starved host the supervisor cannot always
   * finish that observation, so it fails closed with `enumeration` instead of
   * certifying what it could not see. That is the correct product behaviour,
   * which makes the *outcome* a genuine disjunction rather than a constant.
   *
   * The disjunction is deliberately narrow. The failure branch is pinned to one
   * exact failure code and a closed errno set. Callers add the workload-specific
   * observation assertions that hold in both branches, above the branch.
   *
   * @returns {boolean} whether the supervisor certified the run
   */
  function expectContainedRun(result) {
    const evidence = result.evidence;
    const observations = evidence.observations;

    expectSupervisedInvariants(result, { drained: true, escaped: false });

    // Holds either way: the supervisor really observed the group rather than
    // giving up before looking at it.
    expect(observations.sample_count).toBeGreaterThan(0);
    expect(observations.max_group_members).toBeGreaterThan(0);
    expect(observations.observed_process_identity_count)
      .toBeGreaterThanOrEqual(observations.max_group_members);

    if (evidence.controller_accepted) {
      expect(evidence.controller_failure).toBe("none");
      expect(evidence.controller_errno).toBe(0);
      expect(evidence.leader).toMatchObject({ exit_code: 0, signal: null });
      expect(parseCanonicalCandidateJson(result.stdout, 1024))
        .toMatchObject({ ok: true });
      return true;
    }

    // Declined: only ever the CPU-starvation enumeration boundary, with an
    // errno that names a sampling race, and never any candidate stdout.
    expect(evidence.controller_failure).toBe("enumeration");
    expect(SAMPLING_RACE_ERRNOS).toContain(evidence.controller_errno);
    return false;
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
    // The injector waits for the leader to actually become terminal before it
    // reports ESRCH, so the supervisor's WNOWAIT proof is exercised on every
    // host rather than only on one fast enough to finish the leader's exit
    // inside SAMPLE_REVALIDATION_BUDGET_NS. Fault-determined acceptance:
    // asserted flatly, never disjunctively.
    const result = await runFault(
      "sampling_terminal_leader",
      "terminal-during-sampling",
      [15],
      { sampleIntervalMs: 1 },
    );
    expectAcceptedRun(result);
    expect(result.evidence.observations.sample_count).toBeGreaterThan(0);
    // The named property: acceptance came *through* the sampling race path,
    // not by the injected ESRCH never firing.
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
    expectSupervisedInvariants(result, { drained: true, escaped: false });
    expect(result.stdout).toHaveLength(0);
    expect(result.evidence).toMatchObject({
      controller_accepted: false,
      controller_failure: failure,
    });
  });

  it("drains multiple children and labels short-lived CPU evidence as sampled", async () => {
    // Certification here is host-load dependent (see expectContainedRun), but
    // the drain count and the sampled-CPU labelling this test is named for are
    // not: they are recorded from the snapshots the supervisor did complete,
    // whether or not it went on to certify. So they are asserted first, for
    // both branches, and only the outcome is left to the disjunction.
    const multiple = await run("multiple-children", [4, 100], { deadlineMs: 3000 });
    expect(multiple.evidence.observations.max_group_members).toBe(5);
    expectContainedRun(multiple);

    const shortLived = await run("short-lived-cpu-children", [12, 20], { deadlineMs: 5000 });
    expect(shortLived.evidence.observations.max_group_members).toBeGreaterThan(1);
    expect(shortLived.evidence.observations.max_sampled_group_cpu_ns).toBeGreaterThan(0);
    expectContainedRun(shortLived);
  });

  it("revalidates a transient sampling EPERM only after the child becomes inspectable", async () => {
    const result = await runFault(
      "sampling_transient_eperm",
      "multiple-children",
      [1, 250],
      { sampleIntervalMs: 1 },
    );
    expectAcceptedRun(result);
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
    expectDeclinedRun(result, "enumeration", os.constants.errno.EPERM);
    expect(result.evidence.observations.sample_race_count).toBeGreaterThan(0);
  });

  it("does not accept an injected ESRCH while the sampled child remains live", async () => {
    const result = await runFault(
      "sampling_false_esrch",
      "multiple-children",
      [1, 1000],
      { sampleIntervalMs: 1 },
    );
    expectDeclinedRun(result, "enumeration", os.constants.errno.ESRCH);
  });

  it("accepts sampling EPERM only after the real child is absent between two ESRCH probes", async () => {
    // The injector waits for the real child to be gone *and reaped* before it
    // reports EPERM, so the supervisor still has to run the entire two-probe
    // vanish proof inside SAMPLE_REVALIDATION_BUDGET_NS -- it just no longer
    // has to outrun the candidate's sleep to do it. This is the suite's only
    // coverage of the accept side of the vanish proof; its sibling above
    // asserts the decline, so a disjunction here would collapse the two.
    const result = await runFault(
      "sampling_vanish_eperm",
      "multiple-children",
      [1, 15],
      { sampleIntervalMs: 1 },
    );
    expectAcceptedRun(result);
    expect(result.evidence.observations.sample_race_count).toBeGreaterThan(0);
  });

  it("blocks when child-source re-enumeration fails inside disappearance proof", async () => {
    const result = await runFault(
      "sampling_child_source_reenumeration_failure",
      "child-source-short-lived-escape",
      [15],
      { deadlineMs: 3000, sampleIntervalMs: 1 },
    );
    expectDeclinedRun(result, "enumeration", os.constants.errno.EIO);
    expect(result.evidence.observations.sample_race_count).toBeGreaterThan(0);
  });

  it("does not mistake an inaccessible child leaving the group for disappearance", async () => {
    // The child can escape before the first process-group snapshot while still
    // being discovered by the supervisor's separate child enumeration. The
    // injected EPERM, fail-closed result, and surviving sentinel prove this
    // path; the multiple-live-children test above pins the group count itself.
    //
    // KNOWN COVERAGE GAP (measured, pre-existing, not load-related). Because
    // this PID resolves through the *children* source, its own enumeration
    // already blocks: the escaped child is still a direct child of the leader,
    // so source_contains_pid never returns 0. Deleting both ESRCH signal probes
    // from prove_process_vanished -- so that source absence alone proves a PID
    // gone -- leaves the whole suite green, idle and under contention alike.
    // Closing it needs a fixture whose PID is discovered by the *group*
    // snapshot and is absent from the group while still alive, e.g. an
    // orphaned grandchild that setsid()s: no candidate mode produces one today.
    const sentinel = path.join(root, "sampling-escape-eperm-sentinel");
    const result = await runFault(
      "sampling_escape_eperm",
      "delayed-escaped-session",
      [sentinel],
      { sampleIntervalMs: 1 },
    );
    expectDeclinedRun(result, "enumeration", os.constants.errno.EPERM);
    await waitForFile(sentinel, 2500);
  });

  it("shares one monotonic retry budget across multiple inaccessible PIDs", async () => {
    const result = await runFault(
      "sampling_shared_budget_eperm",
      "barrier-children",
      [32, 1000],
      { deadlineMs: 3000, sampleIntervalMs: 1 },
    );
    const observations = result.evidence.observations;

    // The setup really did present many independently inaccessible PIDs: the
    // fault only arms on a snapshot of the full 33-member group, and each of
    // the 32 children becomes inspectable again after only four probes.
    expect(observations.max_group_members).toBe(33);

    // The named property. Given one shared, monotonic budget the supervisor
    // exhausts it partway through the group and fails closed. Given a budget
    // that reset per PID, every child would clear its four probes inside its
    // own fresh 20ms window and the run would be *certified*. So the decline
    // -- with EPERM, the errno of the PIDs that were never re-proven -- is the
    // discriminator, and it is load-independent: starving the host only makes
    // the shared budget run out sooner.
    expectDeclinedRun(result, "enumeration", os.constants.errno.EPERM);

    // How *many* PIDs fit inside one 20ms budget is a measurement of host
    // speed, not of the supervisor: idle this host fits four, under load one.
    // The previous `sample_race_count > 2` therefore asserted the opposite of
    // the property in the test name -- heavier load means stronger evidence of
    // sharing but a smaller count -- and was the assertion that failed under
    // contention. What is load-independent is the direction of the bound: with
    // one shared budget the supervisor must run out *before* it has revalidated
    // all 32 inaccessible children; with a per-PID budget it would revalidate
    // every one of them.
    expect(observations.sample_race_count).toBeGreaterThanOrEqual(1);
    expect(observations.sample_race_count)
      .toBeLessThan(observations.max_group_members - 1);

    // The retired wall-clock bound (`elapsed_continuous_ns < 500ms`) is
    // deliberately not replaced. The campaign clock is dominated by spawning
    // and forking 33 processes -- 132ms idle, 477ms under contention on this
    // host -- while the whole quantity under test is at most 20ms, so it could
    // never have discriminated one budget from thirty-two. It only measured
    // how loaded the host was.
  });

  it("blocks before disappearance proof when sampling reaches the outer deadline", async () => {
    const result = await runFault(
      "sampling_outer_deadline_eperm",
      "multiple-children",
      [1, 1000],
      { deadlineMs: 100, sampleIntervalMs: 1 },
    );
    expectDeclinedRun(result, "enumeration", os.constants.errno.EPERM);
    expect(result.evidence.observations.elapsed_continuous_ns)
      .toBeGreaterThanOrEqual(100 * 1e6);
  });

  it("survives repeated real /bin/ps exec windows on the release host", async () => {
    // 256 back-to-back /bin/ps execs churn the process group faster than the
    // 1ms sampler can settle, so on a busy host the supervisor legitimately
    // runs out of revalidation budget and declines. What must hold on every
    // host is that it saw the churn and contained it.
    const result = await run("repeated-ps", [256], {
      deadlineMs: 15000,
      sampleIntervalMs: 1,
    });
    expect(result.evidence.observations.max_group_members).toBeGreaterThan(1);
    expect(result.evidence.observations.sample_race_count).toBeGreaterThan(0);
    expectContainedRun(result);
  }, 30000);

  it("rejects a successful leader that leaves a live descendant", async () => {
    const sentinel = path.join(root, "leader-exit-sentinel");
    const result = await run("leader-exit-live-descendant", [sentinel], {
      leaderExitGraceMs: 0,
    });
    expectSupervisedInvariants(result, { drained: true, escaped: false });
    expect(result.evidence).toMatchObject({
      controller_accepted: false,
      controller_failure: "live_descendants",
    });
    await new Promise(resolve => setTimeout(resolve, 1000));
    await expect(fs.access(sentinel)).rejects.toThrow();
  });

  it("enforces physical footprint limits during leader-exit grace", async () => {
    // The descendant now holds its pages until killed, so the only timing
    // requirement left is faulting 128 MiB resident within the grace window.
    // The prior 1000ms grace raced page-in under host load and flaked; the
    // wider grace and deadline keep the run bounded while the limit check,
    // not a self-exit, decides the outcome.
    const result = await run(
      "leader-exit-memory-descendant",
      [128 * 1024 * 1024],
      {
        deadlineMs: 6000,
        leaderExitGraceMs: 2500,
        physicalFootprintMaxBytes: 64 * 1024 * 1024,
        sampleIntervalMs: 5,
      },
    );
    expectSupervisedInvariants(result, { drained: true, escaped: false });
    expect(result.stdout).toHaveLength(0);
    expect(result.evidence).toMatchObject({
      controller_accepted: false,
      controller_failure: "physical_footprint_limit",
      observations: { max_group_members: 2 },
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
    expectSupervisedInvariants(result, { drained: true, escaped: true });
    expect(result.stdout).toHaveLength(0);
    expect(result.evidence).toMatchObject({
      controller_accepted: false,
      controller_failure: "escaped_session",
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
    expectSupervisedInvariants(result, { drained: true, escaped: true });
    expect(result.stdout).toHaveLength(0);
    expect(result.evidence).toMatchObject({
      controller_accepted: false,
      controller_failure: "escaped_session",
    });
    expect(result.evidence.observations.observed_process_identity_count)
      .toBeGreaterThanOrEqual(3);
    await new Promise(resolve => setTimeout(resolve, 1500));
    await expect(fs.access(sentinel)).rejects.toThrow();
  });

  it("detects an observed escaped session, rejects output, and kills the known child", async () => {
    const sentinel = path.join(root, "escaped-session-sentinel");
    const result = await run("escaped-session", [sentinel]);
    expectSupervisedInvariants(result, { drained: true, escaped: true });
    expect(result.evidence).toMatchObject({
      controller_accepted: false,
      controller_failure: "escaped_session",
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
    expectSupervisedInvariants(result, { drained: true, escaped: true });
    expect(result.evidence).toMatchObject({
      controller_accepted: false,
      controller_failure: "cleanup",
    });
    await waitForFile(sentinel, 2500);
  });

  it.each([
    ["enumeration_failure", "enumeration"],
    ["pid_reuse", "pid_reuse"],
    ["continuous_clock_jump", "deadline"],
  ])("rejects injected controller fault %s", async (fault, expectedFailure) => {
    const result = await runFault(fault);
    expectSupervisedInvariants(result, { drained: true, escaped: false });
    expect(result.evidence).toMatchObject({
      controller_accepted: false,
      controller_failure: expectedFailure,
    });
  });

  it.each([
    ["prelease_enumeration", "enumeration", {}, 0],
    ["prelease_lease_failure", "lease", {}, 0],
    ["prelease_timeout", "child_setup", { deadlineMs: 100 }, 0],
  ])("publishes bounded lease-free evidence for %s", async (fault, expectedFailure, overrides, expectedStage) => {
    const result = await runFault(fault, "sleep", [5000], overrides);
    expectSupervisedInvariants(result, { drained: true, escaped: false });
    expect(result.lease).toBeNull();
    expect(result.stdout).toHaveLength(0);
    expect(result.evidence).toMatchObject({
      controller_accepted: false,
      controller_failure: expectedFailure,
      child_setup_stage: expectedStage,
    });
    expect(
      result.evidence.leader.exit_code !== null
      || result.evidence.leader.signal !== null,
    ).toBe(true);
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
  }, 15_000);

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
