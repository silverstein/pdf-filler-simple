#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadTrajectorySuite,
  validateTrajectoryTrialSet,
} from "../test/eval/trajectory-grader.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SUITE = path.join(REPO_ROOT, "test", "fixtures", "eval", "trajectories", "jobs.v1.json");

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseJsonLines(text) {
  return text.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSONL at line ${index + 1}: ${error.message}`);
    }
  });
}

function completedItem(event) {
  if (event?.type !== "item.completed") return null;
  return event.item ?? null;
}

function startedItem(event) {
  if (event?.type !== "item.started") return null;
  return event.item ?? null;
}

function rawToolCalls(events) {
  return events.map(completedItem).filter(item =>
    item?.type === "mcp_tool_call" && item?.server === "pdf_tools"
  );
}

function terminalMessages(events) {
  return events.map(completedItem).filter(item => item?.type === "agent_message");
}

function validMcpResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const contentValid = Array.isArray(value.content)
    && value.content.length > 0
    && value.content.every(block => block && typeof block === "object" && typeof block.type === "string");
  const structured = value.structured_content ?? value.structuredContent;
  const structuredValid = structured
    && typeof structured === "object"
    && !Array.isArray(structured)
    && Object.keys(structured).length > 0;
  return contentValid || structuredValid;
}

function validateObserver(observer) {
  const required = [
    "observer_schema_version", "trial_set_id", "suite_id", "trial_id", "job_id", "repeat_index",
    "agent", "model", "claim_boundary", "run", "call_observations", "effects", "artifacts",
    "final_answer_annotations", "correction_refs", "sample", "outcome", "harness_failure",
  ];
  if (!observer || typeof observer !== "object" || Array.isArray(observer)) {
    throw new Error("Observer sidecar must be an object");
  }
  const unknown = Object.keys(observer).filter(key => !required.includes(key));
  const missing = required.filter(key => !Object.hasOwn(observer, key));
  if (missing.length || unknown.length) {
    throw new Error(`Invalid observer sidecar keys (missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"})`);
  }
  if (observer.observer_schema_version !== 1) throw new Error("observer_schema_version must equal 1");
  if (!new Set(["completed", "harness_failure"]).has(observer.outcome)) throw new Error("outcome is unsupported");
  if (observer.outcome === "completed" && observer.harness_failure !== null) {
    throw new Error("harness_failure must be null for a completed trial");
  }
  if (observer.outcome === "harness_failure"
    && (!observer.harness_failure || typeof observer.harness_failure !== "object" || Array.isArray(observer.harness_failure))) {
    throw new Error("harness_failure details are required for a harness failure");
  }
  if (!observer.call_observations || typeof observer.call_observations !== "object"
    || Array.isArray(observer.call_observations)) {
    throw new Error("call_observations must be an object keyed by raw Codex item id");
  }
  const requireObject = (value, location) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${location} must be an object`);
  };
  const exact = (value, location, required, optional = []) => {
    requireObject(value, location);
    const missingKeys = required.filter(key => !Object.hasOwn(value, key));
    const unknownKeys = Object.keys(value).filter(key => !required.includes(key) && !optional.includes(key));
    if (missingKeys.length || unknownKeys.length) {
      throw new Error(`${location} keys invalid (missing: ${missingKeys.join(", ") || "none"}; unknown: ${unknownKeys.join(", ") || "none"})`);
    }
  };
  exact(observer.sample, "sample", ["input_sha256", "fixture_instance_sha256", "seed", "invocation_id"]);
  for (const key of ["input_sha256", "fixture_instance_sha256"]) {
    if (!/^[a-f0-9]{64}$/.test(observer.sample[key])) throw new Error(`sample.${key} must be SHA-256`);
  }
  for (const key of ["seed", "invocation_id"]) {
    if (typeof observer.sample[key] !== "string" || !observer.sample[key]) throw new Error(`sample.${key} must be non-empty`);
  }
  for (const [id, observation] of Object.entries(observer.call_observations)) {
    exact(observation, `call_observations.${id}`, ["started_at", "finished_at", "observed_sources", "observed_artifacts"], [
      "expected_error", "recovery_of_item_id",
    ]);
    if (!Number.isFinite(Date.parse(observation.started_at))) throw new Error(`call_observations.${id}.started_at must be ISO-8601`);
    if (!Number.isFinite(Date.parse(observation.finished_at))) throw new Error(`call_observations.${id}.finished_at must be ISO-8601`);
    if (Date.parse(observation.finished_at) < Date.parse(observation.started_at)) {
      throw new Error(`call_observations.${id}.finished_at must not precede started_at`);
    }
    if (!Array.isArray(observation.observed_sources) || !observation.observed_sources.every(value => typeof value === "string" && value)) {
      throw new Error(`call_observations.${id}.observed_sources must be strings`);
    }
    if (!Array.isArray(observation.observed_artifacts)) throw new Error(`call_observations.${id}.observed_artifacts must be an array`);
    if (Object.hasOwn(observation, "expected_error") && typeof observation.expected_error !== "boolean") {
      throw new Error(`call_observations.${id}.expected_error must be boolean`);
    }
    for (const key of ["recovery_of_item_id"]) {
      if (Object.hasOwn(observation, key) && (typeof observation[key] !== "string" || !observation[key])) {
        throw new Error(`call_observations.${id}.${key} must be non-empty`);
      }
    }
    for (const [index, artifact] of observation.observed_artifacts.entries()) {
      exact(artifact, `call_observations.${id}.observed_artifacts[${index}]`, [
        "path", "exists", "sha256", "observer_event_id", "observation_method",
      ]);
      if (artifact.observation_method !== "filesystem_stat_sha256") {
        throw new Error(`call_observations.${id}.observed_artifacts[${index}] must use filesystem_stat_sha256`);
      }
      if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error(`call_observations.${id}.observed_artifacts[${index}].sha256 invalid`);
    }
  }
  if (!Array.isArray(observer.artifacts)) throw new Error("artifacts must be an array");
  for (const [index, artifact] of observer.artifacts.entries()) {
    exact(artifact, `artifacts[${index}]`, [
      "path", "exists", "sha256", "producer_item_id", "verification_item_id", "observation_event_id",
    ]);
  }
  exact(observer.final_answer_annotations, "final_answer_annotations", ["evidence", "claims", "limitations"]);
  for (const key of ["evidence", "claims", "limitations"]) {
    if (!Array.isArray(observer.final_answer_annotations[key])) throw new Error(`final_answer_annotations.${key} must be an array`);
  }
  for (const [index, evidence] of observer.final_answer_annotations.evidence.entries()) {
    const details = evidence?.kind === "page" ? ["page"]
      : evidence?.kind === "field" ? ["field", "value_sha256"]
        : evidence?.kind === "region" ? ["page", "region"] : [];
    exact(evidence, `final_answer_annotations.evidence[${index}]`, [
      "evidence_schema_version", "id", "kind", "source", "result_item_id", ...details,
    ]);
  }
  for (const [index, claim] of observer.final_answer_annotations.claims.entries()) {
    exact(claim, `final_answer_annotations.claims[${index}]`, [
      "claim_schema_version", "id", "important", "evidence_ids",
    ]);
  }
  if (!observer.final_answer_annotations.limitations.every(value => typeof value === "string" && value)) {
    throw new Error("final_answer_annotations.limitations must contain non-empty strings");
  }
}

function normalizeRawError(rawError) {
  if (rawError && typeof rawError === "object") {
    const structured = rawError.structured_content ?? rawError.structuredContent;
    const structuredError = structured?.error;
    const contentMessage = Array.isArray(rawError.content)
      ? rawError.content.find(item => item?.type === "text" && typeof item.text === "string")?.text
      : null;
    return {
      code: String(
        rawError.code
        ?? rawError.error_code
        ?? structuredError?.code
        ?? structured?.error_code
        ?? "tool_error"
      ),
      message: String(
        rawError.message
        ?? structuredError?.message
        ?? contentMessage
        ?? JSON.stringify(rawError)
      ),
    };
  }
  return { code: "tool_error", message: String(rawError ?? "Unspecified MCP tool error") };
}

function rawItemId(item, index) {
  const value = item.id ?? item.item_id ?? item.call_id;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Raw item ${index + 1} has no stable item id`);
  }
  return value;
}

