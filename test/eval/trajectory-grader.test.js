import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import { generateTrajectoryCalibration } from "../../scripts/eval-generate-trajectory-calibration.mjs";
import { captureTrajectoryToolContracts } from "../../scripts/eval-capture-tool-contracts.mjs";
import {
  ingestCodexTrajectory,
  ingestCodexTrajectoryBatch,
  semanticObservations,
} from "../../scripts/eval-ingest-codex-trajectory.mjs";
import { runTrajectoryEvaluation } from "../../scripts/eval-run-trajectories.mjs";
import {
  gradeTrajectoryTrial,
  loadTrajectorySuite,
  renderObservationReference,
  summarizeTrajectoryTrials,
  trajectoryAttestationPayload,
  validateTrajectorySuite,
  validateTrajectoryTrial,
  validateTrajectoryTrialSet,
} from "./trajectory-grader.js";
import { renderTrustedFixturePng } from "./render-visual-oracle.js";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

const PNG_CRC_TABLE = Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

function pngCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function forgeCrcValidInvalidIdat(encoded) {
  const bytes = Buffer.from(encoded, "base64");
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT") {
      bytes.fill(0, offset + 8, offset + 8 + length);
      bytes.writeUInt32BE(pngCrc32(bytes.subarray(offset + 4, offset + 8 + length)), offset + 8 + length);
    }
    offset += length + 12;
  }
  return bytes.toString("base64");
}

function runPlanFor(id, trials, suite, claimBoundary) {
  const plan = {
    run_plan_schema_version: 1,
    run_plan_id: `${id}.run-plan`,
    trial_set_id: id,
    suite_id: suite.suite_id,
    suite_sha256: digest(canonicalJson(suite)),
    claim_boundary: claimBoundary,
    planned_at: "2026-07-20T23:59:00.000Z",
    planner: "test-launcher",
    attestation: {
      attestation_schema_version: 1,
      kind: "pre_run_plan",
      producer: "test-launcher",
      produced_at: "2026-07-20T23:58:59.000Z",
      key_id: null,
      signature: null,
    },
    entries: trials.map(trial => ({
      invocation_id: trial.sample.invocation_id,
      job_id: trial.job_id,
      repeat_index: trial.repeat_index,
      fixture_instance_sha256: trial.sample.fixture_instance_sha256,
      seed: trial.sample.seed,
      semantic_operation_sha256: trial.sample.semantic_operation_sha256,
    })),
  };
  const planDigest = digest(canonicalJson(plan));
  for (const trial of trials) {
    if (!trial.run?.events) continue;
    trial.run.events = trial.run.events.filter(event => event.type !== "run_plan_committed");
    trial.run.events.unshift({
      event_schema_version: 1,
      event_id: `${trial.run.run_id}.event.run-plan`,
      type: "run_plan_committed",
      source: "test-launcher",
      observed_at: trial.run.started_at,
      reference: `sha256:${planDigest}`,
      provenance: {
        provenance_schema_version: 1,
        authority: trial.run.host.platform === "synthetic" ? "calibration" : "agent_host",
        capture_method: "test_pre_run_commitment",
        raw_sha256: digest(`${trial.run.run_id}:${planDigest}`),
      },
    });
  }
  return plan;
}

function unsignedMeasuredAttestation(suite, trials, runPlan) {
  return {
    attestation_schema_version: 1,
    kind: "measured_ingestion",
    producer: "test-ingester",
    produced_at: "2026-07-21T07:02:00.000Z",
    suite_sha256: digest(canonicalJson(suite)),
    raw_transcript_sha256: "a".repeat(64),
    observer_sha256: "b".repeat(64),
    trial_payload_sha256: digest(canonicalJson(trials)),
    run_plan_sha256: digest(canonicalJson(runPlan)),
    key_id: null,
    signature: null,
  };
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SUITE_PATH = path.join(REPO_ROOT, "test", "fixtures", "eval", "trajectories", "jobs.v1.json");
const TRIALS_PATH = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "trajectories",
  "calibration-trials.v1.json"
);
const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    fs.rm(directory, { recursive: true, force: true })
  ));
});

async function loadFixtures() {
  const suite = await loadTrajectorySuite(SUITE_PATH);
  const trialSet = JSON.parse(await fs.readFile(TRIALS_PATH, "utf8"));
  return { suite, trialSet, jobs: new Map(suite.jobs.map(job => [job.id, job])) };
}

function trialFor(trialSet, suffix, repeatIndex = 1) {
  return structuredClone(trialSet.trials.find(trial =>
    trial.job_id.endsWith(suffix) && trial.repeat_index === repeatIndex
  ));
}

function addFailureRef(trial, name) {
  trial.correction_refs = [{
    bead_id: "pdf-toolkit-mcp-igr.2",
    regression_id: `pdf-tools.regression.trajectory.v1.test.${name}`,
    relationship: "failure",
  }];
}

function check(grade, id) {
  return grade.checks.find(item => item.id === id);
}

