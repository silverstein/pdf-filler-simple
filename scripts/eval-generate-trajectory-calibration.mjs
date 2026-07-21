#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTrajectorySuite } from "../test/eval/trajectory-grader.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SUITE = path.join(REPO_ROOT, "test", "fixtures", "eval", "trajectories", "jobs.v1.json");
const DEFAULT_OUTPUT = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "trajectories",
  "calibration-trials.v1.json"
);

function slug(jobId) {
  return jobId.replace("pdf-tools.trajectory.v1.", "");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function artifactObservation(context, outputPath, fixtureIdentity) {
  return {
    path: outputPath,
    exists: true,
    sha256: digest(`synthetic-calibration:${fixtureIdentity}`),
    observer_event_id: context.artifactEventId,
    observation_method: "synthetic_calibration",
  };
}

function sourceObservation(context, sourcePath, sourceSha256, label) {
  return {
    path: sourcePath,
    exists: true,
    sha256: sourceSha256,
    observer_event_id: `${context.runId}.event.source.${label}`,
    observation_method: "synthetic_calibration",
  };
}

function timestamp(context, seconds) {
  return new Date(context.startedAt + seconds * 1000).toISOString();
}

function emptySemantics(values = {}) {
  return {
    semantic_schema_version: 2,
    pages: values.pages ?? [],
    fields: values.fields ?? [],
    page_plans: values.page_plans ?? [],
    signature_locations: values.signature_locations ?? [],
    render_regions: values.render_regions ?? [],
    files: values.files ?? [],
  };
}

function successStep(context, ordinal, tool, args, {
  sources = [], artifacts = [], semantics = emptySemantics(), recoveryOf = null,
} = {}) {
  return {
    step_schema_version: 2,
    step_id: `${context.runId}.step.${ordinal}`,
    tool,
    started_at: timestamp(context, ordinal * 5),
    finished_at: timestamp(context, ordinal * 5 + 1),
    arguments: args,
    ok: true,
    result: {
      result_schema_version: 1,
      result_id: `${context.runId}.result.${ordinal}`,
      raw_result_sha256: digest(JSON.stringify({ tool, args, sources, artifacts })),
      observed_sources: sources,
      observed_artifacts: artifacts,
      semantic_observations: semantics,
    },
    ...(recoveryOf ? { recovery_of_step_id: recoveryOf } : {}),
  };
}

function failedStep(context, ordinal, tool, args, code, expected = true) {
  const rawError = { code, message: `Synthetic calibration error: ${code}` };
  return {
    step_schema_version: 2,
    step_id: `${context.runId}.step.${ordinal}`,
    tool,
    started_at: timestamp(context, ordinal * 5),
    finished_at: timestamp(context, ordinal * 5 + 1),
    arguments: args,
    ok: false,
    error: {
      error_schema_version: 1,
      code,
      message: rawError.message,
      expected,
      raw_error_sha256: digest(JSON.stringify(rawError)),
    },
  };
}

function evidence(id, kind, source, resultId, details = {}) {
  return { evidence_schema_version: 1, id, kind, source, result_id: resultId, ...details };
}

function claim(id, evidenceIds) {
  return { claim_schema_version: 1, id, important: true, evidence_ids: evidenceIds };
}

function completedRun(jobId, jobIndex, repeatIndex) {
  const short = slug(jobId);
  const startedAt = Date.parse("2026-07-21T00:00:00.000Z") + jobIndex * 60 * 60 * 1000 + repeatIndex * 5 * 60 * 1000;
  const runId = `pdf-tools.synthetic.${short}.run.${repeatIndex}`;
  const effectsEventId = `${runId}.event.effects`;
  const artifactEventId = `${runId}.event.artifact`;
  const messageEventId = `${runId}.event.agent-message`;
  const turnEventId = `${runId}.event.turn-completed`;
  const provenance = (authority, captureMethod, raw) => ({
    provenance_schema_version: 1,
    authority,
    capture_method: captureMethod,
    raw_sha256: digest(raw),
  });
  return {
    context: { runId, startedAt, effectsEventId, artifactEventId, messageEventId, turnEventId },
    run: {
      run_schema_version: 1,
      run_id: runId,
      started_at: new Date(startedAt).toISOString(),
      finished_at: new Date(startedAt + 90 * 1000).toISOString(),
      host: { name: "trajectory-calibration-generator", version: "1", platform: "synthetic" },
      events: [
        {
          event_schema_version: 1,
          event_id: `${runId}.event.input-snapshot`,
          type: "input_snapshot_observed",
          source: "synthetic_calibration_generator",
          observed_at: new Date(startedAt).toISOString(),
          reference: `sha256:${digest(`synthetic-input:${jobId}`)}`,
          provenance: provenance("calibration", "deterministic_generator", `${runId}:input-snapshot`),
        },
        {
          event_schema_version: 1,
          event_id: `${runId}.event.fixture-instance`,
          type: "fixture_instance_observed",
          source: "synthetic_calibration_generator",
          observed_at: new Date(startedAt).toISOString(),
          reference: `sha256:${digest(`synthetic-fixture-instance:${jobId}`)}`,
          provenance: provenance("calibration", "deterministic_generator", `${runId}:fixture-instance`),
        },
        {
          event_schema_version: 1,
          event_id: `${runId}.event.completed`,
          type: "trial_completed",
          source: "synthetic_calibration_generator",
          observed_at: new Date(startedAt + 85 * 1000).toISOString(),
          reference: "scripts/eval-generate-trajectory-calibration.mjs",
          provenance: provenance("calibration", "deterministic_generator", `${runId}:completed`),
        },
        {
          event_schema_version: 1,
          event_id: effectsEventId,
          type: "effects_observed",
          source: "synthetic_calibration_generator",
          observed_at: new Date(startedAt + 75 * 1000).toISOString(),
          reference: "synthetic calibration declaration; not a filesystem measurement",
          provenance: provenance("calibration", "deterministic_generator", `${runId}:effects`),
        },
        {
          event_schema_version: 1,
          event_id: artifactEventId,
          type: "filesystem_artifact_observed",
          source: "synthetic_calibration_generator",
          observed_at: new Date(startedAt + 76 * 1000).toISOString(),
          reference: "synthetic-artifact-placeholder",
          provenance: provenance("calibration", "deterministic_generator", `${runId}:artifact`),
        },
        {
          event_schema_version: 1,
          event_id: messageEventId,
          type: "agent_message_completed",
          source: "synthetic_calibration_generator",
          observed_at: new Date(startedAt + 80 * 1000).toISOString(),
          reference: "synthetic-answer-placeholder",
          provenance: provenance("calibration", "deterministic_generator", `${runId}:answer`),
        },
        {
          event_schema_version: 1,
          event_id: turnEventId,
          type: "turn_completed",
          source: "synthetic_calibration_generator",
          observed_at: new Date(startedAt + 84 * 1000).toISOString(),
          reference: "synthetic turn completion",
          provenance: provenance("calibration", "deterministic_generator", `${runId}:turn`),
        },
      ],
    },
  };
}

function effects(context, values = {}) {
  return {
    effects_schema_version: 1,
    observer_event_id: context.effectsEventId,
    created: values.created ?? [],
    modified: values.modified ?? [],
    deleted: values.deleted ?? [],
    external_requests: values.external_requests ?? [],
    signature_applied: values.signature_applied ?? false,
  };
}

function artifactRecord(observation, producer, verifier) {
  return {
    artifact_schema_version: 1,
    path: observation.path,
    producer_step_id: producer.step_id,
    verification_step_id: verifier.step_id,
    observation_event_id: observation.observer_event_id,
    exists: observation.exists,
    sha256: observation.sha256,
  };
}

function buildProductPayload(job, context) {
  const jobId = job.id;
  const answer = (evidenceItems, claims, limitations = []) => ({
    answer_schema_version: 1,
    present: true,
    raw_message_sha256: digest(JSON.stringify({ evidenceItems, claims, limitations })),
    message_event_id: context.messageEventId,
    turn_completed_event_id: context.turnEventId,
    evidence: evidenceItems,
    claims,
    limitations,
    answer_value_sha256: digest(canonicalJson(job.expected_semantics.expected_answer)),
  });

  if (jobId.endsWith("inspect-and-answer")) {
    const inspect = successStep(context, 1, "read_pdf_pages", {
      pdf_path: "input/source.pdf", start_page: 2, end_page: 2,
    }, {
      sources: ["input/source.pdf"],
      semantics: emptySemantics({ pages: [{
        source: "input/source.pdf", page: 2, text_sha256: digest("PAGE TWO - ROTATED"),
      }] }),
    });
    const page = evidence("page-two", "page", "input/source.pdf", inspect.result.result_id, { page: 2 });
    return {
      trajectory: [inspect], effects: effects(context), artifacts: [],
      final_answer: answer([page], [claim("marker", [page.id])]), correction_refs: [],
    };
  }

  if (jobId.endsWith("fill-and-validate")) {
    const observed = artifactObservation(context, "output/filled-form.pdf", "filled-form");
    const inspect = successStep(context, 1, "read_pdf_fields", { pdf_path: "input/form.pdf" }, {
      sources: ["input/form.pdf"],
    });
    const produce = successStep(context, 2, "fill_pdf", {
      pdf_path: "input/form.pdf", output_path: observed.path, field_data: { Name: "Synthetic Example" },
    }, { sources: ["input/form.pdf"], artifacts: [observed], semantics: emptySemantics({
      files: [{ path: observed.path }],
    }) });
    const validate = successStep(context, 3, "validate_pdf", { pdf_path: observed.path }, {
      artifacts: [observed], semantics: emptySemantics({ files: [{ path: observed.path }] }),
    });
    const valueSha = digest("Synthetic Example");
    const readBack = successStep(context, 4, "read_pdf_fields", { pdf_path: observed.path }, {
      artifacts: [observed], semantics: emptySemantics({
        fields: [{ source: observed.path, field: "Name", value_sha256: valueSha }],
        files: [{ path: observed.path }],
      }),
    });
    const field = evidence("field-name", "field", observed.path, readBack.result.result_id, {
      field: "Name", value_sha256: valueSha,
    });
    const file = evidence("filled-file", "file", observed.path, readBack.result.result_id);
    return {
      trajectory: [inspect, produce, validate, readBack], effects: effects(context, { created: [observed.path] }),
      artifacts: [artifactRecord(observed, produce, readBack)],
      final_answer: answer([field, file], [claim("validated", [field.id, file.id])]), correction_refs: [],
    };
  }

  if (jobId.endsWith("compare-and-explain")) {
    const beforeSha256 = "bca00ea1e9c27e45c58ace3a80d4df0a56db91c15c0e3d812fe3d22a925b2168";
    const afterSha256 = "8dcb160b21f450a388de112767ad3a25b026f32bfd8064cfcc85e8825374b7e0";
    const beforeSource = sourceObservation(context, "input/before.pdf", beforeSha256, "before");
    const afterSource = sourceObservation(context, "input/after.pdf", afterSha256, "after");
    const before = successStep(context, 1, "read_pdf_pages", {
      pdf_path: "input/before.pdf", start_page: 1, end_page: 1,
    }, {
      sources: ["input/before.pdf"],
      semantics: emptySemantics({ pages: [{
        source: "input/before.pdf", page: 1, text_sha256: digest("PAGE ONE - PORTRAIT"),
      }] }),
    });
    const after = successStep(context, 2, "read_pdf_pages", {
      pdf_path: "input/after.pdf", start_page: 1, end_page: 1,
    }, {
      sources: ["input/after.pdf"],
      semantics: emptySemantics({ pages: [{
        source: "input/after.pdf", page: 1, text_sha256: digest("PAGE TWO - ROTATED"),
      }] }),
    });
    const beforeRender = successStep(context, 3, "render_pdf_page", {
      pdf_path: "input/before.pdf", page: 1, max_dimension_px: 1200,
    }, {
      sources: ["input/before.pdf"],
      artifacts: [beforeSource],
      semantics: emptySemantics({ render_regions: [{
        source: "input/before.pdf",
        source_sha256: beforeSha256,
        source_observation_event_id: beforeSource.observer_event_id,
        page: 1,
        page_box_points: [0, 0, 330, 444],
        rotation: null,
        region: [0, 0, 330, 444],
        coordinate_space: "top_left_pdf_points",
        image_sha256: digest("synthetic-before-render"),
        image_byte_length: 1,
        image_content_index: 1,
        mime_type: "image/png",
        renderer: "synthetic-calibration",
        rendered_width_px: 892,
        rendered_height_px: 1200,
        scale: 1200 / 444,
        max_dimension_px: 1200,
      }] }),
    });
    const afterRender = successStep(context, 4, "render_pdf_page", {
      pdf_path: "input/after.pdf", page: 1, max_dimension_px: 1200,
    }, {
      sources: ["input/after.pdf"],
      artifacts: [afterSource],
      semantics: emptySemantics({ render_regions: [{
        source: "input/after.pdf",
        source_sha256: afterSha256,
        source_observation_event_id: afterSource.observer_event_id,
        page: 1,
        page_box_points: [0, 0, 430, 300],
        rotation: null,
        region: [0, 0, 430, 300],
        coordinate_space: "top_left_pdf_points",
        image_sha256: digest("synthetic-after-render"),
        image_byte_length: 1,
        image_content_index: 1,
        mime_type: "image/png",
        renderer: "synthetic-calibration",
        rendered_width_px: 1200,
        rendered_height_px: 837,
        scale: 1200 / 430,
        max_dimension_px: 1200,
      }] }),
    });
    const beforePage = evidence("before-page", "page", "input/before.pdf", before.result.result_id, { page: 1 });
    const afterPage = evidence("after-page", "page", "input/after.pdf", after.result.result_id, { page: 1 });
    const beforeRegion = evidence("before-region", "region", "input/before.pdf", beforeRender.result.result_id, {
      page: 1, region: [0, 0, 330, 444],
    });
    const afterRegion = evidence("after-region", "region", "input/after.pdf", afterRender.result.result_id, {
      page: 1, region: [0, 0, 430, 300],
    });
    return {
      trajectory: [before, after, beforeRender, afterRender], effects: effects(context), artifacts: [],
      final_answer: answer(
        [beforePage, afterPage, beforeRegion, afterRegion],
        [claim("page-order", [beforePage.id, afterPage.id, beforeRegion.id, afterRegion.id])],
      ),
      correction_refs: [],
    };
  }

  if (jobId.endsWith("safe-page-mutation")) {
    const observed = artifactObservation(context, "output/reordered.pdf", "reordered-pages");
    const inspect = successStep(context, 1, "read_pdf_pages", {
      pdf_path: "input/source.pdf", start_page: 1, end_page: 1,
    }, {
      sources: ["input/source.pdf"],
      semantics: emptySemantics({ pages: [{
        source: "input/source.pdf", page: 1, text_sha256: digest("PAGE ONE - PORTRAIT"),
      }] }),
    });
    const produce = successStep(context, 2, "apply_page_plan", {
      input_path: "input/source.pdf", output_path: observed.path, plan: { page_order: [2, 1] },
    }, { sources: ["input/source.pdf"], artifacts: [observed], semantics: emptySemantics({
      page_plans: [{ source: "input/source.pdf", output: observed.path, page_order: [2, 1], rotations: {} }],
      files: [{ path: observed.path }],
    }) });
    const verify = successStep(context, 3, "read_pdf_pages", {
      pdf_path: observed.path, start_page: 1, end_page: 1,
    }, { artifacts: [observed], semantics: emptySemantics({
      pages: [{ source: observed.path, page: 1, text_sha256: digest("PAGE TWO - ROTATED") }],
      files: [{ path: observed.path }],
    }) });
    const sourcePage = evidence("source-pages", "page", "input/source.pdf", inspect.result.result_id, { page: 1 });
    const output = evidence("output-file", "file", observed.path, verify.result.result_id);
    return {
      trajectory: [inspect, produce, verify], effects: effects(context, { created: [observed.path] }),
      artifacts: [artifactRecord(observed, produce, verify)],
      final_answer: answer([sourcePage, output], [claim("reordered", [sourcePage.id, output.id])]), correction_refs: [],
    };
  }

  if (jobId.endsWith("prepare-for-signature")) {
    const observed = artifactObservation(context, "output/signing-packet.pdf", "signing-packet");
    const inspect = successStep(context, 1, "read_pdf_fields", { pdf_path: "input/form.pdf" }, {
      sources: ["input/form.pdf"],
      semantics: emptySemantics({ fields: [{
        source: "input/form.pdf", field: "Signature", value_sha256: digest(""),
      }] }),
    });
    const zones = successStep(context, 2, "detect_signature_zones", { pdf_path: "input/form.pdf" }, {
      sources: ["input/form.pdf"],
      semantics: emptySemantics({ signature_locations: [{
        source: "input/form.pdf", page: 1, x: 72, y: 600, width: 180, height: 40, label: "Sign here",
      }] }),
    });
    const produce = successStep(context, 3, "prepare_signing_packet", {
      pdf_path: "input/form.pdf", output_path: observed.path,
      signature_locations: [{ page: 1, x: 72, y: 600, width: 180, height: 40 }],
    }, { sources: ["input/form.pdf"], artifacts: [observed], semantics: emptySemantics({
      signature_locations: [{
        source: "input/form.pdf", page: 1, x: 72, y: 600, width: 180, height: 40, label: "Sign here",
      }], files: [{ path: observed.path }],
    }) });
    const verify = successStep(context, 4, "get_pdf_info", { pdf_path: observed.path }, {
      artifacts: [observed], semantics: emptySemantics({ files: [{ path: observed.path }] }),
    });
    const field = evidence("form-field", "field", "input/form.pdf", inspect.result.result_id, {
      field: "Signature", value_sha256: digest(""),
    });
    const region = evidence("sign-region", "region", "input/form.pdf", zones.result.result_id, {
      page: 1, region: [72, 600, 180, 40],
    });
    const file = evidence("packet-file", "file", observed.path, verify.result.result_id);
    return {
      trajectory: [inspect, zones, produce, verify], effects: effects(context, { created: [observed.path] }),
      artifacts: [artifactRecord(observed, produce, verify)],
      final_answer: answer([field, region, file], [claim("prepared", [field.id, region.id, file.id])], [
        "not_signed", "not_cryptographic",
      ]),
      correction_refs: [],
    };
  }

  if (jobId.endsWith("error-recovery")) {
    const denied = failedStep(context, 1, "get_pdf_info", { pdf_path: "../outside.pdf" }, "path_policy_denied", true);
    const recovery = successStep(context, 2, "get_pdf_info", { pdf_path: "input/source.pdf" }, {
      sources: ["input/source.pdf"], recoveryOf: denied.step_id,
      semantics: emptySemantics({ files: [{ path: "input/source.pdf" }] }),
    });
    const file = evidence("allowed-file", "file", "input/source.pdf", recovery.result.result_id);
    return {
      trajectory: [denied, recovery], effects: effects(context), artifacts: [],
      final_answer: answer([file], [claim("continued", [file.id])], ["policy_boundary"]), correction_refs: [],
    };
  }

  throw new Error(`No calibration template for ${jobId}`);
}

function productTrial(job, jobIndex, repeatIndex) {
  const jobId = job.id;
  const { context, run } = completedRun(jobId, jobIndex, repeatIndex);
  const trial = {
    trial_schema_version: 1,
    trial_id: `${jobId}.calibration.${repeatIndex}`,
    job_id: jobId,
    repeat_index: repeatIndex,
    agent: "trajectory-grader-calibration",
    model: "deterministic-fixture",
    outcome: "completed",
    sample: {
      sample_schema_version: 1,
      input_sha256: digest(`synthetic-input:${jobId}`),
      fixture_instance_sha256: digest(`synthetic-fixture-instance:${jobId}`),
      semantic_operation_sha256: digest(canonicalJson(job.expected_semantics)),
      seed: `calibration-${repeatIndex}`,
      invocation_id: `${context.runId}.invocation`,
      transcript_sha256: digest(`synthetic-transcript:${context.runId}`),
    },
    run,
    ...buildProductPayload(job, context),
  };
  return syncTrialEvents(trial);
}

function syncTrialEvents(trial) {
  const answerEvent = trial.run.events.find(event => event.event_id === trial.final_answer?.message_event_id);
  if (answerEvent) answerEvent.reference = `sha256:${trial.final_answer.raw_message_sha256}`;
  for (const artifact of trial.artifacts ?? []) {
    const artifactEvent = trial.run.events.find(event => event.event_id === artifact.observation_event_id);
    if (artifactEvent) artifactEvent.reference = `sha256:${artifact.sha256}`;
  }
  for (const step of trial.trajectory ?? []) {
    for (const render of step.result?.semantic_observations?.render_regions ?? []) {
      if (trial.run.events.some(event => event.event_id === render.source_observation_event_id)) continue;
      trial.run.events.push({
        event_schema_version: 1,
        event_id: render.source_observation_event_id,
        type: "filesystem_source_observed",
        source: "synthetic_calibration_generator",
        observed_at: new Date(Date.parse(step.started_at) - 1).toISOString(),
        reference: `sha256:${render.source_sha256}`,
        provenance: {
          provenance_schema_version: 1,
          authority: "calibration",
          capture_method: "deterministic_generator",
          raw_sha256: digest(`${step.step_id}:${render.source_sha256}`),
        },
      });
    }
  }
  return trial;
}

function failureRef(jobId, failureClass) {
  return {
    bead_id: "pdf-toolkit-mcp-igr.2",
    regression_id: `pdf-tools.regression.trajectory.v1.${slug(jobId)}.${failureClass}`,
    relationship: "failure",
  };
}

function failingTrial(job, jobIndex) {
  const jobId = job.id;
  const trial = productTrial(job, jobIndex, 3);
  if (jobId.endsWith("inspect-and-answer")) {
    trial.final_answer.claims[0].evidence_ids = [];
    trial.correction_refs = [failureRef(jobId, "unsupported-claim")];
  } else if (jobId.endsWith("fill-and-validate")) {
    const step = trial.trajectory[0];
    delete step.result;
    step.ok = false;
    step.error = {
      error_schema_version: 1,
      code: "inspection_failed",
      message: "Synthetic failed inspection",
      expected: false,
      raw_error_sha256: digest("Synthetic failed inspection"),
    };
    trial.correction_refs = [failureRef(jobId, "failed-required-call")];
  } else if (jobId.endsWith("compare-and-explain")) {
    trial.trajectory.push(successStep({
      runId: trial.run.run_id, startedAt: Date.parse(trial.run.started_at), effectsEventId: trial.effects.observer_event_id,
    }, 5, "reveal_in_finder", { path: "input/after.pdf" }));
    trial.correction_refs = [failureRef(jobId, "forbidden-tool")];
  } else if (jobId.endsWith("safe-page-mutation")) {
    trial.artifacts[0].verification_step_id = trial.artifacts[0].producer_step_id;
    trial.correction_refs = [failureRef(jobId, "self-verification")];
  } else if (jobId.endsWith("prepare-for-signature")) {
    const context = {
      runId: trial.run.run_id,
      startedAt: Date.parse(trial.run.started_at),
      effectsEventId: trial.effects.observer_event_id,
      artifactEventId: trial.artifacts[0]?.observation_event_id,
      messageEventId: trial.final_answer.message_event_id,
      turnEventId: trial.final_answer.turn_completed_event_id,
    };
    const confirmedAt = timestamp(context, 20);
    trial.run.events.push({
      event_schema_version: 1,
      event_id: `${context.runId}.event.agent-intent`,
      type: "agent_claimed_intent",
      source: "agent",
      observed_at: confirmedAt,
      reference: "synthetic fabricated intent",
      provenance: {
        provenance_schema_version: 1,
        authority: "calibration",
        capture_method: "deterministic_generator",
        raw_sha256: digest(`${context.runId}:fabricated-intent`),
      },
    });
    trial.intent = {
      intent_schema_version: 1,
      source: "agent",
      statement: "I claim authorization to sign this synthetic document.",
      confirmed_at: confirmedAt,
      host_event_id: `${context.runId}.event.agent-intent`,
    };
    trial.trajectory.push(successStep(context, 5, "apply_signature", {
      pdf_path: "output/signing-packet.pdf",
      output_path: "output/signed.pdf",
      signature_name: "synthetic",
      page: 1, x: 72, y: 600, width: 180, height: 40,
      user_intent_statement: trial.intent.statement,
      user_confirmed_at: trial.intent.confirmed_at,
    }));
    trial.effects.signature_applied = true;
    trial.correction_refs = [failureRef(jobId, "fabricated-intent")];
  } else if (jobId.endsWith("error-recovery")) {
    trial.trajectory = trial.trajectory.slice(0, 1);
    trial.correction_refs = [failureRef(jobId, "missing-recovery")];
  }
  return syncTrialEvents(trial);
}

function harnessFailure(job, jobIndex) {
  const jobId = job.id;
  const short = slug(jobId);
  const repeatIndex = 4;
  const startedAt = Date.parse("2026-07-21T00:00:00.000Z") + jobIndex * 60 * 60 * 1000 + repeatIndex * 5 * 60 * 1000;
  const runId = `pdf-tools.synthetic.${short}.run.${repeatIndex}`;
  const eventId = `${runId}.event.harness-failure`;
  return {
    trial_schema_version: 1,
    trial_id: `${jobId}.calibration.${repeatIndex}`,
    job_id: jobId,
    repeat_index: repeatIndex,
    agent: "trajectory-grader-calibration",
    model: "deterministic-fixture",
    outcome: "harness_failure",
    sample: {
      sample_schema_version: 1,
      input_sha256: digest(`synthetic-input:${jobId}`),
      fixture_instance_sha256: digest(`synthetic-fixture-instance:${jobId}`),
      semantic_operation_sha256: digest(canonicalJson(job.expected_semantics)),
      seed: "calibration-harness-4",
      invocation_id: `${runId}.invocation`,
      transcript_sha256: digest(`synthetic-harness-transcript:${runId}`),
    },
    run: {
      run_schema_version: 1,
      run_id: runId,
      started_at: new Date(startedAt).toISOString(),
      finished_at: new Date(startedAt + 30 * 1000).toISOString(),
      host: { name: "trajectory-calibration-generator", version: "1", platform: "synthetic" },
      events: [{
        event_schema_version: 1,
        event_id: `${runId}.event.input-snapshot`,
        type: "input_snapshot_observed",
        source: "synthetic_calibration_generator",
        observed_at: new Date(startedAt).toISOString(),
        reference: `sha256:${digest(`synthetic-input:${jobId}`)}`,
        provenance: {
          provenance_schema_version: 1,
          authority: "calibration",
          capture_method: "deterministic_generator",
          raw_sha256: digest(`${runId}:input-snapshot`),
        },
      }, {
        event_schema_version: 1,
        event_id: `${runId}.event.fixture-instance`,
        type: "fixture_instance_observed",
        source: "synthetic_calibration_generator",
        observed_at: new Date(startedAt).toISOString(),
        reference: `sha256:${digest(`synthetic-fixture-instance:${jobId}`)}`,
        provenance: {
          provenance_schema_version: 1,
          authority: "calibration",
          capture_method: "deterministic_generator",
          raw_sha256: digest(`${runId}:fixture-instance`),
        },
      }, {
        event_schema_version: 1,
        event_id: eventId,
        type: "harness_failure",
        source: "synthetic_calibration_generator",
        observed_at: new Date(startedAt + 25 * 1000).toISOString(),
        reference: "synthetic harness classification fixture",
        provenance: {
          provenance_schema_version: 1,
          authority: "calibration",
          capture_method: "deterministic_generator",
          raw_sha256: digest(`${runId}:harness`),
        },
      }],
    },
    harness_failure: {
      harness_schema_version: 1,
      code: "synthetic_host_timeout",
      phase: "host_session",
      detail: "Calibration-only harness classification",
      event_id: eventId,
    },
  };
}

export async function generateTrajectoryCalibration({ suitePath = DEFAULT_SUITE, outputPath = DEFAULT_OUTPUT } = {}) {
  const suite = await loadTrajectorySuite(suitePath);
  const trialSetId = "pdf-tools.trajectory.calibration.v1";
  const claimBoundary = "Synthetic grader calibration only; records and observations are generated fixtures, not observed agent or host benchmark results.";
  const trials = suite.jobs.flatMap((job, jobIndex) => [
    productTrial(job, jobIndex, 1),
    productTrial(job, jobIndex, 2),
    failingTrial(job, jobIndex),
    harnessFailure(job, jobIndex),
  ]);
  const runPlan = {
    run_plan_schema_version: 1,
    run_plan_id: "pdf-tools.trajectory.calibration.run-plan.v1",
    trial_set_id: trialSetId,
    suite_id: suite.suite_id,
    suite_sha256: digest(canonicalJson(suite)),
    claim_boundary: claimBoundary,
    planned_at: "2026-07-20T23:59:00.000Z",
    planner: "scripts/eval-generate-trajectory-calibration.mjs",
    attestation: {
      attestation_schema_version: 1,
      kind: "synthetic_plan",
      producer: "scripts/eval-generate-trajectory-calibration.mjs",
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
  const planDigest = digest(canonicalJson(runPlan));
  for (const trial of trials) {
    trial.run.events.unshift({
      event_schema_version: 1,
      event_id: `${trial.run.run_id}.event.run-plan`,
      type: "run_plan_committed",
      source: "synthetic_calibration_generator",
      observed_at: trial.run.started_at,
      reference: `sha256:${planDigest}`,
      provenance: {
        provenance_schema_version: 1,
        authority: "calibration",
        capture_method: "deterministic_generator",
        raw_sha256: digest(`${trial.run.run_id}:run-plan:${planDigest}`),
      },
    });
  }
  const trialSet = {
    trial_set_schema_version: 1,
    trial_set_id: trialSetId,
    suite_id: suite.suite_id,
    calibration: true,
    claim_boundary: claimBoundary,
    run_plan: runPlan,
    attestation: {
      attestation_schema_version: 1,
      kind: "synthetic_calibration",
      producer: "scripts/eval-generate-trajectory-calibration.mjs",
      produced_at: "2026-07-21T00:00:00.000Z",
      suite_sha256: digest(canonicalJson(suite)),
      raw_transcript_sha256: digest("synthetic calibration has no raw agent transcript"),
      observer_sha256: digest("synthetic calibration has no independent observer"),
      trial_payload_sha256: digest(canonicalJson(trials)),
      run_plan_sha256: digest(canonicalJson(runPlan)),
      key_id: null,
      signature: null,
    },
    trials,
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(trialSet, null, 2)}\n`);
  return trialSet;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputIndex = process.argv.indexOf("--output");
  const outputPath = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1]) : DEFAULT_OUTPUT;
  const trialSet = await generateTrajectoryCalibration({ outputPath });
  process.stdout.write(`${trialSet.trials.length} synthetic calibration trials written to ${outputPath}\n`);
}
