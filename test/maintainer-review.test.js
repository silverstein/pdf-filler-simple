import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  calculateGithubBeadsReconciliation,
  fetchOfficialJson,
  runCommandBounded,
  runMaintainerReview,
} from "../scripts/maintainer-review.mjs";

const SOURCE_SHA = "a".repeat(40);
const ORIGIN_SHA = "b".repeat(40);
const GENERATED_AT = "2026-07-28T12:34:56.000Z";
const CURRENT_PACKAGE_VERSION = JSON.parse(await fs.readFile(
  new URL("../package.json", import.meta.url),
  "utf8",
)).version;
const temporaryDirectories = [];
const ACTIVE_STATUSES = new Set(["open", "in_progress", "blocked", "deferred"]);

const exportedBeads = (await fs.readFile(
  new URL("../.beads/issues.jsonl", import.meta.url),
  "utf8",
))
  .split(/\r?\n/)
  .filter(line => line.trim())
  .map(line => JSON.parse(line));

function matchingGithubItems(kind) {
  const groups = new Map();
  for (const bead of exportedBeads) {
    const shorthand = kind === "issue" ? /^gh-(\d+)$/.exec(bead.external_ref || "") : null;
    const full = new RegExp(
      `^https://github\\.com/Open-Document-Alliance/PDF-Tools/${kind === "issue" ? "issues" : "pull"}/(\\d+)`,
      "i",
    ).exec(bead.external_ref || "");
    const number = Number(shorthand?.[1] || full?.[1]);
    if (!Number.isInteger(number) || number <= 0) continue;
    if (!groups.has(number)) groups.set(number, []);
    groups.get(number).push(bead);
  }
  return [...groups.entries()]
    .map(([number, beads]) => ({
      number,
      state: beads.some(bead => ACTIVE_STATUSES.has(bead.status)) ? "open" : "closed",
      updated_at: "2026-07-28T00:00:00Z",
      ...(kind === "pull-request" ? { draft: false } : {}),
    }))
    .sort((left, right) => left.number - right.number);
}

const MATCHING_GITHUB_ISSUES = matchingGithubItems("issue");
const MATCHING_GITHUB_PULL_REQUESTS = matchingGithubItems("pull-request");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function commandResult({
  exitCode = 0,
  stdout = "",
  stderr = "",
  timedOut = false,
  outputLimitExceeded = false,
  signal = null,
  error = null,
} = {}) {
  return {
    exitCode,
    signal,
    timedOut,
    outputLimitExceeded,
    durationMs: 7,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    error,
  };
}

const DEVELOPMENT_FIXTURE_IDS = [
  "pdf-tools.eval.v1.dev-page-order-source",
  "pdf-tools.eval.v1.dev-page-order-visibly-wrong",
  "pdf-tools.eval.v1.irs-w9-2014",
];

function structuredScore({
  passed = true,
  expectationMet = true,
  corpusVersion = "v0.1.0",
  partition = "development",
  fixtureIds = DEVELOPMENT_FIXTURE_IDS,
} = {}) {
  return JSON.stringify({
    corpus_version: corpusVersion,
    partition,
    passed,
    results: fixtureIds.map(id => ({
      id,
      partition,
      expectation_met: expectationMet,
    })),
  });
}

function makeRunner({
  contractResult = commandResult(),
  scoreResult = commandResult({ stdout: structuredScore() }),
  sourceHeads = [SOURCE_SHA, SOURCE_SHA],
  localHeads = [SOURCE_SHA, SOURCE_SHA],
  dirty = false,
  endDirty = false,
} = {}) {
  const calls = [];
  let sourceHeadIndex = 0;
  let localHeadIndex = 0;
  let statusReadCount = 0;
  const runner = async (executable, args, options) => {
    calls.push({ executable, args: [...args], options });
    if (executable === "git") {
      const command = args.slice(1);
      const joined = command.join(" ");
      if (joined === "status --porcelain=v1 --untracked-files=all") {
        statusReadCount += 1;
        return commandResult({
          stdout: dirty || (endDirty && statusReadCount > 1) ? " M package.json\n" : "",
        });
      }
      if (joined === "rev-parse --verify HEAD^{commit}") {
        const value = localHeads[Math.min(localHeadIndex, localHeads.length - 1)];
        localHeadIndex += 1;
        return commandResult({ stdout: `${value}\n` });
      }
      if (joined === "rev-parse --verify origin/master^{commit}") {
        return commandResult({ stdout: `${ORIGIN_SHA}\n` });
      }
      if (joined === "rev-parse --verify candidate^{commit}") {
        const value = sourceHeads[Math.min(sourceHeadIndex, sourceHeads.length - 1)];
        sourceHeadIndex += 1;
        return commandResult({ stdout: `${value}\n` });
      }
      throw new Error(`Unexpected Git command: ${joined}`);
    }
    if (String(executable).endsWith("node_modules/.bin/vitest")) return contractResult;
    if (executable === process.execPath && args[0] === "scripts/eval-run.mjs") return scoreResult;
    throw new Error(`Unexpected executable: ${executable}`);
  };
  return { runner, calls };
}