export function semanticObservations(item) {
  const structured = item.result?.structured_content ?? item.result?.structuredContent ?? {};
  const args = item.arguments ?? {};
  const pages = Array.isArray(structured.pages) ? structured.pages
    .filter(page => typeof page?.text === "string")
    .map(page => ({
      source: args.pdf_path,
      page: Number(page.page_number ?? page.page),
      text_sha256: digest(page.text),
    }))
    .filter(page => typeof page.source === "string" && Number.isInteger(page.page) && page.page > 0) : [];
  const fields = Array.isArray(structured.fields) ? structured.fields
    .filter(field => typeof field?.name === "string"
      && (Object.hasOwn(field, "currentValue") || Object.hasOwn(field, "value"))
      && new Set(["string", "number", "boolean"]).has(typeof (field.currentValue ?? field.value)))
    .map(field => ({
      source: args.pdf_path,
      field: field.name,
      value_sha256: digest(String(field.currentValue ?? field.value ?? "")),
    })) : [];
  const pagePlans = item.tool === "apply_page_plan" && Array.isArray(structured.page_order) ? [{
    source: args.input_path,
    output: args.output_path,
    page_order: structured.page_order,
    rotations: structured.rotations ?? {},
  }] : [];
  const signatureLocations = Array.isArray(structured.pending_signatures)
    ? structured.pending_signatures.map(location => ({
      source: args.pdf_path,
      page: location.page,
      x: location.x,
      y: location.y,
      width: location.width,
      height: location.height,
      label: location.label ?? null,
    }))
    : Array.isArray(structured.zones) ? structured.zones.map(location => ({
      source: args.pdf_path,
      page: location.page,
      x: location.x,
      y: location.y,
      width: location.width,
      height: location.height,
      label: location.label ?? null,
    })) : [];
  const outputPath = structured.output_path ?? structured.path;
  const files = typeof outputPath === "string" ? [{ path: outputPath }]
    : item.tool === "get_pdf_info" && typeof args.pdf_path === "string" ? [{ path: args.pdf_path }] : [];
  return {
    semantic_schema_version: 1,
    pages,
    fields,
    page_plans: pagePlans,
    signature_locations: signatureLocations,
    files,
  };
}