describe("agent trajectory grader v4 integrity contract", () => {
  it("publishes six strict representative jobs and rejects undeclared suite fields", async () => {
    const suite = await loadTrajectorySuite(SUITE_PATH);
    expect(validateTrajectorySuite(suite)).toEqual([]);
    expect(suite.jobs).toHaveLength(6);
    expect(suite.measurement_policy).toEqual({
      min_unique_product_trials_per_job: 3,
      confidence_level: 0.95,
      max_harness_failure_rate: 0.1,
      trust_registry_id: "pdf-tools.trajectory.trust.v1",
      corpus_manifest_sha256: "f1313dc562d3466cbb0237adac6c053fafc62029d84d39ee2cb6aae317c9097b",
      tool_contract_id: "pdf-tools.trajectory.tool-contracts.v1",
      tool_contract_sha256: "32634ee8dda75c786362407317c38ebf1576411ce7b3a8113f01a9d9a9efe05d",
      runtime_version: "0.8.6",
    });
    for (const job of suite.jobs) {
      expect(job.starting_state.sources.length).toBeGreaterThan(0);
      expect(job.success_evidence.allowed_sources.length).toBeGreaterThan(0);
      for (const group of job.policy.required_tool_groups) {
        expect(group.required_argument_keys.length).toBeGreaterThan(0);
      }
    }
    const invalid = structuredClone(suite);
    invalid.jobs[0].policy.unscored_escape_hatch = true;
    expect(validateTrajectorySuite(invalid)).toContain(
      "suite.jobs[0].policy.unscored_escape_hatch is not allowed"
    );
  });

  it("regenerates the explicitly synthetic calibration set byte-for-byte", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-trajectory-"));
    temporaryDirectories.push(directory);
    const outputPath = path.join(directory, "calibration.json");
    await generateTrajectoryCalibration({ outputPath });
    expect(await fs.readFile(outputPath, "utf8")).toBe(await fs.readFile(TRIALS_PATH, "utf8"));
  });

  it("binds comparison render expectations to the pinned fixture bytes and page boxes", async () => {
    const suite = await loadTrajectorySuite(SUITE_PATH);
    const job = suite.jobs.find(item => item.id.endsWith("compare-and-explain"));
    const cases = [
      ["before-page-one-render", "dev-page-order-source.pdf"],
      ["after-page-one-render", "dev-page-order-visibly-wrong.pdf"],
    ];
    for (const [observationId, fixtureName] of cases) {
      const expected = job.expected_semantics.required_observations
        .find(item => item.id === observationId).value;
      const bytes = await fs.readFile(path.join(REPO_ROOT, "test", "fixtures", "eval", "synthetic", fixtureName));
      const document = await PDFDocument.load(bytes);
      const { width, height } = document.getPages()[0].getSize();
      expect(expected.source_sha256).toBe(digest(bytes));
      expect(expected.region).toEqual([0, 0, Math.round(width), Math.round(height)]);
    }
  });

  it("regenerates the version-pinned tool contract from real MCP discovery byte-for-byte", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-tool-contract-"));
    temporaryDirectories.push(directory);
    const outputPath = path.join(directory, "tool-contracts.json");
    await captureTrajectoryToolContracts({ outputPath });
    const committed = path.join(
      REPO_ROOT, "test", "fixtures", "eval", "trajectories", "tool-contracts.v1.json"
    );
    expect(await fs.readFile(outputPath, "utf8")).toBe(await fs.readFile(committed, "utf8"));
  });

  it("hashes the real read_pdf_fields currentValue shape for semantic field evidence", async () => {
    const semantic = await semanticObservations({
      tool: "read_pdf_fields",
      arguments: { pdf_path: "output/filled-form.pdf" },
      result: {
        structuredContent: {
          fields: [{ name: "Name", type: "text", options: [], currentValue: "Synthetic Example" }],
        },
      },
    });
    expect(semantic.fields).toEqual([{
      source: "output/filled-form.pdf",
      field: "Name",
      value_sha256: digest("Synthetic Example"),
    }]);
    expect((await semanticObservations({
      tool: "read_pdf_fields",
      arguments: { pdf_path: "output/filled-form.pdf" },
      result: { structuredContent: { fields: [{ name: "Name" }] } },
    })).fields).toEqual([]);
    expect((await semanticObservations({
      tool: "get_pdf_info",
      arguments: { pdf_path: "input/source.pdf" },
      result: { content: [{ type: "text", text: "Pages: 2" }] },
    })).files).toEqual([{ path: "input/source.pdf" }]);
  });

  it("derives render evidence from retained PNG bytes and an external source snapshot", async () => {
    const sourceSha256 = "bca00ea1e9c27e45c58ace3a80d4df0a56db91c15c0e3d812fe3d22a925b2168";
    const rendered = await renderTrustedFixturePng({ sourceSha256, page: 1, scale: 2.5 });
    const png = rendered.png.toString("base64");
    const startedAt = "2026-07-21T07:00:01.000Z";
    const sourceEvent = {
      event_id: "event.source.before",
      type: "filesystem_source_observed",
      observed_at: "2026-07-21T07:00:00.000Z",
      reference: `sha256:${sourceSha256}`,
      provenance: {
        authority: "filesystem_observer",
        capture_method: "filesystem_stat_sha256",
      },
    };
    const item = {
      tool: "render_pdf_page",
      arguments: { pdf_path: "input/before.pdf", page: 1, max_dimension_px: 1200 },
      result: {
        content: [
          { type: "text", text: "Rendered page" },
          { type: "image", mimeType: "image/png", data: png },
        ],
        structuredContent: {
          page: 1,
          width_points: 360,
          height_points: 480,
          rendered_width_px: 900,
          rendered_height_px: 1200,
          scale: 2.5,
          renderer: "native-canvas",
          mime_type: "image/png",
        },
      },
    };
    const observation = {
      started_at: startedAt,
      observed_artifacts: [{
        path: "input/before.pdf",
        exists: true,
        sha256: sourceSha256,
        observer_event_id: sourceEvent.event_id,
        observation_method: "filesystem_stat_sha256",
      }],
    };
    const semantic = await semanticObservations(item, observation, [sourceEvent], "event.render.page");
    expect(semantic.semantic_schema_version).toBe(2);
    expect(semantic.render_regions).toEqual([expect.objectContaining({
      source: "input/before.pdf",
      source_sha256: sourceSha256,
      source_observation_event_id: sourceEvent.event_id,
      page: 1,
      page_box_points: [0, 0, 360, 480],
      region: [0, 0, 360, 480],
      image_byte_length: Buffer.from(png, "base64").length,
      image_content_index: 1,
      render_observation_event_id: "event.render.page",
      server_rendered_width_px: 900,
      server_rendered_height_px: 1200,
      observed_image_width_px: rendered.width,
      observed_image_height_px: rendered.height,
      max_dimension_px: 1200,
      visual_oracle: expect.objectContaining({ passed: true, foreground_iou: 1 }),
    })]);
    expect(semantic.render_regions[0].image_sha256).toBe(digest(Buffer.from(png, "base64")));

    const regionItem = structuredClone(item);
    regionItem.tool = "render_pdf_region";
    regionItem.arguments = {
      pdf_path: "input/before.pdf", page: 2, x: 72, y: 144, width: 180, height: 40,
      max_dimension_px: 1400,
    };
    const regionRendered = await renderTrustedFixturePng({
      sourceSha256, page: 2, scale: 4, region: [72, 144, 180, 40],
    });
    regionItem.result.content[1].data = regionRendered.png.toString("base64");
    regionItem.result.structuredContent = {
      page: 2,
      region_points: { x: 72, y: 144, width: 180, height: 40 },
      rendered_width_px: 720,
      rendered_height_px: 160,
      scale: 4,
      renderer: "native-canvas",
      mime_type: "image/png",
    };
    const regionSemantic = await semanticObservations(
      regionItem, observation, [sourceEvent], "event.render.region",
    );
    expect(regionSemantic.render_regions).toEqual([expect.objectContaining({
      source: "input/before.pdf",
      page: 2,
      page_box_points: null,
      region: [72, 144, 180, 40],
      max_dimension_px: 1400,
    })]);

    await expect(semanticObservations(
      item, { ...observation, observed_artifacts: [] }, [sourceEvent], "event.render.page",
    ))
      .rejects.toThrow(/filesystem-observed source snapshot/);
    const wrongDimensions = structuredClone(item);
    wrongDimensions.result.structuredContent.rendered_width_px = 929;
    await expect(semanticObservations(
      wrongDimensions, observation, [sourceEvent], "event.render.page",
    )).rejects.toThrow(/server render metadata is inconsistent/);
    const blank = structuredClone(item);
    const blankCanvas = createCanvas(rendered.width, rendered.height);
    const blankContext = blankCanvas.getContext("2d");
    blankContext.fillStyle = "white";
    blankContext.fillRect(0, 0, rendered.width, rendered.height);
    blank.result.content[1].data = blankCanvas.toBuffer("image/png").toString("base64");
    await expect(semanticObservations(blank, observation, [sourceEvent], "event.render.page"))
      .rejects.toThrow(/failed the trusted visual oracle/);
    const malformed = structuredClone(item);
    malformed.result.content[1].data = "not-base64";
    await expect(semanticObservations(malformed, observation, [sourceEvent], "event.render.page"))
      .rejects.toThrow(/canonical PNG base64/);
    const corrupt = structuredClone(item);
    const corruptBytes = Buffer.from(png, "base64");
    corruptBytes[45] ^= 0xff;
    corrupt.result.content[1].data = corruptBytes.toString("base64");
    await expect(semanticObservations(corrupt, observation, [sourceEvent], "event.render.page"))
      .rejects.toThrow(/chunk failed CRC validation/);
    const invalidDeflate = structuredClone(item);
    invalidDeflate.result.content[1].data = forgeCrcValidInvalidIdat(png);
    await expect(semanticObservations(
      invalidDeflate, observation, [sourceEvent], "event.render.page",
    )).rejects.toThrow(/IDAT stream cannot be inflated/);
    const duplicateImage = structuredClone(item);
    duplicateImage.result.content.push(structuredClone(duplicateImage.result.content[1]));
    await expect(semanticObservations(
      duplicateImage, observation, [sourceEvent], "event.render.page",
    ))
      .rejects.toThrow(/exactly one image content block/);
    const lateEvent = structuredClone(sourceEvent);
    lateEvent.observed_at = "2026-07-21T07:00:02.000Z";
    await expect(semanticObservations(item, observation, [lateEvent], "event.render.page"))
      .rejects.toThrow(/pre-call filesystem event/);
    const invalidTimeEvent = structuredClone(sourceEvent);
    invalidTimeEvent.observed_at = "not-a-time";
    await expect(semanticObservations(item, observation, [invalidTimeEvent], "event.render.page"))
      .rejects.toThrow(/pre-call filesystem event/);
  });

  it("reports unique sample statistics, Wilson uncertainty, and harness rate without a benchmark claim", async () => {
    const report = await runTrajectoryEvaluation();
    expect(report.calibration).toBe(true);
    expect(report.claim_boundary).toContain("not observed agent or host benchmark results");
    expect(report).toMatchObject({
      attempted_trials: 24,
      product_trials: 18,
      harness_failures: 6,
      harness_failure_rate: 0.25,
      passed_trials: 12,
      macro_pass_rate: 2 / 3,
      sample_size_ready: false,
      independence_ready: false,
      harness_ready: false,
      trust_ready: false,
      benchmark_claim_ready: false,
    });
    expect(report.product_statistics.sample_variance).toBeCloseTo(4 / 17);
    expect(report.product_statistics.confidence_interval).toBeNull();
    for (const job of report.by_job) {
      expect(job).toMatchObject({
        attempted_trials: 4,
        product_trials: 3,
        passed_trials: 2,
        failed_trials: 1,
        harness_failures: 1,
        harness_failure_rate: 0.25,
        sample_size_ready: false,
        independence_ready: false,
        harness_ready: false,
      });
      expect(job.sample_variance).toBeCloseTo(1 / 3);
      expect(job.confidence_interval).toBeNull();
    }
  });

  it("does not count failed or argument-free no-op calls toward required tools", async () => {
    const { trialSet, jobs } = await loadFixtures();
    const failed = trialFor(trialSet, "fill-and-validate");
    const inspection = failed.trajectory[0];
    delete inspection.result;
    inspection.ok = false;
    inspection.error = {
      error_schema_version: 1,
      code: "inspection_failed",
      message: "Observed inspection failure",
      expected: false,
    };
    addFailureRef(failed, "failed-required-call");
    const failedGrade = await gradeTrajectoryTrial(jobs.get(failed.job_id), failed);
    expect(check(failedGrade, "required_tools/inspect_and_read_back_fields").passed).toBe(false);
    expect(check(failedGrade, "unexpected_tool_errors").passed).toBe(false);

    const noOp = trialFor(trialSet, "fill-and-validate");
    noOp.trajectory.find(step => step.tool === "fill_pdf").arguments = {};
    addFailureRef(noOp, "argument-free-call");
    const noOpGrade = await gradeTrajectoryTrial(jobs.get(noOp.job_id), noOp);
    expect(check(noOpGrade, "required_tools/fill_copy").passed).toBe(false);
  });

  it("does not let a later independent read-back retroactively pass a run that skipped pre-inspection", async () => {
    const { trialSet, jobs } = await loadFixtures();
    const trial = trialFor(trialSet, "fill-and-validate");
    trial.trajectory = trial.trajectory.filter((step, index) => index !== 0);
    addFailureRef(trial, "late-readback-is-not-preinspection");
    const grade = await gradeTrajectoryTrial(jobs.get(trial.job_id), trial);
    expect(check(grade, "artifact_integrity").passed).toBe(true);
    expect(check(grade, "verified_artifacts").passed).toBe(true);
    expect(check(grade, "required_tools/inspect_and_read_back_fields").passed).toBe(false);
    expect(check(grade, "inspection_before_mutation").passed).toBe(false);
    expect(grade.passed).toBe(false);
  });

  it("rejects invented evidence and fake comparison sources not observed by their result", async () => {
    const { trialSet, jobs } = await loadFixtures();
    const trial = trialFor(trialSet, "compare-and-explain");
    trial.final_answer.evidence[1].source = "input/before.pdf";
    trial.final_answer.evidence[3].source = "input/before.pdf";
    addFailureRef(trial, "fake-comparison-source");
    const grade = await gradeTrajectoryTrial(jobs.get(trial.job_id), trial);
    expect(grade.passed).toBe(false);
    expect(check(grade, "evidence/result_bindings").passed).toBe(false);
    expect(check(grade, "evidence/source/input/after.pdf").passed).toBe(false);

    const invented = trialFor(trialSet, "inspect-and-answer");
    invented.final_answer.evidence[0].result_id = "invented-result";
    addFailureRef(invented, "invented-result");
    expect(check(
      await gradeTrajectoryTrial(jobs.get(invented.job_id), invented),
      "evidence/result_bindings"
    ).passed).toBe(false);
  });

  it("fails closed when render semantics or their filesystem provenance drift", async () => {
    const { trialSet, jobs } = await loadFixtures();
    const base = trialFor(trialSet, "compare-and-explain");
    const job = jobs.get(base.job_id);

    const missing = structuredClone(base);
    missing.trajectory.find(step => step.tool === "render_pdf_page")
      .result.semantic_observations.render_regions = [];
    const missingGrade = await gradeTrajectoryTrial(job, missing);
    expect(check(missingGrade, "semantic_result_bindings").passed).toBe(false);
    expect(check(missingGrade, "expected_observation/before-page-one-render").passed).toBe(false);
    expect(check(missingGrade, "evidence/result_bindings").passed).toBe(false);

    const wrongRegion = structuredClone(base);
    wrongRegion.trajectory.find(step => step.tool === "render_pdf_page")
      .result.semantic_observations.render_regions[0].region = [0, 0, 359, 480];
    expect(check(await gradeTrajectoryTrial(job, wrongRegion), "semantic_result_bindings").passed).toBe(false);

    const wrongMaxDimension = structuredClone(base);
    wrongMaxDimension.trajectory.find(step => step.tool === "render_pdf_page")
      .result.semantic_observations.render_regions[0].max_dimension_px = 1199;
    expect(check(await gradeTrajectoryTrial(job, wrongMaxDimension), "semantic_result_bindings").passed).toBe(false);

    const forgedRender = structuredClone(base);
    for (const step of forgedRender.trajectory.filter(item => item.tool === "render_pdf_page")) {
      Object.assign(step.result.semantic_observations.render_regions[0], {
        image_sha256: "0".repeat(64),
        image_byte_length: 57,
        image_content_index: 999,
        server_renderer: "forged-renderer",
        server_rendered_width_px: 1,
        server_rendered_height_px: 1,
        server_scale: 999,
        observed_image_width_px: 1,
        observed_image_height_px: 1,
      });
    }
    const forgedGrade = await gradeTrajectoryTrial(job, forgedRender);
    expect(forgedGrade.passed).toBe(false);
    expect(check(forgedGrade, "trial_schema").passed).toBe(false);
    expect(check(forgedGrade, "semantic_result_bindings").passed).toBe(false);

    const imageDigestDrift = structuredClone(base);
    const driftStep = imageDigestDrift.trajectory.find(step => step.tool === "render_pdf_page");
    const driftRender = driftStep.result.semantic_observations.render_regions[0];
    driftRender.image_sha256 = "0".repeat(64);
    imageDigestDrift.run.events.find(event => event.event_id === driftRender.render_observation_event_id)
      .reference = renderObservationReference(driftRender);
    expect(check(await gradeTrajectoryTrial(job, imageDigestDrift), "semantic_result_bindings").passed).toBe(false);

    const retainedRawDrift = structuredClone(base);
    retainedRawDrift.trajectory.find(step => step.tool === "render_pdf_page")
      .result.retained_raw_result.content[1].data = TINY_PNG_BASE64.replace(/.$/, "A");
    expect(check(await gradeTrajectoryTrial(job, retainedRawDrift), "semantic_result_bindings").passed).toBe(false);

    const untrustedEvent = structuredClone(base);
    const render = untrustedEvent.trajectory.find(step => step.tool === "render_pdf_page")
      .result.semantic_observations.render_regions[0];
    untrustedEvent.run.events.find(event => event.event_id === render.source_observation_event_id)
      .provenance.authority = "ingester";
    expect(check(await gradeTrajectoryTrial(job, untrustedEvent), "semantic_result_bindings").passed).toBe(false);

    const fabricated = structuredClone(base);
    const textStep = fabricated.trajectory.find(step => step.tool === "read_pdf_pages");
    textStep.result.semantic_observations.render_regions = structuredClone(
      fabricated.trajectory.find(step => step.tool === "render_pdf_page")
        .result.semantic_observations.render_regions,
    );
    expect(check(await gradeTrajectoryTrial(job, fabricated), "semantic_result_bindings").passed).toBe(false);
  });

  it("rejects self-verification and requires path/hash agreement in producer and later verifier results", async () => {
    const { trialSet, jobs } = await loadFixtures();
    const trial = trialFor(trialSet, "safe-page-mutation");
    trial.artifacts[0].verification_step_id = trial.artifacts[0].producer_step_id;
    addFailureRef(trial, "self-verification");
    expect(check(
      await gradeTrajectoryTrial(jobs.get(trial.job_id), trial),
      "verified_artifacts"
    ).passed).toBe(false);

    const forgedHash = trialFor(trialSet, "safe-page-mutation");
    forgedHash.artifacts[0].sha256 = "0".repeat(64);
    addFailureRef(forgedHash, "forged-hash");
    expect(check(
      await gradeTrajectoryTrial(jobs.get(forgedHash.job_id), forgedHash),
      "verified_artifacts"
    ).passed).toBe(false);
  });

  it("rejects render evidence that does not pass the trusted visual oracle", async () => {
    const { trialSet, jobs } = await loadFixtures();
    const trial = trialFor(trialSet, "compare-and-explain");
    const render = trial.trajectory.find(step => step.tool === "render_pdf_page")
      .result.semantic_observations.render_regions[0];
    render.visual_oracle.foreground_iou = 0;
    render.visual_oracle.passed = false;
    const grade = await gradeTrajectoryTrial(jobs.get(trial.job_id), trial);
    expect(grade.passed).toBe(false);
    expect(check(grade, "trial_schema").actual).toEqual(expect.arrayContaining([
      expect.stringContaining("trusted perceptual thresholds"),
    ]));

    const blankSubstitution = trialFor(trialSet, "compare-and-explain");
    const blankStep = blankSubstitution.trajectory.find(step => step.tool === "render_pdf_page");
    const blankRender = blankStep.result.semantic_observations.render_regions[0];
    const canvas = createCanvas(
      blankRender.observed_image_width_px,
      blankRender.observed_image_height_px,
    );
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const blankPng = canvas.toBuffer("image/png");
    blankStep.result.retained_raw_result.content[1].data = blankPng.toString("base64");
    blankRender.image_sha256 = digest(blankPng);
    blankRender.image_byte_length = blankPng.length;
    blankStep.result.raw_result_sha256 = digest(JSON.stringify(blankStep.result.retained_raw_result));
    const blankEvent = blankSubstitution.run.events.find(
      event => event.event_id === blankRender.render_observation_event_id
    );
    blankEvent.reference = renderObservationReference(blankRender);
    blankEvent.provenance.raw_sha256 = blankStep.result.raw_result_sha256;
    const blankGrade = await gradeTrajectoryTrial(jobs.get(blankSubstitution.job_id), blankSubstitution);
    expect(blankGrade.passed).toBe(false);
    expect(check(blankGrade, "semantic_result_bindings").passed).toBe(false);
  });

  it("rejects success mislabeled as an expected error and undeclared effect keys", async () => {
    const { trialSet, jobs } = await loadFixtures();
    const trial = trialFor(trialSet, "inspect-and-answer");
    trial.trajectory[0].expected_error = true;
    trial.effects.network = [];
    addFailureRef(trial, "schema-smuggling");
    const grade = await gradeTrajectoryTrial(jobs.get(trial.job_id), trial);
    expect(grade.passed).toBe(false);
    expect(check(grade, "trial_schema").actual).toEqual(expect.arrayContaining([
      expect.stringContaining("expected_error is not allowed"),
      expect.stringContaining("effects.network is not allowed"),
    ]));
  });

  it("rejects bare harness failures without phase, event, and retained provenance", async () => {
    const { suite, trialSet, jobs } = await loadFixtures();
    const trial = trialFor(trialSet, "inspect-and-answer", 4);
    trial.harness_failure = { code: "timeout" };
    trial.run.events = [];
    const errors = validateTrajectoryTrial(jobs.get(trial.job_id), trial);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("run.events must contain observed host events"),
      expect.stringContaining("harness_failure.phase is required"),
      expect.stringContaining("must bind to a harness_failure run event"),
    ]));
    const invalidSet = structuredClone(trialSet);
    invalidSet.trials = [trial];
    expect(validateTrajectoryTrialSet(suite, invalidSet).length).toBeGreaterThan(0);
  });

  it("fails closed instead of throwing on malformed nested arrays", async () => {
    const { suite, trialSet, jobs } = await loadFixtures();

    const malformedSemantics = trialFor(trialSet, "compare-and-explain");
    malformedSemantics.trajectory[0].result.semantic_observations.pages = {};
    const semanticsJob = jobs.get(malformedSemantics.job_id);
    expect(() => validateTrajectoryTrial(semanticsJob, malformedSemantics)).not.toThrow();
    expect(validateTrajectoryTrial(semanticsJob, malformedSemantics)).toContain(
      "trial.trajectory[0].result.semantic_observations.pages must be an array",
    );
    await expect(gradeTrajectoryTrial(semanticsJob, malformedSemantics)).resolves.toBeDefined();
    expect(check(await gradeTrajectoryTrial(semanticsJob, malformedSemantics), "trial_schema").passed)
      .toBe(false);

    const malformedEvents = trialFor(trialSet, "compare-and-explain");
    malformedEvents.run.events = {};
    const eventsJob = jobs.get(malformedEvents.job_id);
    expect(() => validateTrajectoryTrial(eventsJob, malformedEvents)).not.toThrow();
    expect(validateTrajectoryTrial(eventsJob, malformedEvents)).toContain(
      "trial.run.events must contain observed host events",
    );
    await expect(gradeTrajectoryTrial(eventsJob, malformedEvents)).resolves.toBeDefined();
    expect(check(await gradeTrajectoryTrial(eventsJob, malformedEvents), "trial_schema").passed)
      .toBe(false);

    const malformedPlan = structuredClone(trialSet);
    malformedPlan.run_plan.entries = {};
    expect(() => validateTrajectoryTrialSet(suite, malformedPlan)).not.toThrow();
    expect(validateTrajectoryTrialSet(suite, malformedPlan)).toContain(
      "trial_set.run_plan.entries must be non-empty",
    );

    const base = trialFor(trialSet, "compare-and-explain");
    const baseJob = jobs.get(base.job_id);
    const malformedMembers = [
      ["null run event", candidate => { candidate.run.events[0] = null; }],
      ["wrong-typed effect collection", candidate => { candidate.effects.created = {}; }],
      ["wrong-typed observed artifacts", candidate => {
        candidate.trajectory.find(step => step.tool === "render_pdf_page")
          .result.observed_artifacts = {};
      }],
      ["null artifact", candidate => { candidate.artifacts = [null]; }],
      ["null evidence", candidate => { candidate.final_answer.evidence = [null]; }],
      ["null semantic page", candidate => {
        candidate.trajectory[0].result.semantic_observations.pages = [null];
      }],
      ["null render region", candidate => {
        candidate.trajectory.find(step => step.tool === "render_pdf_page")
          .result.semantic_observations.render_regions = [null];
      }],
      ["null observed artifact", candidate => {
        candidate.trajectory.find(step => step.tool === "render_pdf_page")
          .result.observed_artifacts = [null];
      }],
      ["null claim", candidate => { candidate.final_answer.claims = [null]; }],
      ["wrong-typed correction references", candidate => { candidate.correction_refs = {}; }],
    ];
    for (const [label, mutate] of malformedMembers) {
      const candidate = structuredClone(base);
      mutate(candidate);
      expect(() => validateTrajectoryTrial(baseJob, candidate), label).not.toThrow();
      expect(validateTrajectoryTrial(baseJob, candidate).length, label).toBeGreaterThan(0);
      await expect(gradeTrajectoryTrial(baseJob, candidate), label).resolves.toBeDefined();
      expect(check(await gradeTrajectoryTrial(baseJob, candidate), "trial_schema").passed, label).toBe(false);

      const candidateSet = structuredClone(trialSet);
      const index = candidateSet.trials.findIndex(trial => trial.trial_id === candidate.trial_id);
      candidateSet.trials[index] = candidate;
      expect(() => validateTrajectoryTrialSet(suite, candidateSet), label).not.toThrow();
      expect(validateTrajectoryTrialSet(suite, candidateSet).length, label).toBeGreaterThan(0);
    }

    const malformedField = trialFor(trialSet, "fill-and-validate");
    const fieldJob = jobs.get(malformedField.job_id);
    malformedField.trajectory.at(-1).result.semantic_observations.fields = [null];
    expect(() => validateTrajectoryTrial(fieldJob, malformedField)).not.toThrow();
    expect(validateTrajectoryTrial(fieldJob, malformedField).length).toBeGreaterThan(0);
    await expect(gradeTrajectoryTrial(fieldJob, malformedField)).resolves.toBeDefined();
    expect(check(await gradeTrajectoryTrial(fieldJob, malformedField), "trial_schema").passed).toBe(false);

    for (const [label, mutate] of [
      ["null run-plan entry", candidate => { candidate.run_plan.entries[0] = null; }],
      ["null trial member", candidate => { candidate.trials[0] = null; }],
    ]) {
      const candidate = structuredClone(trialSet);
      mutate(candidate);
      expect(() => validateTrajectoryTrialSet(suite, candidate), label).not.toThrow();
      expect(validateTrajectoryTrialSet(suite, candidate).length, label).toBeGreaterThan(0);
    }
  });

  it("rejects duplicate job repeats, run IDs, and host event IDs", async () => {
    const { suite, trialSet } = await loadFixtures();
    const first = trialFor(trialSet, "inspect-and-answer", 1);
    const duplicate = structuredClone(first);
    duplicate.trial_id = `${duplicate.trial_id}.copy`;
    const invalidSet = {
      trial_set_schema_version: 1,
      trial_set_id: "duplicates",
      suite_id: suite.suite_id,
      calibration: false,
      claim_boundary: "Negative validation fixture only.",
      trials: [first, duplicate],
    };
    expect(validateTrajectoryTrialSet(suite, invalidSet)).toEqual(expect.arrayContaining([
      expect.stringContaining("duplicate run id"),
      expect.stringContaining("duplicate job repeat"),
      expect.stringContaining("duplicate host event id"),
    ]));
  });

  it("requires ok:false followed by a bound allowed success for recovery", async () => {
    const { trialSet, jobs } = await loadFixtures();
    const trial = trialFor(trialSet, "error-recovery");
    const denied = trial.trajectory[0];
    denied.ok = true;
    delete denied.error;
    denied.result = {
      result_schema_version: 1,
      result_id: `${trial.run.run_id}.result.denied-as-success`,
      raw_result_sha256: "1".repeat(64),
      observed_sources: [],
      observed_artifacts: [],
    };
    addFailureRef(trial, "success-as-error");
    expect(check(
      await gradeTrajectoryTrial(jobs.get(trial.job_id), trial),
      "error_recovery"
    ).passed).toBe(false);

    const unbound = trialFor(trialSet, "error-recovery");
    delete unbound.trajectory[1].recovery_of_step_id;
    addFailureRef(unbound, "unbound-recovery");
    expect(check(
      await gradeTrajectoryTrial(jobs.get(unbound.job_id), unbound),
      "error_recovery"
    ).passed).toBe(false);
  });

  it("reuses production signing-intent rules and requires matching user host-event provenance", async () => {
    const { trialSet, jobs } = await loadFixtures();
    const stale = trialFor(trialSet, "prepare-for-signature", 3);
    const apply = stale.trajectory.find(step => step.tool === "apply_signature");
    const event = stale.run.events.find(item => item.event_id === stale.intent.host_event_id);
    stale.intent.source = "user";
    stale.intent.statement = "x";
    stale.intent.confirmed_at = new Date(Date.parse(apply.started_at) - 48 * 60 * 60 * 1000).toISOString();
    event.type = "user_intent_confirmed";
    event.source = "user";
    event.observed_at = stale.intent.confirmed_at;
    apply.arguments.user_intent_statement = stale.intent.statement;
    apply.arguments.user_confirmed_at = stale.intent.confirmed_at;
    const staleGrade = await gradeTrajectoryTrial(jobs.get(stale.job_id), stale);
    expect(check(staleGrade, "human_intent")).toMatchObject({ passed: false });
    expect(check(staleGrade, "human_intent").actual.errors[0].error).toMatch(/too short/);

    const unproven = trialFor(trialSet, "prepare-for-signature", 3);
    unproven.intent.source = "user";
    const unprovenApply = unproven.trajectory.find(step => step.tool === "apply_signature");
    unproven.intent.statement = "I, Synthetic User, sign this calibration document now.";
    unproven.intent.confirmed_at = new Date(Date.parse(unprovenApply.started_at) - 60 * 1000).toISOString();
    unprovenApply.arguments.user_intent_statement = unproven.intent.statement;
    unprovenApply.arguments.user_confirmed_at = unproven.intent.confirmed_at;
    const unprovenGrade = await gradeTrajectoryTrial(jobs.get(unproven.job_id), unproven);
    expect(check(unprovenGrade, "human_intent").actual).toMatchObject({
      provenance_valid: false,
      production_valid: true,
    });
  });

  it("accepts measured non-calibration sets while preserving sample and claim boundaries", async () => {
    const { suite, trialSet } = await loadFixtures();
    const measuredTrial = trialFor(trialSet, "inspect-and-answer", 1);
    measuredTrial.agent = "codex-cli";
    measuredTrial.model = "measured-test-model";
    measuredTrial.run.host = { name: "test-host", version: "1", platform: "linux-x64" };
    for (const event of measuredTrial.run.events) {
      event.source = "measured_test_harness";
      event.provenance.authority = new Set([
        "effects_observed", "input_snapshot_observed", "fixture_instance_observed",
      ]).has(event.type) ? "filesystem_observer" : "ingester";
      event.provenance.capture_method = "measured_test_capture";
      event.provenance.raw_sha256 = digest(event.event_id);
    }
    const measured = {
      trial_set_schema_version: 1,
      trial_set_id: "pdf-tools.trajectory.measured.test.v1",
      suite_id: suite.suite_id,
      calibration: false,
      claim_boundary: "One measured synthetic test-host run; insufficient for an agent benchmark claim.",
      trials: [measuredTrial],
    };
    measured.run_plan = runPlanFor(measured.trial_set_id, measured.trials, suite, measured.claim_boundary);
    measured.attestation = unsignedMeasuredAttestation(suite, measured.trials, measured.run_plan);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-measured-"));
    temporaryDirectories.push(directory);
    const trialsPath = path.join(directory, "measured.json");
    await fs.writeFile(trialsPath, `${JSON.stringify(measured, null, 2)}\n`);
    const report = await runTrajectoryEvaluation({ trialsPath });
    expect(report).toMatchObject({
      calibration: false,
      product_trials: 1,
      passed_trials: 1,
      sample_size_ready: false,
      benchmark_claim_ready: false,
      trust_ready: false,
      independence_ready: false,
    });
    expect(report.product_statistics.pass_rate).toBe(1);
    expect(report.product_statistics.sample_variance).toBeNull();
    expect(report.product_statistics.confidence_interval).toBeNull();

    const relabeledCalibration = structuredClone(measured);
    relabeledCalibration.trials = [trialFor(trialSet, "inspect-and-answer", 1)];
    relabeledCalibration.run_plan = runPlanFor(
      relabeledCalibration.trial_set_id, relabeledCalibration.trials, suite, relabeledCalibration.claim_boundary
    );
    relabeledCalibration.attestation = unsignedMeasuredAttestation(
      suite, relabeledCalibration.trials, relabeledCalibration.run_plan
    );
    expect(validateTrajectoryTrialSet(suite, relabeledCalibration)).toEqual(expect.arrayContaining([
      expect.stringContaining("may not use a synthetic host"),
      expect.stringContaining("may not reuse calibration provenance"),
    ]));
  });

  it("ingests raw Codex MCP events but fails a real-shaped fill run with no inspection or terminal answer", async () => {
    const { suite } = await loadFixtures();
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-codex-ingest-"));
    temporaryDirectories.push(directory);
    const rawPath = path.join(directory, "codex.jsonl");
    const observerPath = path.join(directory, "observer.json");
    const planPath = path.join(directory, "run-plan.json");
    const outputPath = path.join(directory, "measured.json");
    const artifact = {
      path: "output/filled-form.pdf",
      exists: true,
      sha256: "8e7a2c45d5896bf697161cb18aeb47703e2198f71f8e0eaccbf16cffdf33a617",
    };
    const rawEvents = [
      {
        type: "item.completed",
        item: {
          id: "item-host-warning",
          type: "error",
          message: "Skill descriptions were shortened to fit the 2% skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest.",
        },
      },
      {
        type: "item.started",
        item: {
          id: "fill-call", type: "mcp_tool_call", server: "pdf_tools", tool: "fill_pdf",
          arguments: {
            pdf_path: "input/form.pdf", output_path: artifact.path,
            field_data: { Name: "Synthetic Example" }, flatten: false, overwrite: false,
          },
        },
      },
      {
        type: "item.completed",
        item: {
          id: "fill-call",
          type: "mcp_tool_call",
          server: "pdf_tools",
          tool: "fill_pdf",
          arguments: {
            pdf_path: "input/form.pdf",
            output_path: artifact.path,
            field_data: { Name: "Synthetic Example" },
            flatten: false,
            overwrite: false,
          },
          status: "completed",
          error: null,
          result: { content: [{ type: "text", text: "Filled PDF" }], structured_content: { output_path: artifact.path } },
        },
      },
      {
        type: "item.started",
        item: {
          id: "validate-call", type: "mcp_tool_call", server: "pdf_tools", tool: "validate_pdf",
          arguments: { pdf_path: artifact.path },
        },
      },
      {
        type: "item.completed",
        item: {
          id: "validate-call",
          type: "mcp_tool_call",
          server: "pdf_tools",
          tool: "validate_pdf",
          arguments: { pdf_path: artifact.path },
          status: "completed",
          error: null,
          result: { content: [{ type: "text", text: "22 fields / 21 filled / 1 empty" }] },
        },
      },
    ];
    await fs.writeFile(rawPath, `${rawEvents.map(event => JSON.stringify(event)).join("\n")}\n`);
    const runId = "pdf-tools.measured.codex.w9.run.1";
    const effectsEventId = `${runId}.event.effects`;
    const artifactEventId = `${runId}.event.artifact`;
    const observedArtifact = {
      ...artifact,
      observer_event_id: artifactEventId,
      observation_method: "filesystem_stat_sha256",
    };
    const observer = {
      observer_schema_version: 1,
      trial_set_id: "pdf-tools.trajectory.measured.codex.w9.v1",
      suite_id: "pdf-tools.trajectory.v1",
      trial_id: "pdf-tools.trajectory.v1.fill-and-validate.measured.1",
      job_id: "pdf-tools.trajectory.v1.fill-and-validate",
      repeat_index: 1,
      agent: "codex-cli",
      model: "measured-headless-run",
      outcome: "completed",
      harness_failure: null,
      claim_boundary: "One ad hoc headless Codex run; product-failure reproduction, not an agent benchmark.",
      sample: {
        input_sha256: "dbae1d3279aa5c7a1c6365c2155c71758f1e9d417ce7f1ad1bb25287f7893978",
        fixture_instance_sha256: "dbae1d3279aa5c7a1c6365c2155c71758f1e9d417ce7f1ad1bb25287f7893978",
        seed: "codex-w9-1",
        invocation_id: `${runId}.invocation`,
      },
      run: {
        run_schema_version: 1,
        run_id: runId,
        started_at: "2026-07-21T07:00:00.000Z",
        finished_at: "2026-07-21T07:01:00.000Z",
        host: { name: "silvercloud", version: "codex-cli", platform: "linux-x64" },
        events: [{
          event_schema_version: 1,
          event_id: `${runId}.event.input-snapshot`,
          type: "input_snapshot_observed",
          source: "filesystem_capture",
          observed_at: "2026-07-21T07:00:00.000Z",
          reference: `sha256:${"dbae1d3279aa5c7a1c6365c2155c71758f1e9d417ce7f1ad1bb25287f7893978"}`,
          provenance: {
            provenance_schema_version: 1,
            authority: "filesystem_observer",
            capture_method: "filesystem_manifest_sha256",
            raw_sha256: "a".repeat(64),
          },
        }, {
          event_schema_version: 1,
          event_id: `${runId}.event.fixture-instance`,
          type: "fixture_instance_observed",
          source: "filesystem_capture",
          observed_at: "2026-07-21T07:00:00.000Z",
          reference: `sha256:${"dbae1d3279aa5c7a1c6365c2155c71758f1e9d417ce7f1ad1bb25287f7893978"}`,
          provenance: {
            provenance_schema_version: 1,
            authority: "filesystem_observer",
            capture_method: "filesystem_manifest_sha256",
            raw_sha256: "b".repeat(64),
          },
        }, {
          event_schema_version: 1,
          event_id: effectsEventId,
          type: "effects_observed",
          source: "filesystem_capture",
          observed_at: "2026-07-21T07:00:50.000Z",
          reference: "source-sha256:dbae1d3279aa5c7a1c6365c2155c71758f1e9d417ce7f1ad1bb25287f7893978",
          provenance: {
            provenance_schema_version: 1,
            authority: "filesystem_observer",
            capture_method: "filesystem_diff",
            raw_sha256: "c".repeat(64),
          },
        }, {
          event_schema_version: 1,
          event_id: artifactEventId,
          type: "filesystem_artifact_observed",
          source: "filesystem_capture",
          observed_at: "2026-07-21T07:00:51.000Z",
          reference: `sha256:${artifact.sha256}`,
          provenance: {
            provenance_schema_version: 1,
            authority: "filesystem_observer",
            capture_method: "filesystem_stat_sha256",
            raw_sha256: "d".repeat(64),
          },
        }],
      },
      call_observations: {
        "fill-call": {
          started_at: "2026-07-21T07:00:10.000Z",
          finished_at: "2026-07-21T07:00:20.000Z",
          observed_sources: ["input/form.pdf"],
          observed_artifacts: [observedArtifact],
        },
        "validate-call": {
          started_at: "2026-07-21T07:00:30.000Z",
          finished_at: "2026-07-21T07:00:40.000Z",
          observed_sources: [],
          observed_artifacts: [observedArtifact],
        },
      },
      effects: {
        effects_schema_version: 1,
        observer_event_id: effectsEventId,
        created: [artifact.path],
        modified: [],
        deleted: [],
        external_requests: [],
        signature_applied: false,
      },
      artifacts: [{
        path: artifact.path,
        exists: artifact.exists,
        sha256: artifact.sha256,
        producer_item_id: "fill-call",
        verification_item_id: "validate-call",
        observation_event_id: artifactEventId,
      }],
      final_answer_annotations: { evidence: [], claims: [], limitations: [] },
      correction_refs: [{
        bead_id: "pdf-toolkit-mcp-igr.2",
        regression_id: "pdf-tools.regression.trajectory.v1.fill-and-validate.missing-inspection-and-answer",
        relationship: "failure",
      }],
    };
    const job = suite.jobs.find(item => item.id === observer.job_id);
    const runPlan = runPlanFor(observer.trial_set_id, [{
      job_id: observer.job_id,
      repeat_index: observer.repeat_index,
      sample: {
        ...observer.sample,
        semantic_operation_sha256: digest(canonicalJson(job.expected_semantics)),
      },
    }], suite, observer.claim_boundary);
    observer.run.events.unshift({
      event_schema_version: 1,
      event_id: `${observer.run.run_id}.event.run-plan`,
      type: "run_plan_committed",
      source: "codex_launcher",
      observed_at: observer.run.started_at,
      reference: `sha256:${digest(canonicalJson(runPlan))}`,
      provenance: {
        provenance_schema_version: 1,
        authority: "agent_host",
        capture_method: "pre_run_plan_commitment",
        raw_sha256: digest(canonicalJson(runPlan)),
      },
    });
    await fs.writeFile(planPath, `${JSON.stringify(runPlan, null, 2)}\n`);
    await fs.writeFile(observerPath, `${JSON.stringify(observer, null, 2)}\n`);
    const trialSet = await ingestCodexTrajectory({ rawPath, observerPath, planPath, outputPath });
    expect(trialSet.calibration).toBe(false);
    expect(trialSet.trials[0].run.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "agent_host_diagnostic",
        provenance: expect.objectContaining({ capture_method: "codex_exec_jsonl_host_diagnostic" }),
      }),
    ]));
    expect(trialSet.trials[0].final_answer).toMatchObject({ present: false, raw_message_sha256: null });
    const report = await runTrajectoryEvaluation({ trialsPath: outputPath });
    expect(report).toMatchObject({ product_trials: 1, passed_trials: 0, benchmark_claim_ready: false });
    const result = report.results[0];
    expect(check(result, "required_tools/inspect_and_read_back_fields").passed).toBe(false);
    expect(check(result, "terminal_answer").passed).toBe(false);
    expect(check(result, "required_tools/fill_copy").passed).toBe(true);
    expect(check(result, "required_tools/validate_output").passed).toBe(true);
    expect(check(result, "artifact_integrity").passed).toBe(true);
    expect(check(result, "verified_artifacts").passed).toBe(false);
    expect(check(result, "inspection_before_mutation").passed).toBe(false);

    const fillCompleted = rawEvents.find(event => event.type === "item.completed" && event.item.id === "fill-call");
    fillCompleted.item.result = null;
    await fs.writeFile(rawPath, `${rawEvents.map(event => JSON.stringify(event)).join("\n")}\n`);
    await expect(ingestCodexTrajectory({ rawPath, observerPath, planPath })).rejects.toThrow(/non-null MCP result/);
    fillCompleted.item.result = { not_mcp_content: true };
    await fs.writeFile(rawPath, `${rawEvents.map(event => JSON.stringify(event)).join("\n")}\n`);
    await expect(ingestCodexTrajectory({ rawPath, observerPath, planPath })).rejects.toThrow(/content or structured_content/);
    fillCompleted.item.result = { content: [] };
    await fs.writeFile(rawPath, `${rawEvents.map(event => JSON.stringify(event)).join("\n")}\n`);
    await expect(ingestCodexTrajectory({ rawPath, observerPath, planPath })).rejects.toThrow(/content or structured_content/);
    fillCompleted.item.result = { content: [{ type: "text", text: "Filled PDF" }] };
    rawEvents.push({
      type: "item.completed",
      item: {
        id: "foreign-call", type: "mcp_tool_call", server: "other_server", tool: "read",
        arguments: {}, status: "completed", error: null, result: { content: [] },
      },
    });
    await fs.writeFile(rawPath, `${rawEvents.map(event => JSON.stringify(event)).join("\n")}\n`);
    await expect(ingestCodexTrajectory({ rawPath, observerPath, planPath })).rejects.toThrow(/outside the pdf_tools server/);

    rawEvents.pop();
    rawEvents.push({
      type: "item.started",
      item: { id: "active-exfil", type: "mcp_tool_call", server: "other_server", tool: "exfiltrate" },
    });
    await fs.writeFile(rawPath, `${rawEvents.map(event => JSON.stringify(event)).join("\n")}\n`);
    await expect(ingestCodexTrajectory({ rawPath, observerPath, planPath })).rejects.toThrow(/outside the pdf_tools server/);
    rawEvents.pop();

    rawEvents.push({
      type: "item.started",
      item: { id: "unfinished-pdf", type: "mcp_tool_call", server: "pdf_tools", tool: "get_pdf_info" },
    });
    await fs.writeFile(rawPath, `${rawEvents.map(event => JSON.stringify(event)).join("\n")}\n`);
    await expect(ingestCodexTrajectory({ rawPath, observerPath, planPath })).rejects.toThrow(/unfinished items/);
    rawEvents.pop();

    rawEvents.push({
      type: "item.started",
      item: { id: "unfinished-message", type: "agent_message" },
    });
    await fs.writeFile(rawPath, `${rawEvents.map(event => JSON.stringify(event)).join("\n")}\n`);
    await expect(ingestCodexTrajectory({ rawPath, observerPath, planPath })).rejects.toThrow(/unfinished items/);
    rawEvents.pop();

    for (const itemType of ["command_execution", "file_change", "web_search", "error"]) {
      rawEvents.push({ type: "item.completed", item: { id: `hidden-${itemType}`, type: itemType } });
      await fs.writeFile(rawPath, `${rawEvents.map(event => JSON.stringify(event)).join("\n")}\n`);
      await expect(ingestCodexTrajectory({ rawPath, observerPath, planPath })).rejects.toThrow(
        new RegExp(`unnormalized item type ${itemType}`)
      );
      rawEvents.pop();
    }

    const terminalStatusIndex = rawEvents.findIndex(event =>
      event.type === "item.completed" && event.item?.type === "mcp_tool_call"
    );
    const originalTerminalStatus = rawEvents[terminalStatusIndex].item.status;
    rawEvents[terminalStatusIndex].item.status = "mystery";
    await fs.writeFile(rawPath, `${rawEvents.map(event => JSON.stringify(event)).join("\n")}\n`);
    await expect(ingestCodexTrajectory({ rawPath, observerPath, planPath })).rejects.toThrow(
      /unsupported terminal status mystery/
    );
    rawEvents[terminalStatusIndex].item.status = originalTerminalStatus;

    const fillStarted = rawEvents.find(event => event.type === "item.started" && event.item.id === "fill-call");
    const originalStartedArguments = structuredClone(fillStarted.item.arguments);
    fillStarted.item.arguments = { ...fillStarted.item.arguments, output_path: "output/other.pdf" };
    await fs.writeFile(rawPath, `${rawEvents.map(event => JSON.stringify(event)).join("\n")}\n`);
    await expect(ingestCodexTrajectory({ rawPath, observerPath, planPath })).rejects.toThrow(
      /changed arguments before completion/,
    );
    fillStarted.item.arguments = originalStartedArguments;

    const invalidObserver = structuredClone(observer);
    invalidObserver.call_observations["fill-call"].observed_artifacts[0].observation_method = "tool_self_report";
    await fs.writeFile(observerPath, `${JSON.stringify(invalidObserver, null, 2)}\n`);
    await fs.writeFile(rawPath, `${rawEvents.map(event => JSON.stringify(event)).join("\n")}\n`);
    await expect(ingestCodexTrajectory({ rawPath, observerPath, planPath })).rejects.toThrow(/filesystem_stat_sha256/);

    const rewrittenErrorObserver = structuredClone(observer);
    rewrittenErrorObserver.call_observations["fill-call"].error_code = "path_policy_denied";
    await fs.writeFile(observerPath, `${JSON.stringify(rewrittenErrorObserver, null, 2)}\n`);
    await expect(ingestCodexTrajectory({ rawPath, observerPath, planPath })).rejects.toThrow(/unknown: error_code/);

    const relabeledHarnessObserver = structuredClone(observer);
    relabeledHarnessObserver.outcome = "harness_failure";
    relabeledHarnessObserver.harness_failure = {
      harness_schema_version: 1,
      code: "curated_product_failure",
      phase: "host_session",
      detail: "Attempted to remove a product execution from the product denominator",
      event_id: effectsEventId,
    };
    await fs.writeFile(observerPath, `${JSON.stringify(relabeledHarnessObserver, null, 2)}\n`);
    await expect(ingestCodexTrajectory({ rawPath, observerPath, planPath })).rejects.toThrow(
      /cannot be relabeled as a harness failure/
    );

    const fillEvent = rawEvents.find(event => event.type === "item.completed" && event.item.id === "fill-call");
    const successfulFillResult = fillEvent.item.result;
    fillEvent.item.status = "failed";
    fillEvent.item.error = { code: "ECONNRESET", message: "socket reset" };
    fillEvent.item.result = null;
    observer.call_observations["fill-call"].expected_error = true;
    await fs.writeFile(observerPath, `${JSON.stringify(observer, null, 2)}\n`);
    await fs.writeFile(rawPath, `${rawEvents.map(event => JSON.stringify(event)).join("\n")}\n`);
    const rawErrorTrial = await ingestCodexTrajectory({ rawPath, observerPath, planPath });
    expect(rawErrorTrial.trials[0].trajectory[0].error).toMatchObject({ code: "ECONNRESET" });

    fillEvent.item.status = "completed";
    fillEvent.item.error = null;
    fillEvent.item.result = {
      content: [{ type: "text", text: "Error: path is outside the allowed directories" }],
      structured_content: {
        status: "failed",
        error: { error_schema_version: 1, code: "path_policy_denied" },
      },
      isError: true,
    };
    await fs.writeFile(rawPath, `${rawEvents.map(event => JSON.stringify(event)).join("\n")}\n`);
    const toolErrorTrial = await ingestCodexTrajectory({ rawPath, observerPath, planPath });
    expect(toolErrorTrial.trials[0].trajectory[0].error).toMatchObject({ code: "path_policy_denied" });

    fillEvent.item.status = "completed";
    fillEvent.item.error = null;
    fillEvent.item.result = successfulFillResult;
    delete observer.call_observations["fill-call"].expected_error;

    await fs.writeFile(observerPath, `${JSON.stringify(observer, null, 2)}\n`);
    const answerEvent = {
      type: "item.completed",
      item: { id: "answer", type: "agent_message", text: "Completed the fill." },
    };
    const turnEvent = { type: "turn.completed", usage: {} };
    await fs.writeFile(rawPath, `${[answerEvent, ...rawEvents, turnEvent].map(event => JSON.stringify(event)).join("\n")}\n`);
    await expect(ingestCodexTrajectory({ rawPath, observerPath, planPath })).rejects.toThrow(/must follow the final MCP tool call/);
    await fs.writeFile(rawPath, `${[...rawEvents, answerEvent].map(event => JSON.stringify(event)).join("\n")}\n`);
    await expect(ingestCodexTrajectory({ rawPath, observerPath, planPath })).rejects.toThrow(/turn\.completed/);
  });

  it("normalizes a planned launch failure as a harness failure instead of omitting it", async () => {
    const { suite } = await loadFixtures();
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-harness-ingest-"));
    temporaryDirectories.push(directory);
    const rawPath = path.join(directory, "codex.jsonl");
    const observerPath = path.join(directory, "observer.json");
    const planPath = path.join(directory, "run-plan.json");
    const completedRaw = [
      { type: "thread.started", thread_id: "thread-1" },
      { type: "turn.started" },
      { type: "turn.completed", usage: {} },
    ];
    const raw = completedRaw.slice(0, 2);
    await fs.writeFile(rawPath, `${raw.map(event => JSON.stringify(event)).join("\n")}\n`);
    const runId = "pdf-tools.measured.harness.run.1";
    const eventId = `${runId}.event.harness-failure`;
    const observer = {
      observer_schema_version: 1,
      trial_set_id: "pdf-tools.trajectory.measured.harness.v1",
      suite_id: "pdf-tools.trajectory.v1",
      trial_id: "pdf-tools.trajectory.v1.inspect-and-answer.harness.1",
      job_id: "pdf-tools.trajectory.v1.inspect-and-answer",
      repeat_index: 1,
      agent: "codex-cli",
      model: "measured-headless-run",
      outcome: "harness_failure",
      claim_boundary: "One harness launch failure; no benchmark claim.",
      sample: {
        input_sha256: "1".repeat(64),
        fixture_instance_sha256: "2".repeat(64),
        seed: "harness-1",
        invocation_id: `${runId}.invocation`,
      },
      run: {
        run_schema_version: 1,
        run_id: runId,
        started_at: "2026-07-21T07:00:00.000Z",
        finished_at: "2026-07-21T07:01:00.000Z",
        host: { name: "silvercloud", version: "codex-cli", platform: "linux-x64" },
        events: [{
          event_schema_version: 1,
          event_id: `${runId}.event.input-snapshot`,
          type: "input_snapshot_observed",
          source: "filesystem_capture",
          observed_at: "2026-07-21T07:00:00.000Z",
          reference: `sha256:${"1".repeat(64)}`,
          provenance: {
            provenance_schema_version: 1,
            authority: "filesystem_observer",
            capture_method: "filesystem_manifest_sha256",
            raw_sha256: "4".repeat(64),
          },
        }, {
          event_schema_version: 1,
          event_id: `${runId}.event.fixture-instance`,
          type: "fixture_instance_observed",
          source: "filesystem_capture",
          observed_at: "2026-07-21T07:00:00.000Z",
          reference: `sha256:${"2".repeat(64)}`,
          provenance: {
            provenance_schema_version: 1,
            authority: "filesystem_observer",
            capture_method: "filesystem_manifest_sha256",
            raw_sha256: "5".repeat(64),
          },
        }, {
          event_schema_version: 1,
          event_id: eventId,
          type: "harness_failure",
          source: "codex_launcher",
          observed_at: "2026-07-21T07:00:59.000Z",
          reference: "sha256:" + "3".repeat(64),
          provenance: {
            provenance_schema_version: 1,
            authority: "agent_host",
            capture_method: "launcher_exit_status",
            raw_sha256: "3".repeat(64),
          },
        }],
      },
      call_observations: {},
      effects: {},
      artifacts: [],
      final_answer_annotations: { evidence: [], claims: [], limitations: [] },
      correction_refs: [],
      harness_failure: {
        harness_schema_version: 1,
        code: "session_limit",
        phase: "host_session",
        detail: "Host rejected the planned launch",
        event_id: eventId,
      },
    };
    const job = suite.jobs.find(item => item.id === observer.job_id);
    const runPlan = runPlanFor(observer.trial_set_id, [{
      job_id: observer.job_id,
      repeat_index: observer.repeat_index,
      sample: {
        ...observer.sample,
        semantic_operation_sha256: digest(canonicalJson(job.expected_semantics)),
      },
    }], suite, observer.claim_boundary);
    observer.run.events.unshift({
      event_schema_version: 1,
      event_id: `${observer.run.run_id}.event.run-plan`,
      type: "run_plan_committed",
      source: "codex_launcher",
      observed_at: observer.run.started_at,
      reference: `sha256:${digest(canonicalJson(runPlan))}`,
      provenance: {
        provenance_schema_version: 1,
        authority: "agent_host",
        capture_method: "pre_run_plan_commitment",
        raw_sha256: digest(canonicalJson(runPlan)),
      },
    });
    await fs.writeFile(planPath, `${JSON.stringify(runPlan, null, 2)}\n`);
    await fs.writeFile(observerPath, `${JSON.stringify(observer, null, 2)}\n`);
    await fs.writeFile(rawPath, `${completedRaw.map(event => JSON.stringify(event)).join("\n")}\n`);
    await expect(ingestCodexTrajectory({ rawPath, observerPath, planPath })).rejects.toThrow(
      /completed no-tool turn is a product trial/,
    );
    await fs.writeFile(rawPath, `${raw.map(event => JSON.stringify(event)).join("\n")}\n`);
    const trialSet = await ingestCodexTrajectory({ rawPath, observerPath, planPath });
    expect(trialSet.run_plan.entries).toHaveLength(1);
    expect(trialSet.trials[0]).toMatchObject({ outcome: "harness_failure" });
    const report = await summarizeTrajectoryTrials(suite, trialSet.trials, {
      calibration: false,
      attestation: trialSet.attestation,
      trialSetId: trialSet.trial_set_id,
      claimBoundary: trialSet.claim_boundary,
      runPlan: trialSet.run_plan,
    });
    expect(report).toMatchObject({ attempted_trials: 1, product_trials: 0, harness_failures: 1 });

    const secondRunId = "pdf-tools.measured.harness.run.2";
    const secondObserver = JSON.parse(JSON.stringify(observer).replaceAll(runId, secondRunId));
    secondObserver.trial_id = "pdf-tools.trajectory.v1.inspect-and-answer.harness.2";
    secondObserver.repeat_index = 2;
    secondObserver.sample.seed = "harness-2";
    const batchPlan = runPlanFor(observer.trial_set_id, [observer, secondObserver].map(item => ({
      job_id: item.job_id,
      repeat_index: item.repeat_index,
      sample: {
        ...item.sample,
        semantic_operation_sha256: digest(canonicalJson(job.expected_semantics)),
      },
    })), suite, observer.claim_boundary);
    const batchPlanDigest = digest(canonicalJson(batchPlan));
    for (const item of [observer, secondObserver]) {
      item.run.events = item.run.events.filter(event => event.type !== "run_plan_committed");
      item.run.events.unshift({
        event_schema_version: 1,
        event_id: `${item.run.run_id}.event.run-plan`,
        type: "run_plan_committed",
        source: "codex_launcher",
        observed_at: item.run.started_at,
        reference: `sha256:${batchPlanDigest}`,
        provenance: {
          provenance_schema_version: 1,
          authority: "agent_host",
          capture_method: "pre_run_plan_commitment",
          raw_sha256: batchPlanDigest,
        },
      });
    }
    const secondObserverPath = path.join(directory, "observer-2.json");
    await fs.writeFile(planPath, `${JSON.stringify(batchPlan, null, 2)}\n`);
    await fs.writeFile(observerPath, `${JSON.stringify(observer, null, 2)}\n`);
    await fs.writeFile(secondObserverPath, `${JSON.stringify(secondObserver, null, 2)}\n`);
    const batch = await ingestCodexTrajectoryBatch({
      runs: [
        { rawPath, observerPath },
        { rawPath, observerPath: secondObserverPath },
      ],
      planPath,
    });
    expect(batch).toMatchObject({
      trial_set_id: observer.trial_set_id,
      trials: [{ outcome: "harness_failure" }, { outcome: "harness_failure" }],
    });
    expect(batch.run_plan.entries).toHaveLength(2);
  });

  it("binds sources to path arguments and artifact hashes to independent filesystem events", async () => {
    const { trialSet, jobs } = await loadFixtures();
    const sourceForgery = trialFor(trialSet, "inspect-and-answer");
    sourceForgery.trajectory[0].result.observed_sources = ["input/after.pdf"];
    addFailureRef(sourceForgery, "source-not-in-arguments");
    const sourceGrade = await gradeTrajectoryTrial(jobs.get(sourceForgery.job_id), sourceForgery);
    expect(check(sourceGrade, "trial_schema").actual).toEqual(expect.arrayContaining([
      expect.stringContaining("not bound to a path argument"),
    ]));

    const artifactForgery = trialFor(trialSet, "safe-page-mutation");
    const artifactEvent = artifactForgery.run.events.find(event =>
      event.event_id === artifactForgery.artifacts[0].observation_event_id);
    artifactEvent.provenance.authority = "ingester";
    artifactEvent.reference = `sha256:${"0".repeat(64)}`;
    addFailureRef(artifactForgery, "untrusted-filesystem-hash");
    const artifactGrade = await gradeTrajectoryTrial(jobs.get(artifactForgery.job_id), artifactForgery);
    expect(check(artifactGrade, "artifact_integrity").passed).toBe(false);

    const decoyOutput = trialFor(trialSet, "fill-and-validate");
    decoyOutput.trajectory.find(step => step.tool === "fill_pdf").arguments.output_path = "output/decoy.pdf";
    addFailureRef(decoyOutput, "artifact-decoy-output");
    expect(check(
      await gradeTrajectoryTrial(jobs.get(decoyOutput.job_id), decoyOutput), "artifact_integrity"
    ).passed).toBe(false);

    const unrelatedVerifier = trialFor(trialSet, "fill-and-validate");
    unrelatedVerifier.trajectory.find(step =>
      step.step_id === unrelatedVerifier.artifacts[0].verification_step_id).arguments.pdf_path = "input/form.pdf";
    addFailureRef(unrelatedVerifier, "artifact-unrelated-verifier");
    expect(check(
      await gradeTrajectoryTrial(jobs.get(unrelatedVerifier.job_id), unrelatedVerifier), "artifact_integrity"
    ).passed).toBe(false);

    const earlyObservation = trialFor(trialSet, "fill-and-validate");
    const observationEvent = earlyObservation.run.events.find(event =>
      event.event_id === earlyObservation.artifacts[0].observation_event_id);
    observationEvent.observed_at = earlyObservation.run.started_at;
    addFailureRef(earlyObservation, "artifact-observed-before-mutation");
    expect(check(
      await gradeTrajectoryTrial(jobs.get(earlyObservation.job_id), earlyObservation), "artifact_integrity"
    ).passed).toBe(false);

    const inFlightObservation = trialFor(trialSet, "fill-and-validate");
    const verifier = inFlightObservation.trajectory.find(step =>
      step.step_id === inFlightObservation.artifacts[0].verification_step_id);
    const inFlightEvent = inFlightObservation.run.events.find(event =>
      event.event_id === inFlightObservation.artifacts[0].observation_event_id);
    inFlightEvent.observed_at = new Date(Date.parse(verifier.started_at) + 500).toISOString();
    expect(Date.parse(inFlightEvent.observed_at)).toBeLessThan(Date.parse(verifier.finished_at));
    expect(check(
      await gradeTrajectoryTrial(jobs.get(inFlightObservation.job_id), inFlightObservation), "artifact_integrity"
    ).passed).toBe(false);
  });

  it("rejects every historical hand-authored argument mismatch against the discovered schemas", async () => {
    const { trialSet, jobs } = await loadFixtures();

    const wrongPage = trialFor(trialSet, "inspect-and-answer");
    wrongPage.trajectory[0].arguments = { pdf_path: "input/source.pdf", start_page: 1, end_page: 1 };
    const pageGrade = await gradeTrajectoryTrial(jobs.get(wrongPage.job_id), wrongPage);
    expect(check(pageGrade, "semantic_result_bindings").passed).toBe(false);
    expect(check(pageGrade, "expected_semantics/inspect-page-two").passed).toBe(false);
    expect(check(pageGrade, "evidence/result_bindings").passed).toBe(true);
    expect(pageGrade.passed).toBe(false);

    const wrongFill = trialFor(trialSet, "fill-and-validate");
    const fill = wrongFill.trajectory.find(step => step.tool === "fill_pdf");
    fill.arguments.field_values = fill.arguments.field_data;
    delete fill.arguments.field_data;
    const fillGrade = await gradeTrajectoryTrial(jobs.get(wrongFill.job_id), wrongFill);
    expect(check(fillGrade, "trial_schema").actual).toEqual(expect.arrayContaining([
      expect.stringContaining("field_data is required by the runtime tool schema"),
    ]));
    expect(check(fillGrade, "expected_semantics/fill-known-fields").passed).toBe(false);

    const wrongPlan = trialFor(trialSet, "safe-page-mutation");
    const plan = wrongPlan.trajectory.find(step => step.tool === "apply_page_plan");
    plan.arguments = {
      pdf_path: plan.arguments.input_path,
      output_path: plan.arguments.output_path,
      page_plan: [{ source_page: 2 }, { source_page: 1 }],
    };
    const planGrade = await gradeTrajectoryTrial(jobs.get(wrongPlan.job_id), wrongPlan);
    expect(check(planGrade, "trial_schema").actual).toEqual(expect.arrayContaining([
      expect.stringContaining("input_path is required by the runtime tool schema"),
      expect.stringContaining("plan is required by the runtime tool schema"),
    ]));
    expect(check(planGrade, "expected_semantics/reverse-pages").passed).toBe(false);

    const extraMutation = trialFor(trialSet, "safe-page-mutation");
    const extraPlan = extraMutation.trajectory.find(step => step.tool === "apply_page_plan");
    extraPlan.arguments.plan.rotations = { "1": 90 };
    extraPlan.result.semantic_observations.page_plans[0].rotations = { "1": 90 };
    const extraMutationGrade = await gradeTrajectoryTrial(jobs.get(extraMutation.job_id), extraMutation);
    expect(check(extraMutationGrade, "semantic_result_bindings").passed).toBe(true);
    expect(check(extraMutationGrade, "expected_semantics/reverse-pages").passed).toBe(false);
    expect(extraMutationGrade.passed).toBe(false);

    const wrongSignature = trialFor(trialSet, "prepare-for-signature");
    const prepare = wrongSignature.trajectory.find(step => step.tool === "prepare_signing_packet");
    prepare.arguments.signature_fields = prepare.arguments.signature_locations;
    delete prepare.arguments.signature_locations;
    const signatureGrade = await gradeTrajectoryTrial(jobs.get(wrongSignature.job_id), wrongSignature);
    expect(check(signatureGrade, "required_tools/prepare_packet").passed).toBe(false);
    expect(check(signatureGrade, "expected_semantics/prepare-known-signature-location").passed).toBe(false);
    expect(check(signatureGrade, "semantic_result_bindings").passed).toBe(false);

    const wrongAnswer = trialFor(trialSet, "inspect-and-answer");
    wrongAnswer.final_answer.answer_value_sha256 = digest(canonicalJson({ marker: "PAGE ONE - PORTRAIT", page: 1 }));
    expect(check(
      await gradeTrajectoryTrial(jobs.get(wrongAnswer.job_id), wrongAnswer), "answer_correctness"
    ).passed).toBe(false);
  });

  it("requires the terminal answer after the final tool call and before completed-turn provenance", async () => {
    const { trialSet, jobs } = await loadFixtures();
    const trial = trialFor(trialSet, "inspect-and-answer");
    const message = trial.run.events.find(event => event.event_id === trial.final_answer.message_event_id);
    const turn = trial.run.events.find(event => event.event_id === trial.final_answer.turn_completed_event_id);
    message.observed_at = new Date(Date.parse(trial.trajectory[0].started_at) - 1).toISOString();
    turn.observed_at = new Date(Date.parse(message.observed_at) - 1).toISOString();
    addFailureRef(trial, "answer-before-final-call");
    expect(check(await gradeTrajectoryTrial(jobs.get(trial.job_id), trial), "terminal_answer").passed).toBe(false);

    const inFlight = trialFor(trialSet, "inspect-and-answer");
    const inFlightStep = inFlight.trajectory[0];
    const inFlightMessage = inFlight.run.events.find(event =>
      event.event_id === inFlight.final_answer.message_event_id);
    const inFlightTurn = inFlight.run.events.find(event =>
      event.event_id === inFlight.final_answer.turn_completed_event_id);
    inFlightMessage.observed_at = new Date(Date.parse(inFlightStep.started_at) + 500).toISOString();
    inFlightTurn.observed_at = new Date(Date.parse(inFlightMessage.observed_at) + 1).toISOString();
    expect(Date.parse(inFlightMessage.observed_at)).toBeLessThan(Date.parse(inFlightStep.finished_at));
    expect(check(
      await gradeTrajectoryTrial(jobs.get(inFlight.job_id), inFlight), "terminal_answer"
    ).passed).toBe(false);
  });

  it("requires raw denied-call semantics and the declared denied argument before recovery", async () => {
    const { trialSet, jobs } = await loadFixtures();
    const missingRaw = trialFor(trialSet, "error-recovery");
    missingRaw.trajectory[0].error.raw_error_sha256 = "not-a-digest";
    addFailureRef(missingRaw, "recovery-without-raw-failure");
    const missingRawGrade = await gradeTrajectoryTrial(jobs.get(missingRaw.job_id), missingRaw);
    expect(check(missingRawGrade, "trial_schema").passed).toBe(false);
    expect(check(missingRawGrade, "error_recovery").passed).toBe(false);

    const wrongDeniedArgument = trialFor(trialSet, "error-recovery");
    wrongDeniedArgument.trajectory[0].arguments.pdf_path = "input/source.pdf";
    addFailureRef(wrongDeniedArgument, "wrong-denied-argument");
    expect(check(
      await gradeTrajectoryTrial(jobs.get(wrongDeniedArgument.job_id), wrongDeniedArgument),
      "error_recovery"
    ).passed).toBe(false);
  });

  it("does not treat cloned samples as independent or emit Wilson bounds", async () => {
    const { suite, trialSet } = await loadFixtures();
    const original = trialFor(trialSet, "inspect-and-answer", 1);
    const oldRunId = original.run.run_id;
    const trials = [1, 2, 3].map(index => {
      const clone = JSON.parse(JSON.stringify(original).replaceAll(oldRunId, `${oldRunId}.clone.${index}`));
      clone.trial_id = `${original.job_id}.clone.${index}`;
      clone.repeat_index = index;
      clone.sample.seed = `unique-seed-${index}`;
      clone.sample.invocation_id = `unique-invocation-${index}`;
      clone.sample.transcript_sha256 = digest(`unique-transcript-${index}`);
      clone.trajectory[0].arguments.max_chars_per_page = 4_000 + index;
      clone.agent = "codex-cli";
      clone.model = "clone-detection-test";
      clone.run.host = { name: "test-host", version: "1", platform: "linux-x64" };
      for (const event of clone.run.events) {
        event.source = "measured_test_capture";
        event.provenance.authority = new Set([
          "effects_observed", "input_snapshot_observed", "fixture_instance_observed",
        ]).has(event.type) ? "filesystem_observer" : "ingester";
        event.provenance.capture_method = "measured_test_capture";
        event.provenance.raw_sha256 = digest(event.event_id);
      }
      return clone;
    });
    const cloneBoundary = "Clone detection test; no benchmark claim.";
    const runPlan = runPlanFor("pdf-tools.trajectory.clone-test.v1", trials, suite, cloneBoundary);
    const attestation = unsignedMeasuredAttestation(suite, trials, runPlan);
    const report = await summarizeTrajectoryTrials(suite, trials, {
      calibration: false,
      attestation,
      trialSetId: "pdf-tools.trajectory.clone-test.v1",
      claimBoundary: cloneBoundary,
      runPlan,
    });
    const job = report.by_job.find(item => item.job_id.endsWith("inspect-and-answer"));
    expect(job).toMatchObject({ product_trials: 3, independence_ready: false, sample_size_ready: false });
    expect(job.confidence_interval).toBeNull();
  });

  it("validates human signing intent at every signature application timestamp", async () => {
    const { trialSet, jobs } = await loadFixtures();
    const trial = trialFor(trialSet, "prepare-for-signature", 3);
    const firstApply = trial.trajectory.find(step => step.tool === "apply_signature");
    const intentEvent = trial.run.events.find(event => event.event_id === trial.intent.host_event_id);
    trial.intent.source = "user";
    trial.intent.statement = "I authorize these signature applications to this test document.";
    trial.intent.confirmed_at = new Date(Date.parse(firstApply.started_at) - 10_000).toISOString();
    intentEvent.type = "user_intent_confirmed";
    intentEvent.source = "user";
    intentEvent.observed_at = trial.intent.confirmed_at;
    firstApply.arguments.user_intent_statement = trial.intent.statement;
    firstApply.arguments.user_confirmed_at = trial.intent.confirmed_at;
    const lateApply = structuredClone(firstApply);
    lateApply.step_id = `${trial.run.run_id}.step.late-signature`;
    lateApply.result.result_id = `${trial.run.run_id}.result.late-signature`;
    lateApply.started_at = new Date(Date.parse(trial.intent.confirmed_at) + 25 * 60 * 60 * 1000).toISOString();
    trial.trajectory.push(lateApply);
    trial.run.finished_at = new Date(Date.parse(lateApply.started_at) + 60_000).toISOString();
    addFailureRef(trial, "intent-expired-on-later-signature");
    const grade = await gradeTrajectoryTrial(jobs.get(trial.job_id), trial);
    expect(check(grade, "human_intent")).toMatchObject({ passed: false });
    expect(check(grade, "human_intent").actual.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ step_id: lateApply.step_id }),
    ]));
  });

  it("enforces the approved suite, corpus, and correction-lineage registries", async () => {
    const { suite, trialSet, jobs } = await loadFixtures();
    const unapprovedSuite = structuredClone(suite);
    unapprovedSuite.jobs[0].category = "invented_category";
    unapprovedSuite.jobs[0].starting_state.fixtures = ["pdf-tools.eval.v1.invented"];
    expect(validateTrajectorySuite(unapprovedSuite)).toEqual(expect.arrayContaining([
      expect.stringContaining("version-pinned approved suite digest"),
      expect.stringContaining("category is not approved"),
      expect.stringContaining("fixture pdf-tools.eval.v1.invented is not approved"),
    ]));

    const trial = trialFor(trialSet, "inspect-and-answer");
    trial.final_answer.claims[0].evidence_ids = [];
    trial.correction_refs = [{
      bead_id: "pdf-toolkit-mcp-fake",
      regression_id: "pdf-tools.regression.trajectory.v1.fake",
      relationship: "failure",
    }];
    const grade = await gradeTrajectoryTrial(jobs.get(trial.job_id), trial);
    expect(check(grade, "trial_schema").actual).toEqual(expect.arrayContaining([
      expect.stringContaining("bead_id is not in the approved lineage registry"),
    ]));
    expect(check(grade, "failure_linkage").passed).toBe(false);

    for (const mutate of [
      candidate => { candidate.measurement_policy.min_unique_product_trials_per_job = 1; },
      candidate => { candidate.jobs[0].prompt = "A weakened prompt"; },
      candidate => { candidate.jobs[0].policy.forbidden_tools = []; },
      candidate => { candidate.measurement_policy.max_harness_failure_rate = 0.9; },
    ]) {
      const candidate = structuredClone(suite);
      mutate(candidate);
      expect(validateTrajectorySuite(candidate)).toContain(
        "suite content does not match the version-pinned approved suite digest"
      );
    }

    const crossJob = trialFor(trialSet, "inspect-and-answer");
    crossJob.final_answer.claims[0].evidence_ids = [];
    crossJob.correction_refs = [{
      bead_id: "pdf-toolkit-mcp-igr.2",
      regression_id: "pdf-tools.regression.trajectory.v1.fill-and-validate.failed-required-call",
      relationship: "failure",
    }];
    const crossJobGrade = await gradeTrajectoryTrial(jobs.get(crossJob.job_id), crossJob);
    expect(check(crossJobGrade, "trial_schema").actual).toEqual(expect.arrayContaining([
      expect.stringContaining("regression_id is not in the approved lineage registry"),
    ]));
    expect(check(crossJobGrade, "failure_linkage").passed).toBe(false);

    const sameJobWrongFailure = trialFor(trialSet, "inspect-and-answer");
    const messageEvent = sameJobWrongFailure.run.events.find(event =>
      event.event_id === sameJobWrongFailure.final_answer.message_event_id);
    messageEvent.observed_at = new Date(Date.parse(sameJobWrongFailure.trajectory[0].started_at) - 1).toISOString();
    sameJobWrongFailure.correction_refs = [{
      bead_id: "pdf-toolkit-mcp-igr.2",
      regression_id: "pdf-tools.regression.trajectory.v1.inspect-and-answer.unsupported-claim",
      relationship: "failure",
    }];
    const sameJobWrongGrade = await gradeTrajectoryTrial(jobs.get(sameJobWrongFailure.job_id), sameJobWrongFailure);
    expect(check(sameJobWrongGrade, "terminal_answer").passed).toBe(false);
    expect(check(sameJobWrongGrade, "failure_linkage")).toMatchObject({
      passed: false,
      actual: { uncovered_checks: expect.arrayContaining(["terminal_answer"]) },
    });
  });

  it("prevents unsigned or modified measured JSON from becoming benchmark-claim ready", async () => {
    const { suite, trialSet } = await loadFixtures();
    const trials = [trialFor(trialSet, "inspect-and-answer", 1)];
    const measured = {
      trial_set_schema_version: 1,
      trial_set_id: "pdf-tools.trajectory.measured.untrusted.v1",
      suite_id: suite.suite_id,
      calibration: false,
      claim_boundary: "Unsigned test ingestion; no benchmark claim.",
      trials,
    };
    measured.run_plan = runPlanFor(measured.trial_set_id, measured.trials, suite, measured.claim_boundary);
    measured.attestation = unsignedMeasuredAttestation(suite, trials, measured.run_plan);
    const signedPayload = trajectoryAttestationPayload(measured);
    for (const mutate of [
      candidate => { candidate.claim_boundary = "Widened benchmark claim"; },
      candidate => { candidate.attestation.kind = "synthetic_calibration"; },
      candidate => { candidate.attestation.producer = "unapproved-rewriter"; },
      candidate => { candidate.attestation.key_id = "different-key"; },
    ]) {
      const candidate = structuredClone(measured);
      mutate(candidate);
      expect(trajectoryAttestationPayload(candidate)).not.toBe(signedPayload);
    }
    measured.trials[0].agent = "modified-after-attestation";
    expect(validateTrajectoryTrialSet(suite, measured)).toContain(
      "trial_set.attestation.trial_payload_sha256 does not bind the trial payload"
    );

    const omittedLaunch = structuredClone(measured);
    omittedLaunch.attestation.trial_payload_sha256 = digest(canonicalJson(omittedLaunch.trials));
    omittedLaunch.run_plan.entries.push({
      ...omittedLaunch.run_plan.entries[0],
      invocation_id: "planned-but-omitted",
      repeat_index: 2,
    });
    omittedLaunch.attestation.run_plan_sha256 = digest(canonicalJson(omittedLaunch.run_plan));
    expect(validateTrajectoryTrialSet(suite, omittedLaunch)).toContain(
      "run-plan invocation planned-but-omitted has no product or harness-failure record"
    );
  });

  it("makes failed product trials carry canonical Bead and regression lineage", async () => {
    const { trialSet, jobs } = await loadFixtures();
    const missing = trialFor(trialSet, "inspect-and-answer");
    missing.final_answer.claims[0].evidence_ids = [];
    const grade = await gradeTrajectoryTrial(jobs.get(missing.job_id), missing);
    expect(check(grade, "failure_linkage").passed).toBe(false);

    const calibratedFailure = trialFor(trialSet, "inspect-and-answer", 3);
    const calibratedGrade = await gradeTrajectoryTrial(jobs.get(calibratedFailure.job_id), calibratedFailure);
    expect(check(calibratedGrade, "failure_linkage").passed).toBe(true);
    expect(calibratedGrade.correction_refs[0]).toEqual({
      bead_id: "pdf-toolkit-mcp-igr.2",
      regression_id: "pdf-tools.regression.trajectory.v1.inspect-and-answer.unsupported-claim",
      relationship: "failure",
    });

    const acceptedFix = trialFor(trialSet, "inspect-and-answer", 1);
    acceptedFix.correction_refs = [{
      bead_id: "pdf-toolkit-mcp-igr.2",
      regression_id: "pdf-tools.regression.trajectory.v1.inspect-and-answer.accepted-fix",
      relationship: "accepted_fix",
    }];
    expect((await gradeTrajectoryTrial(jobs.get(acceptedFix.job_id), acceptedFix)).passed).toBe(true);
  });
});