function fakeFetch({
  githubIssues = MATCHING_GITHUB_ISSUES,
  githubPullRequests = MATCHING_GITHUB_PULL_REQUESTS,
  npmDeprecated = null,
  releaseTag = "v1.0.0",
} = {}) {
  return async urlString => {
    const url = new URL(urlString);
    let payload;
    if (url.pathname === "/repos/Open-Document-Alliance/PDF-Tools/issues") payload = githubIssues;
    else if (url.pathname === "/repos/Open-Document-Alliance/PDF-Tools/pulls") payload = githubPullRequests;
    else if (url.hostname === "registry.npmjs.org") {
      payload = {
        version: "1.0.0",
        dist: { integrity: "sha512-synthetic" },
        deprecated: npmDeprecated,
      };
    } else {
      payload = [
        {
          tag_name: releaseTag,
          prerelease: false,
          draft: false,
          published_at: "2026-07-28T00:00:00Z",
        },
      ];
    }
    const bytes = Buffer.from(JSON.stringify(payload));
    return { payload, bytes, sha256: sha256(bytes) };
  };
}

async function runReview({
  runnerOptions = {},
  fetchOptions = {},
  reviewOptions = {},
} = {}) {
  const { runner, calls } = makeRunner(runnerOptions);
  const report = await runMaintainerReview({
    requestedRef: "candidate",
    generatedAt: GENERATED_AT,
    now: () => 100,
    runCommand: runner,
    fetchJson: fakeFetch(fetchOptions),
    ...reviewOptions,
  });
  return { report, calls };
}