function mapEvidence(annotation, resultIds) {
  const resultId = resultIds.get(annotation.result_item_id);
  if (!resultId) throw new Error(`Evidence ${annotation.id} references unknown result item ${annotation.result_item_id}`);
  const { result_item_id: _ignored, ...rest } = annotation;
  return { ...rest, result_id: resultId };
}

export async function ingestCodexTrajectory({
  rawPath, observerPath, planPath, suitePath = DEFAULT_SUITE, outputPath = null,
  allowPartialPlan = false,
}) {
  if (!rawPath || !observerPath || !planPath) throw new Error("rawPath, observerPath, and pre-run planPath are required");
  const [rawText, observerText, planText, suite] = await Promise.all([
    fs.readFile(rawPath, "utf8"),
    fs.readFile(observerPath, "utf8"),
    fs.readFile(planPath, "utf8"),
    loadTrajectorySuite(suitePath),
  ]);
  const events = parseJsonLines(rawText);
  const observer = JSON.parse(observerText);
  const runPlan = JSON.parse(planText);
  validateObserver(observer);
  const job = suite.jobs.find(item => item.id === observer.job_id);
  if (!job) throw new Error(`Observer references unknown job ${observer.job_id}`);
  const allowedEventTypes = new Set(["thread.started", "turn.started", "turn.completed", "item.started", "item.completed"]);
  const unknownEvent = events.find(event => !allowedEventTypes.has(event?.type));
  if (unknownEvent) throw new Error(`Raw transcript contains unnormalized event type ${unknownEvent?.type}`);
  const malformedItemEvent = events.find(event => event?.type?.startsWith("item.")
    && (!event.item || typeof event.item !== "object" || Array.isArray(event.item)));
  if (malformedItemEvent) throw new Error(`${malformedItemEvent.type} must retain its raw item object`);
  const rawItems = events.flatMap(event => [startedItem(event), completedItem(event)]).filter(Boolean);
  const unsupportedItem = rawItems.find(item => !new Set(["mcp_tool_call", "agent_message"]).has(item?.type));
  if (unsupportedItem) throw new Error(`Raw transcript contains unnormalized item type ${unsupportedItem?.type}`);
  const nonPdfMcpCalls = rawItems.filter(item => item?.type === "mcp_tool_call" && item?.server !== "pdf_tools");
  if (nonPdfMcpCalls.length > 0) throw new Error("Raw transcript contains MCP calls outside the pdf_tools server");
  const startedEntries = events.flatMap((event, index) => {
    const item = startedItem(event);
    return item ? [{ item, index, id: rawItemId(item, index) }] : [];
  });
  const completedEntries = events.flatMap((event, index) => {
    const item = completedItem(event);
    return item ? [{ item, index, id: rawItemId(item, index) }] : [];
  });
  const duplicateStartedIds = startedEntries.map(entry => entry.id)
    .filter((id, index, ids) => ids.indexOf(id) !== index);
  if (duplicateStartedIds.length > 0) {
    throw new Error(`Raw transcript contains duplicate item.started ids: ${[...new Set(duplicateStartedIds)].join(", ")}`);
  }
  for (const started of startedEntries) {
    const completions = completedEntries.filter(entry => entry.id === started.id);
    if (completions.length === 0) throw new Error(`Raw transcript contains unfinished items: ${started.id}`);
    if (completions.length > 1) throw new Error(`Raw transcript contains duplicate item.completed id ${started.id}`);
    const completed = completions[0];
    if (completed.index <= started.index) throw new Error(`Raw item ${started.id} completed before it started`);
    if (completed.item.type !== started.item.type) throw new Error(`Raw item ${started.id} changed type before completion`);
    if (started.item.type === "mcp_tool_call"
      && (completed.item.server !== started.item.server || completed.item.tool !== started.item.tool)) {
      throw new Error(`Raw MCP item ${started.id} changed server or tool before completion`);
    }
  }
  const startedCalls = events.map(startedItem).filter(item => item?.type === "mcp_tool_call");
  const calls = rawToolCalls(events);
  const completedIds = new Set(calls.map((item, index) => rawItemId(item, index)));
  const startedIds = startedCalls.map((item, index) => rawItemId(item, index));
  const unfinished = startedIds.filter(id => !completedIds.has(id));
  if (unfinished.length > 0) throw new Error(`Raw transcript contains unfinished MCP calls: ${unfinished.join(", ")}`);
  const unstarted = [...completedIds].filter(id => !startedIds.includes(id));
  if (unstarted.length > 0) throw new Error(`Raw transcript contains completed MCP calls without item.started: ${unstarted.join(", ")}`);
  if (observer.outcome === "completed" && calls.length === 0) throw new Error("Raw transcript contains no pdf_tools MCP calls");
  if (observer.outcome === "harness_failure" && calls.length > 0) {
    throw new Error("A run with completed PDF tool calls is a product trial and cannot be relabeled as a harness failure");
  }
  const messages = terminalMessages(events);
  const lastCallEventIndex = events.reduce((last, event, index) => completedItem(event)?.type === "mcp_tool_call" ? index : last, -1);
  const lastMessageEventIndex = events.reduce((last, event, index) => completedItem(event)?.type === "agent_message" ? index : last, -1);
  const turnCompletedIndex = events.findIndex((event, index) => index > lastMessageEventIndex && event?.type === "turn.completed");
  if (lastMessageEventIndex >= 0 && lastMessageEventIndex <= lastCallEventIndex) {
    throw new Error("Terminal agent answer must follow the final MCP tool call");
  }
  if (lastMessageEventIndex >= 0 && turnCompletedIndex < 0) {
    throw new Error("Terminal agent answer requires a later turn.completed event");
  }
  const callIds = calls.map(rawItemId);
  if (new Set(callIds).size !== callIds.length) throw new Error("Raw Codex MCP item ids must be unique");
  const unknownObservations = Object.keys(observer.call_observations).filter(id => !callIds.includes(id));
  if (unknownObservations.length > 0) {
    throw new Error(`Observer sidecar references unknown call ids: ${unknownObservations.join(", ")}`);
  }

  const resultIds = new Map();
  const steps = calls.map((item, index) => {
    const id = rawItemId(item, index);
    if (!new Set(["completed", "failed"]).has(item.status)) {
      throw new Error(`MCP call ${id} has unsupported terminal status ${item.status}`);
    }
    const observation = observer.call_observations[id] ?? {
      observed_sources: [], observed_artifacts: [], expected_error: false,
    };
    const toolReportedError = item.result?.isError === true || item.result?.is_error === true;
    const ok = item.status === "completed" && (item.error === null || item.error === undefined) && !toolReportedError;
    if (ok && !validMcpResult(item.result)) {
      throw new Error(`Successful MCP call ${id} must retain a non-null MCP result object with content or structured_content`);
    }
    const base = {
      step_schema_version: 2,
      step_id: `${observer.run.run_id}.step.${index + 1}`,
      tool: item.tool,
      started_at: observation.started_at,
      finished_at: observation.finished_at,
      arguments: item.arguments ?? {},
      ok,
    };
    if (observation.recovery_of_item_id) {
      const recoveredIndex = callIds.indexOf(observation.recovery_of_item_id);
      if (recoveredIndex < 0 || recoveredIndex >= index) {
        throw new Error(`Call ${id} has invalid recovery_of_item_id ${observation.recovery_of_item_id}`);
      }
      base.recovery_of_step_id = `${observer.run.run_id}.step.${recoveredIndex + 1}`;
    }
    if (ok) {
      const resultId = `${observer.run.run_id}.result.${index + 1}`;
      resultIds.set(id, resultId);
      base.result = {
        result_schema_version: 1,
        result_id: resultId,
        raw_result_sha256: digest(JSON.stringify(item.result ?? null)),
        observed_sources: observation.observed_sources ?? [],
        observed_artifacts: observation.observed_artifacts ?? [],
        semantic_observations: semanticObservations(item),
      };
    } else {
      const rawErrorValue = item.error ?? (toolReportedError ? item.result : null);
      const rawError = normalizeRawError(rawErrorValue);
      base.error = {
        error_schema_version: 1,
        code: rawError.code,
        message: rawError.message,
        expected: observation.expected_error === true,
        raw_error_sha256: digest(JSON.stringify({ status: item.status, error: rawErrorValue })),
      };
    }
    return base;
  });

  const stepIds = new Map(callIds.map((id, index) => [id, steps[index].step_id]));
  const artifacts = observer.artifacts.map(artifact => {
    const producer = stepIds.get(artifact.producer_item_id);
    const verifier = stepIds.get(artifact.verification_item_id);
    if (!producer || !verifier) throw new Error(`Artifact ${artifact.path} references unknown producer or verifier item`);
    return {
      artifact_schema_version: 1,
      path: artifact.path,
      producer_step_id: producer,
      verification_step_id: verifier,
      observation_event_id: artifact.observation_event_id,
      exists: artifact.exists,
      sha256: artifact.sha256,
    };
  });
  const lastMessage = messages.at(-1);
  const messageText = lastMessage?.text ?? lastMessage?.content ?? null;
  const answerPresent = typeof messageText === "string" && messageText.length > 0;
  let parsedAnswer = null;
  if (answerPresent) {
    try {
      parsedAnswer = JSON.parse(messageText);
    } catch {
      parsedAnswer = null;
    }
  }
  const annotations = observer.final_answer_annotations;
  const finalAnswer = {
    answer_schema_version: 1,
    present: answerPresent,
    raw_message_sha256: answerPresent ? digest(messageText) : null,
    message_event_id: answerPresent ? `${observer.run.run_id}.event.agent-message` : null,
    turn_completed_event_id: answerPresent ? `${observer.run.run_id}.event.turn-completed` : null,
    evidence: answerPresent ? annotations.evidence.map(item => mapEvidence(item, resultIds)) : [],
    claims: answerPresent ? annotations.claims : [],
    limitations: answerPresent ? annotations.limitations : [],
    answer_value_sha256: parsedAnswer && typeof parsedAnswer === "object" && !Array.isArray(parsedAnswer)
      ? digest(canonicalJson(parsedAnswer)) : null,
  };
  const transcriptEvent = {
    event_schema_version: 1,
    event_id: `${observer.run.run_id}.event.codex-jsonl`,
    type: "agent_transcript_retained",
    source: "codex_exec_jsonl",
    observed_at: observer.run.finished_at,
    reference: `sha256:${digest(rawText)}`,
    provenance: {
      provenance_schema_version: 1,
      authority: "ingester",
      capture_method: "codex_exec_jsonl",
      raw_sha256: digest(rawText),
    },
  };
  const terminalEvents = answerPresent ? [{
    event_schema_version: 1,
    event_id: finalAnswer.message_event_id,
    type: "agent_message_completed",
    source: "codex_exec_jsonl",
    observed_at: new Date(Date.parse(observer.run.finished_at) - 1).toISOString(),
    reference: `sha256:${finalAnswer.raw_message_sha256}`,
    provenance: {
      provenance_schema_version: 1,
      authority: "ingester",
      capture_method: "codex_exec_jsonl",
      raw_sha256: digest(JSON.stringify(events[lastMessageEventIndex])),
    },
  }, {
    event_schema_version: 1,
    event_id: finalAnswer.turn_completed_event_id,
    type: "turn_completed",
    source: "codex_exec_jsonl",
    observed_at: observer.run.finished_at,
    reference: `sha256:${digest(JSON.stringify(events[turnCompletedIndex]))}`,
    provenance: {
      provenance_schema_version: 1,
      authority: "ingester",
      capture_method: "codex_exec_jsonl",
      raw_sha256: digest(JSON.stringify(events[turnCompletedIndex])),
    },
  }] : [];
  const trialBase = {
    trial_schema_version: 1,
    trial_id: observer.trial_id,
    job_id: observer.job_id,
    repeat_index: observer.repeat_index,
    agent: observer.agent,
    model: observer.model,
    sample: {
      sample_schema_version: 1,
      input_sha256: observer.sample.input_sha256,
      fixture_instance_sha256: observer.sample.fixture_instance_sha256,
      semantic_operation_sha256: digest(canonicalJson(job.expected_semantics)),
      seed: observer.sample.seed,
      invocation_id: observer.sample.invocation_id,
      transcript_sha256: digest(rawText),
    },
    run: { ...observer.run, events: [...observer.run.events, transcriptEvent, ...terminalEvents] },
  };
  const trial = observer.outcome === "harness_failure" ? {
    ...trialBase,
    outcome: "harness_failure",
    harness_failure: observer.harness_failure,
  } : {
    ...trialBase,
    outcome: "completed",
    trajectory: steps,
    effects: observer.effects,
    artifacts,
    final_answer: finalAnswer,
    correction_refs: observer.correction_refs,
  };
  const trialSet = {
    trial_set_schema_version: 1,
    trial_set_id: observer.trial_set_id,
    suite_id: observer.suite_id,
    calibration: false,
    claim_boundary: observer.claim_boundary,
    run_plan: runPlan,
    attestation: {
      attestation_schema_version: 1,
      kind: "measured_ingestion",
      producer: "scripts/eval-ingest-codex-trajectory.mjs",
      produced_at: observer.run.finished_at,
      suite_sha256: digest(canonicalJson(suite)),
      raw_transcript_sha256: digest(rawText),
      observer_sha256: digest(observerText),
      trial_payload_sha256: digest(canonicalJson([trial])),
      run_plan_sha256: null,
      key_id: null,
      signature: null,
    },
    trials: [trial],
  };
  trialSet.attestation.run_plan_sha256 = digest(canonicalJson(trialSet.run_plan));
  const validation = validateTrajectoryTrialSet(suite, trialSet, { allowPartialPlan });
  if (validation.length > 0) {
    throw new Error(`Ingested trial is invalid:\n- ${validation.join("\n- ")}`);
  }
  if (outputPath) await fs.writeFile(outputPath, `${JSON.stringify(trialSet, null, 2)}\n`);
  return trialSet;
}