async function makeTemporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-maintainer-review-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function makeReleaseEvidence({
  sourceCommit = SOURCE_SHA,
  packageVersion = CURRENT_PACKAGE_VERSION,
  knownLimitations = [],
  mutateReceipt = null,
} = {}) {
  const directory = await makeTemporaryDirectory();
  const candidatePath = path.join(directory, "candidate.mcpb");
  const evidencePath = path.join(directory, "release-evidence.json");
  const candidate = Buffer.from("synthetic exact candidate bytes");
  const candidateSha256 = sha256(candidate);
  const inventorySha256 = sha256(Buffer.from("inventory"));
  const sbomSha256 = sha256(Buffer.from("sbom"));
  const kinds = [
    "unit_protocol_corpus",
    "artifact_inventory",
    "sbom_licenses",
    "secret_scan",
    "native_host_macos_arm64",
    "native_host_windows_x64",
    "agent_workflow_scorecard",
  ];
  const receipts = kinds.map((kind, index) => ({
    schema_version: 1,
    receipt_id: `receipt.${index + 1}`,
    kind,
    status: "pass",
    artifact_sha256: candidateSha256,
    source_commit: sourceCommit,
    evidence_sha256: kind === "artifact_inventory"
      ? inventorySha256
      : kind === "sbom_licenses"
        ? sbomSha256
        : sha256(Buffer.from(`receipt-${index + 1}`)),
    observed_at: GENERATED_AT,
    limitations: [],
  }));
  if (mutateReceipt) mutateReceipt(receipts);
  const receiptsDirectory = path.join(directory, "receipts");
  await fs.mkdir(receiptsDirectory);
  const receiptPaths = [];
  const receiptIndex = [];
  for (const [index, receipt] of receipts.entries()) {
    const relativePath = `receipts/receipt-${index + 1}.json`;
    const receiptPath = path.join(directory, relativePath);
    const receiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
    await fs.writeFile(receiptPath, receiptBytes);
    receiptPaths.push(receiptPath);
    receiptIndex.push({
      receipt_id: receipt.receipt_id,
      kind: receipt.kind,
      status: receipt.status,
      artifact_sha256: receipt.artifact_sha256,
      source_commit: receipt.source_commit,
      evidence_sha256: receipt.evidence_sha256,
      receipt_path: relativePath,
      receipt_sha256: sha256(receiptBytes),
    });
  }
  const evidence = {
    schema_version: 1,
    evidence_id: "synthetic.release.evidence",
    candidate: {
      sha256: candidateSha256,
      source_commit: sourceCommit,
      package_version: packageVersion,
      inventory_sha256: inventorySha256,
      sbom_sha256: sbomSha256,
    },
    receipts: receiptIndex,
    known_limitations: knownLimitations,
    maintainer_approval_ref: null,
  };
  await fs.writeFile(candidatePath, candidate);
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence)}\n`);
  return { candidatePath, evidencePath, candidateSha256, receiptPaths };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("recurring maintainer review", () => {
  it("is deterministic for the same immutable inputs and runs only allowlisted commands", async () => {
    const first = await runReview();
    const second = await runReview();

    expect(first.report).toEqual(second.report);
    expect(first.report.coverage.status).toBe("complete");
    expect(first.report.decisions).toEqual([]);
    expect(first.report.release_evidence.status).toBe("not_supplied");
    expect(first.report.summary.active_human_gate_ids).toEqual([]);
    expect(first.report.summary.exit_code).toBe(0);
    expect(first.report.observations.find(item => item.id === "local.versions").public_value.runtime).toMatchObject({
      node_version: process.version,
      platform: process.platform,
      architecture: process.arch,
      installed_vitest_version: "4.1.10",
      installed_sdk_version: "1.29.0",
      installed_pdf_lib_version: "1.17.1",
      installed_pdfjs_version: "5.4.624",
    });
    expect(first.report.evaluation.product_score.summary.source_count).toBe(8);

    const executables = new Set(first.calls.map(call => path.basename(call.executable)));
    expect(executables).toEqual(new Set(["git", "vitest", path.basename(process.execPath)]));
    for (const call of first.calls) {
      expect(call.args).not.toContain("bd");
      expect(call.args).not.toContain("gh");
      expect(call.args).not.toContain("npm");
      expect(call.args).not.toContain("npx");
      expect(call.options.environment.SLACK_BOT_TOKEN).toBeUndefined();
      expect(call.options.environment.GITHUB_TOKEN).toBeUndefined();
    }
  });

  it("binds report identity to normalized report content", async () => {
    const first = await runReview();
    const changedUpstream = await runReview({
      fetchOptions: { releaseTag: "v2.0.0" },
    });

    expect(changedUpstream.report.generated_at).toBe(first.report.generated_at);
    expect(changedUpstream.report.source_binding.config_sha256).toBe(first.report.source_binding.config_sha256);
    expect(changedUpstream.report.source_binding.start_head).toBe(first.report.source_binding.start_head);
    expect(changedUpstream.report.report_id).not.toBe(first.report.report_id);
  });

  it("reports a valid product failure as complete findings with exit code 1", async () => {
    const { report } = await runReview({
      runnerOptions: {
        scoreResult: commandResult({
          exitCode: 1,
          stdout: structuredScore({ passed: false, expectationMet: false }),
        }),
      },
    });

    expect(report.evaluation.product_score.classification).toBe("product_fail");
    expect(report.coverage.status).toBe("complete");
    expect(report.summary.status).toBe("complete_findings");
    expect(report.summary.exit_code).toBe(1);
    expect(report.inferences.map(item => item.id)).toContain("evaluation.product-failure");
  });

  it("keeps harness failures distinct and marks required evidence partial", async () => {
    const { report } = await runReview({
      runnerOptions: {
        scoreResult: commandResult({ timedOut: true }),
      },
    });

    expect(report.evaluation.product_score.classification).toBe("harness_failure");
    expect(report.coverage.status).toBe("partial");
    expect(report.coverage.unavailable_source_ids).toContain("evaluation.product-score");
    expect(report.summary.exit_code).toBe(2);
  });

  it("treats invalid evaluator result records as a harness failure", async () => {
    const malformedScore = JSON.stringify({
      corpus_version: "v0.1.0",
      partition: "development",
      passed: true,
      results: [{ id: "missing-expectation-met" }],
    });
    const { report } = await runReview({
      runnerOptions: {
        scoreResult: commandResult({ stdout: malformedScore }),
      },
    });

    expect(report.evaluation.product_score.classification).toBe("harness_failure");
    expect(report.coverage.status).toBe("partial");
    expect(report.summary.exit_code).toBe(2);
  });

  it.each([
    ["wrong partition", structuredScore({ partition: "held_out_release" })],
    ["omitted fixture", structuredScore({ fixtureIds: DEVELOPMENT_FIXTURE_IDS.slice(0, 2) })],
    ["extra fixture", structuredScore({ fixtureIds: [...DEVELOPMENT_FIXTURE_IDS, "pdf-tools.eval.v1.extra"] })],
    ["wrong corpus version", structuredScore({ corpusVersion: "v9.9.9" })],
  ])("rejects evaluator output bound to the %s", async (_label, stdout) => {
    const { report } = await runReview({
      runnerOptions: {
        scoreResult: commandResult({ stdout }),
      },
    });

    expect(report.evaluation.product_score.classification).toBe("harness_failure");
    expect(report.coverage.status).toBe("partial");
    expect(report.summary.exit_code).toBe(2);
  });

  it("rejects evaluator exit and pass-bit disagreement", async () => {
    const passingExitOne = await runReview({
      runnerOptions: {
        scoreResult: commandResult({ exitCode: 1, stdout: structuredScore() }),
      },
    });
    expect(passingExitOne.report.evaluation.product_score.classification).toBe("harness_failure");

    const falsePassBit = await runReview({
      runnerOptions: {
        scoreResult: commandResult({
          exitCode: 1,
          stdout: structuredScore({ passed: false, expectationMet: true }),
        }),
      },
    });
    expect(falsePassBit.report.evaluation.product_score.classification).toBe("harness_failure");
  });

  it("treats an out-of-contract contract-runner exit as a harness failure", async () => {
    const { report } = await runReview({
      runnerOptions: {
        contractResult: commandResult({ exitCode: 2 }),
      },
    });

    expect(report.evaluation.contract_health.classification).toBe("harness_failure");
    expect(report.coverage.status).toBe("partial");
    expect(report.summary.exit_code).toBe(2);
  });

  it("makes offline required-source coverage explicit", async () => {
    const { report } = await runReview({
      reviewOptions: { offline: true },
    });

    expect(report.coverage.status).toBe("partial");
    expect(report.coverage.skipped_source_ids).toContain("github.issues");
    expect(report.coverage.skipped_source_ids).toContain("frontier.mcp-spec-releases");
    expect(report.errors.map(item => item.error_id)).toContain("source.github.issues");
    expect(report.summary.exit_code).toBe(2);
  });

  it("keeps an explicitly skipped evaluation diagnostic partial", async () => {
    const { report } = await runReview({
      reviewOptions: { evaluationEnabled: false },
    });

    expect(report.evaluation.product_score.classification).toBe("skipped");
    expect(report.coverage.skipped_source_ids).toContain("evaluation.product-score");
    expect(report.summary.exit_code).toBe(2);
  });

  it("stops remote and evaluation work when the total runtime budget is exhausted", async () => {
    let clockReads = 0;
    const { report } = await runReview({
      reviewOptions: {
        now() {
          clockReads += 1;
          return clockReads === 1 ? 0 : 200_000;
        },
      },
    });

    expect(report.coverage.status).toBe("partial");
    expect(report.coverage.total_duration_ms).toBe(200_000);
    expect(report.errors.map(item => item.error_id)).toContain("bounds.total-runtime");
    expect(report.evaluation.contract_health.classification).toBe("harness_failure");
    expect(report.summary.exit_code).toBe(2);
  });

  it("binds changes to a schema-valid previous report instead of claiming no drift without one", async () => {
    const first = await runReview();
    const directory = await makeTemporaryDirectory();
    const previousPath = path.join(directory, "previous.json");
    await fs.writeFile(previousPath, `${JSON.stringify(first.report)}\n`);

    const second = await runReview({
      reviewOptions: {
        previousReportPath: previousPath,
        generatedAt: "2026-07-29T12:34:56.000Z",
      },
    });

    expect(first.report.changes.every(change => change.classification === "not_evaluated")).toBe(true);
    expect(second.report.source_binding.previous_report.status).toBe("supplied_compatible");
    expect(second.report.source_binding.previous_report.sha256).toBe(sha256(Buffer.from(`${JSON.stringify(first.report)}\n`)));
    expect(second.report.evaluation.score_drift).toBe("no_change");
    expect(second.report.changes).toEqual([
      {
        change_id: "change.evaluation.product-score",
        classification: "changed",
        current_fact_id: "fact.evaluation.product-score",
        previous_fact_id: "fact.evaluation.product-score",
      },
    ]);
  });

  it("refuses baseline comparison when a previous report used a different config contract", async () => {
    const first = await runReview();
    const directory = await makeTemporaryDirectory();
    const previousPath = path.join(directory, "previous-incompatible.json");
    first.report.source_binding.config_sha256 = "d".repeat(64);
    await fs.writeFile(previousPath, `${JSON.stringify(first.report)}\n`);

    const second = await runReview({
      reviewOptions: {
        previousReportPath: previousPath,
        generatedAt: "2026-07-29T12:34:56.000Z",
      },
    });

    expect(second.report.mode.previous_report_supplied).toBe(true);
    expect(second.report.source_binding.previous_report.status).toBe("supplied_incompatible");
    expect(second.report.changes.every(change => change.classification === "not_evaluated")).toBe(true);
    expect(second.report.evaluation.score_drift).toBe("not_evaluated");
  });

  it("marks score drift incomparable when the scorer runtime comparison identity differs", async () => {
    const first = await runReview();
    const directory = await makeTemporaryDirectory();
    const previousPath = path.join(directory, "previous-runtime-drift.json");
    first.report.evaluation.product_score.summary.comparison_key_sha256 = "e".repeat(64);
    await fs.writeFile(previousPath, `${JSON.stringify(first.report)}\n`);

    const second = await runReview({
      reviewOptions: {
        previousReportPath: previousPath,
        generatedAt: "2026-07-29T12:34:56.000Z",
      },
    });

    expect(second.report.source_binding.previous_report.status).toBe("supplied_compatible");
    expect(second.report.evaluation.score_drift).toBe("incomparable_due_to_harness_or_contract_change");
  });

  it("detects source movement and refuses evaluation on a dirty checkout", async () => {
    const moved = await runReview({
      runnerOptions: { sourceHeads: [SOURCE_SHA, "c".repeat(64)] },
    });
    expect(moved.report.source_binding.source_moved).toBe(true);
    expect(moved.report.summary.exit_code).toBe(2);

    const dirty = await runReview({
      runnerOptions: { dirty: true },
    });
    expect(dirty.report.source_binding.repo_dirty).toBe(true);
    expect(dirty.report.evaluation.product_score.classification).toBe("unavailable");
    expect(dirty.report.summary.exit_code).toBe(2);

    const workingTreeMoved = await runReview({
      runnerOptions: { endDirty: true },
    });
    expect(workingTreeMoved.report.source_binding.working_tree_moved).toBe(true);
    expect(workingTreeMoved.report.source_binding.repo_dirty_end).toBe(true);
    expect(workingTreeMoved.report.inferences.map(item => item.id)).toContain("repository.working-tree-moved");
    expect(workingTreeMoved.report.summary.exit_code).toBe(2);

    const localHeadMoved = await runReview({
      runnerOptions: { localHeads: [SOURCE_SHA, "e".repeat(40)] },
    });
    expect(localHeadMoved.report.source_binding.local_head_moved).toBe(true);
    expect(localHeadMoved.report.source_binding.source_identity_stable).toBe(false);
    expect(localHeadMoved.report.inferences.map(item => item.id)).toContain("repository.source-identity-moved");
    expect(localHeadMoved.report.errors.map(item => item.error_id)).toContain("source.identity-moved");
    expect(localHeadMoved.report.summary.exit_code).toBe(2);
  });

  it("refuses to attribute working-tree evidence to a different requested ref", async () => {
    const { report } = await runReview({
      runnerOptions: { sourceHeads: ["c".repeat(64), "c".repeat(64)] },
    });

    expect(report.source_binding.requested_ref_matches_checkout).toBe(false);
    expect(report.evaluation.product_score.classification).toBe("unavailable");
    expect(report.inferences.map(item => item.id)).toContain("repository.ref-mismatch");
    expect(report.summary.exit_code).toBe(2);
  });

  it("sanitizes untrusted frontier strings and omits public issue content", async () => {
    const secret = `xoxb-${"z".repeat(24)}`;
    const fineGrainedPat = `github_pat_${"y".repeat(40)}`;
    const { report } = await runReview({
      fetchOptions: {
        npmDeprecated: `${secret} ${fineGrainedPat} /home/mat/private.pdf /opt/private ~/private https://user:password@example.com/file`,
        releaseTag: `v1\u001b[31m ${secret} /Users/x/Library/Application Support/Claude/private.pdf /etc/private`,
        githubIssues: [
          {
            number: 999,
            state: "open",
            updated_at: "2026-07-28T00:00:00Z",
            title: "private issue title",
            body: `private issue body ${secret}`,
          },
        ],
      },
    });
    const encoded = JSON.stringify(report);

    expect(encoded).not.toContain(secret);
    expect(encoded).not.toContain(fineGrainedPat);
    expect(encoded).not.toContain("/home/mat/private.pdf");
    expect(encoded).not.toContain("/Users/x/Library/Application");
    expect(encoded).not.toContain("Support/Claude/private.pdf");
    expect(encoded).not.toContain("/opt/private");
    expect(encoded).not.toContain("/etc/private");
    expect(encoded).not.toContain("~/private");
    expect(encoded).not.toContain("user:password");
    expect(encoded).not.toContain("private issue title");
    expect(encoded).not.toContain("private issue body");
    expect(encoded).toContain("[redacted-token]");
    expect(encoded).toContain("[redacted-path]");
    expect(encoded).toContain("[redacted-credentials]");
  });

  it("binds passing release receipts to exact candidate, source, and package while retaining the release gate", async () => {
    const evidence = await makeReleaseEvidence();
    const { report } = await runReview({
      reviewOptions: {
        candidatePath: evidence.candidatePath,
        expectedCandidateSha256: evidence.candidateSha256,
        releaseEvidencePath: evidence.evidencePath,
      },
    });

    expect(report.release_evidence.status).toBe("automated_checks_pass");
    expect(report.release_evidence.candidate_sha256).toBe(evidence.candidateSha256);
    expect(report.release_evidence.verified_receipt_count).toBe(7);
    expect(report.release_evidence.aggregate_receipt_bytes).toBeGreaterThan(0);
    expect(report.release_evidence.index_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.release_evidence.verified_receipts).toHaveLength(7);
    expect(report.summary.active_human_gate_ids).toEqual(["release"]);
    expect(report.coverage.status).toBe("complete");
  });

  it("preserves sanitized evidence limitations and gives qualified evidence a distinct identity", async () => {
    const secret = `xoxb-${"q".repeat(24)}`;
    const firstEvidence = await makeReleaseEvidence({
      knownLimitations: ["alpha1", `${secret} /Users/private/review.pdf`],
      mutateReceipt(receipts) {
        receipts[0].limitations.push("direct stdio only");
      },
    });
    const secondEvidence = await makeReleaseEvidence({
      knownLimitations: ["bravo2", `${secret} /Users/private/review.pdf`],
      mutateReceipt(receipts) {
        receipts[0].limitations.push("direct stdio only");
      },
    });
    const first = await runReview({
      reviewOptions: {
        candidatePath: firstEvidence.candidatePath,
        expectedCandidateSha256: firstEvidence.candidateSha256,
        releaseEvidencePath: firstEvidence.evidencePath,
      },
    });
    const second = await runReview({
      reviewOptions: {
        candidatePath: secondEvidence.candidatePath,
        expectedCandidateSha256: secondEvidence.candidateSha256,
        releaseEvidencePath: secondEvidence.evidencePath,
      },
    });
    const encoded = JSON.stringify(first.report.release_evidence);

    expect(first.report.release_evidence.status).toBe("automated_checks_pass_with_limitations");
    expect(first.report.release_evidence.known_limitation_count).toBe(2);
    expect(first.report.release_evidence.known_limitations[0]).toBe("alpha1");
    expect(first.report.release_evidence.verified_receipts[0]).toMatchObject({
      receipt_id: "receipt.1",
      limitation_count: 1,
      limitations: ["direct stdio only"],
      observed_at: GENERATED_AT,
    });
    expect(encoded).not.toContain(secret);
    expect(encoded).not.toContain("/Users/private");
    expect(encoded).toContain("[redacted-token]");
    expect(encoded).toContain("[redacted-path]");
    expect(first.report.inferences.map(item => item.id)).toContain("release-evidence.qualified");
    expect(first.report.summary.exit_code).toBe(1);
    expect(first.report.release_evidence.index_sha256).not.toBe(second.report.release_evidence.index_sha256);
    expect(first.report.report_id).not.toBe(second.report.report_id);
  });

  it("marks stale native-host evidence stale and activates both host and release gates", async () => {
    const evidence = await makeReleaseEvidence({
      mutateReceipt(receipts) {
        const windows = receipts.find(receipt => receipt.kind === "native_host_windows_x64");
        windows.source_commit = "d".repeat(40);
      },
    });
    const { report } = await runReview({
      reviewOptions: {
        candidatePath: evidence.candidatePath,
        expectedCandidateSha256: evidence.candidateSha256,
        releaseEvidencePath: evidence.evidencePath,
      },
    });

    expect(report.release_evidence.status).toBe("stale");
    expect(report.release_evidence.stale_receipt_ids).toContain("receipt.6");
    expect(report.summary.active_human_gate_ids).toEqual(["host-access", "release"]);
    expect(report.summary.exit_code).toBe(1);
  });

  it("rejects a stale declared package version without treating automated evidence as ready", async () => {
    const evidence = await makeReleaseEvidence({ packageVersion: "0.8.5" });
    const { report } = await runReview({
      reviewOptions: {
        candidatePath: evidence.candidatePath,
        expectedCandidateSha256: evidence.candidateSha256,
        releaseEvidencePath: evidence.evidencePath,
      },
    });

    expect(report.release_evidence.status).toBe("stale");
    expect(report.summary.active_human_gate_ids).toContain("release");
    expect(report.inferences.map(item => item.id)).toContain("release-evidence.stale");
    expect(report.summary.exit_code).toBe(1);
  });

  it("rejects duplicate release receipt identities as a harness failure", async () => {
    const evidence = await makeReleaseEvidence({
      mutateReceipt(receipts) {
        receipts[1].receipt_id = receipts[0].receipt_id;
      },
    });
    const { report } = await runReview({
      reviewOptions: {
        candidatePath: evidence.candidatePath,
        expectedCandidateSha256: evidence.candidateSha256,
        releaseEvidencePath: evidence.evidencePath,
      },
    });

    expect(report.release_evidence.status).toBe("harness_failure");
    expect(report.coverage.unavailable_source_ids).toContain("release.evidence");
    expect(report.summary.exit_code).toBe(2);
  });

  it("rejects release evidence when retained receipt bytes do not match the index", async () => {
    const evidence = await makeReleaseEvidence();
    await fs.appendFile(evidence.receiptPaths[0], "tampered");
    const { report } = await runReview({
      reviewOptions: {
        candidatePath: evidence.candidatePath,
        expectedCandidateSha256: evidence.candidateSha256,
        releaseEvidencePath: evidence.evidencePath,
      },
    });

    expect(report.release_evidence.status).toBe("harness_failure");
    expect(report.release_evidence.verified_receipt_count).toBe(0);
    expect(report.coverage.unavailable_source_ids).toContain("release.evidence");
    expect(report.summary.exit_code).toBe(2);
  });

  it("treats release input harness failure as partial required evidence", async () => {
    const { report } = await runReview({
      reviewOptions: {
        candidatePath: "candidate-only.mcpb",
      },
    });

    expect(report.release_evidence.status).toBe("harness_failure");
    expect(report.coverage.unavailable_source_ids).toContain("release.evidence");
    expect(report.summary.active_human_gate_ids).toEqual(["release"]);
    expect(report.summary.exit_code).toBe(2);
  });
});

describe("GitHub and Beads reconciliation", () => {
  const githubIssue = [{ number: 42, state: "OPEN" }];
  const parentAndChild = [
    {
      id: "pdf-parent",
      status: "open",
      external_ref: "gh-42",
      review_keys: [],
    },
    {
      id: "pdf-child",
      status: "in_progress",
      external_ref: "gh-42",
      review_keys: [],
    },
  ];

  it("keeps valid parent-child external-reference multiplicity informational", () => {
    const result = calculateGithubBeadsReconciliation(parentAndChild, githubIssue, []);

    expect(result.status).toBe("aligned");
    expect(result.external_ref_multiplicity).toEqual([
      {
        external_ref: "issue:42",
        bead_ids: ["pdf-child", "pdf-parent"],
      },
    ]);
  });

  it("reports explicit canonical review-key conflicts", () => {
    const reviewKey = "e".repeat(64);
    const beads = parentAndChild.map(bead => ({ ...bead, review_keys: [reviewKey] }));
    const result = calculateGithubBeadsReconciliation(beads, githubIssue, []);

    expect(result.status).toBe("findings");
    expect(result.canonical_review_key_conflicts).toEqual([
      {
        review_key: reviewKey,
        bead_ids: ["pdf-child", "pdf-parent"],
      },
    ]);
  });

  it("ignores a retired review-key claimant when active ownership is unique", () => {
    const reviewKey = "e".repeat(64);
    const beads = [
      { ...parentAndChild[0], review_keys: [reviewKey], status: "closed" },
      { ...parentAndChild[1], review_keys: [reviewKey] },
    ];
    const result = calculateGithubBeadsReconciliation(beads, githubIssue, []);

    expect(result.status).toBe("aligned");
    expect(result.canonical_review_key_conflicts).toEqual([]);
  });

  it("reports Beads linked to absent Issues or Pull Requests only for complete collections", () => {
    const beads = [
      {
        id: "missing-issue",
        status: "open",
        external_ref: "gh-404",
        review_keys: [],
      },
      {
        id: "missing-pull",
        status: "closed",
        external_ref: "https://github.com/Open-Document-Alliance/PDF-Tools/pull/405",
        review_keys: [],
      },
    ];
    const complete = calculateGithubBeadsReconciliation(beads, [], []);
    expect(complete.status).toBe("findings");
    expect(complete.beads_linked_to_missing_items).toEqual([
      { external_ref: "issue:404", bead_ids: ["missing-issue"] },
      { external_ref: "pull-request:405", bead_ids: ["missing-pull"] },
    ]);

    const truncated = calculateGithubBeadsReconciliation(beads, [], [], {
      issuesComplete: false,
      pullRequestsComplete: false,
    });
    expect(truncated.beads_linked_to_missing_items).toEqual([]);
    expect(truncated.status).toBe("aligned");
  });
});

describe("bounded primitives", () => {
  it("rejects non-official remote origins before issuing a request", async () => {
    await expect(fetchOfficialJson("http://api.github.com/repos/example")).rejects.toThrow("outside the official allowlist");
    await expect(fetchOfficialJson("https://example.com/data.json")).rejects.toThrow("outside the official allowlist");
    await expect(fetchOfficialJson("https://user:password@api.github.com/data.json")).rejects.toThrow("outside the official allowlist");
  });

  it("bounds child output without exposing an unbounded tail", async () => {
    const result = await runCommandBounded(process.execPath, [
      "-e",
      "process.stdout.write(\"x\".repeat(65536)); setInterval(() => {}, 1000)",
    ], {
      timeoutMs: 5_000,
      maxOutputBytes: 1_024,
      environment: { PATH: process.env.PATH },
    });

    expect(result.outputLimitExceeded).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(1_024);
  });

  it("terminates a timed-out child process group", async () => {
    const result = await runCommandBounded(process.execPath, [
      "-e",
      "setInterval(() => {}, 1000)",
    ], {
      timeoutMs: 20,
      maxOutputBytes: 1_024,
      environment: { PATH: process.env.PATH },
    });

    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(2_000);
  });
});