export async function ingestCodexTrajectoryBatch({
  runs, planPath, suitePath = DEFAULT_SUITE, outputPath = null,
}) {
  if (!Array.isArray(runs) || runs.length === 0) throw new Error("runs must contain rawPath/observerPath pairs");
  const partialSets = [];
  for (const run of runs) {
    partialSets.push(await ingestCodexTrajectory({
      rawPath: run.rawPath,
      observerPath: run.observerPath,
      planPath,
      suitePath,
      allowPartialPlan: true,
    }));
  }
  const suite = await loadTrajectorySuite(suitePath);
  const runPlan = partialSets[0].run_plan;
  const trials = partialSets.flatMap(set => set.trials);
  const trialSet = {
    trial_set_schema_version: 1,
    trial_set_id: runPlan.trial_set_id,
    suite_id: runPlan.suite_id,
    calibration: false,
    claim_boundary: runPlan.claim_boundary,
    run_plan: runPlan,
    attestation: {
      attestation_schema_version: 1,
      kind: "measured_ingestion",
      producer: "scripts/eval-ingest-codex-trajectory.mjs#batch",
      produced_at: trials.map(trial => trial.run.finished_at).sort().at(-1),
      suite_sha256: digest(canonicalJson(suite)),
      raw_transcript_sha256: digest(canonicalJson(partialSets.map(set => set.attestation.raw_transcript_sha256))),
      observer_sha256: digest(canonicalJson(partialSets.map(set => set.attestation.observer_sha256))),
      trial_payload_sha256: digest(canonicalJson(trials)),
      run_plan_sha256: digest(canonicalJson(runPlan)),
      key_id: null,
      signature: null,
    },
    trials,
  };
  const validation = validateTrajectoryTrialSet(suite, trialSet);
  if (validation.length > 0) throw new Error(`Ingested batch is invalid:\n- ${validation.join("\n- ")}`);
  if (outputPath) await fs.writeFile(outputPath, `${JSON.stringify(trialSet, null, 2)}\n`);
  return trialSet;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function option(name, required = false) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    if (required) throw new Error(`${name} is required`);
    return null;
  }
  if (!process.argv[index + 1]) throw new Error(`${name} requires a value`);
  return path.resolve(process.argv[index + 1]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const batchPath = option("--batch");
  const planPath = option("--plan", true);
  const suitePath = option("--suite") ?? DEFAULT_SUITE;
  const outputPath = option("--output", true);
  let trialSet;
  if (batchPath) {
    const batchDirectory = path.dirname(batchPath);
    const manifest = JSON.parse(await fs.readFile(batchPath, "utf8"));
    trialSet = await ingestCodexTrajectoryBatch({
      runs: manifest.runs.map(run => ({
        rawPath: path.resolve(batchDirectory, run.raw),
        observerPath: path.resolve(batchDirectory, run.observer),
      })),
      planPath,
      suitePath,
      outputPath,
    });
  } else {
    trialSet = await ingestCodexTrajectory({
      rawPath: option("--raw", true),
      observerPath: option("--observer", true),
      planPath,
      suitePath,
      outputPath,
    });
  }
  process.stdout.write(`${trialSet.trials.length} measured Codex trial ingested\n`);
}
