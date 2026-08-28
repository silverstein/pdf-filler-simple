import { createHash } from "node:crypto";

import {
  admitStructuredModelResponse,
  buildVerifiedExtractionProposalSchema,
  classifySourceBoundBatch,
  ModelOutputAdmissionError,
} from "./verified-extraction-response-admission.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const CHUNK_ID = /^chunk\.[a-f0-9]{64}$/u;
const PLAN_KEYS = [
  "attempt_id", "batch_chunk_ids", "batches", "benchmark_claim_ready", "contract", "denominator",
  "document_validation", "expected_model", "max_output_tokens", "plan_sha256", "trial_id",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertion(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
  assertion(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assertion(canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort()),
    `${label} keys are invalid`);
}

function boundedString(value, label, maximum = 1024) {
  assertion(typeof value === "string" && value.length > 0, `${label} must be a non-empty string`);
  assertion(Buffer.byteLength(value, "utf8") <= maximum, `${label} exceeds its UTF-8 byte limit`);
}

function validateDocumentValidation(value) {
  exactKeys(value, [
    "document_id", "document_map_sha256", "ordered_chunk_ids", "renderer_sha256", "schema_sha256",
    "source_sha256",
  ], "documentValidation");
  boundedString(value.document_id, "documentValidation.document_id", 512);
  for (const field of ["document_map_sha256", "renderer_sha256", "schema_sha256", "source_sha256"]) {
    assertion(SHA256.test(value[field] ?? "") && value[field] !== "0".repeat(64),
      `documentValidation.${field} is invalid`);
  }
  assertion(Array.isArray(value.ordered_chunk_ids) && value.ordered_chunk_ids.length > 0
    && value.ordered_chunk_ids.every(chunkId => CHUNK_ID.test(chunkId))
    && new Set(value.ordered_chunk_ids).size === value.ordered_chunk_ids.length,
  "documentValidation.ordered_chunk_ids is invalid");
}

function validateRawResponseArtifact(value, responseBytes) {
  exactKeys(value, ["bytes", "path", "sha256"], "rawResponseArtifact");
  boundedString(value.path, "rawResponseArtifact.path", 2048);
  assertion(!value.path.startsWith("/") && !value.path.split("/").includes(".."),
    "rawResponseArtifact.path must be a safe relative path");
  assertion(Number.isSafeInteger(value.bytes) && value.bytes === responseBytes.length,
    "rawResponseArtifact.bytes does not match the exact response");
  assertion(SHA256.test(value.sha256 ?? "") && value.sha256 === sha256(responseBytes),
    "rawResponseArtifact.sha256 does not match the exact response");
}

function planWithoutDigest(plan) {
  const copy = structuredClone(plan);
  delete copy.plan_sha256;
  return copy;
}

function receiptWithDigest(receipt) {
  return { ...receipt, receipt_sha256: sha256(Buffer.from(canonicalJson(receipt), "utf8")) };
}

export function prepareResponseAdmissionController({
  attemptId, trialId, predecessorRoleIds = [], documentValidation, documentChunks, batchChunkIds,
  expectedModel, maxOutputTokens,
}) {
  boundedString(attemptId, "attemptId", 512);
  boundedString(trialId, "trialId", 512);
  assertion(attemptId !== trialId, "attemptId and trialId must be distinct");
  assertion(Array.isArray(predecessorRoleIds)
    && predecessorRoleIds.every(value => typeof value === "string")
    && new Set(predecessorRoleIds).size === predecessorRoleIds.length,
  "predecessorRoleIds is invalid");
  const predecessorSet = new Set(predecessorRoleIds);
  assertion(!predecessorSet.has(attemptId) && !predecessorSet.has(trialId),
    "successor role identity overlaps a predecessor campaign");
  validateDocumentValidation(documentValidation);
  boundedString(expectedModel, "expectedModel", 512);
  assertion(Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0,
    "maxOutputTokens must be a positive integer");
  assertion(Array.isArray(documentChunks)
    && documentChunks.length === documentValidation.ordered_chunk_ids.length,
  "documentChunks does not match the frozen chunk denominator");
  assertion(canonicalJson(documentChunks.map(chunk => chunk.chunk_id))
    === canonicalJson(documentValidation.ordered_chunk_ids),
  "documentChunks does not match the frozen ordered chunk scope");
  assertion(Array.isArray(batchChunkIds) && batchChunkIds.length > 0
    && batchChunkIds.every(batch => Array.isArray(batch) && batch.length > 0),
  "batchChunkIds must contain non-empty batches");
  assertion(canonicalJson(batchChunkIds.flat()) === canonicalJson(documentValidation.ordered_chunk_ids),
    "batchChunkIds must cover the exact ordered full chunk scope once");

  const batches = batchChunkIds.map((chunkIds, index) => {
    const policy = classifySourceBoundBatch({
      documentId: documentValidation.document_id,
      documentMapSha256: documentValidation.document_map_sha256,
      documentChunks,
      batchChunkIds: chunkIds,
    });
    const schema = buildVerifiedExtractionProposalSchema({ allowedFields: policy.allowed_fields });
    const policyKinds = new Set(policy.chunk_policies.map(item => item.evidence_admission));
    assertion(policyKinds.size === 1,
      "a batch cannot cross the source-evidence/reference-section boundary");
    return {
      batch_ordinal: index + 1,
      chunk_ids: [...chunkIds],
      policy,
      policy_sha256: sha256(Buffer.from(canonicalJson(policy), "utf8")),
      schema,
      schema_sha256: sha256(Buffer.from(canonicalJson(schema), "utf8")),
      action: policy.model_call_recommended ? "model_call" : "skip_reference_section",
    };
  });
  let referenceSeen = false;
  for (const batch of batches) {
    if (batch.action === "skip_reference_section") referenceSeen = true;
    else assertion(!referenceSeen, "a model-call batch cannot follow the reference-section boundary");
  }
  const modelBatches = batches.filter(batch => batch.action === "model_call");
  const referenceBatches = batches.filter(batch => batch.action === "skip_reference_section");
  const plan = {
    contract: { name: "pdf-tools.verified-extraction-response-controller", version: "1.0.0-experimental" },
    attempt_id: attemptId,
    trial_id: trialId,
    document_validation: structuredClone(documentValidation),
    batch_chunk_ids: structuredClone(batchChunkIds),
    batches,
    expected_model: expectedModel,
    max_output_tokens: maxOutputTokens,
    denominator: {
      document_chunks: documentChunks.length,
      batches: batches.length,
      model_batches: modelBatches.length,
      reference_skipped_batches: referenceBatches.length,
      model_chunks: modelBatches.flatMap(batch => batch.chunk_ids).length,
      reference_skipped_chunks: referenceBatches.flatMap(batch => batch.chunk_ids).length,
    },
    benchmark_claim_ready: false,
  };
  plan.plan_sha256 = sha256(Buffer.from(canonicalJson(plan), "utf8"));
  return plan;
}

export function validateResponseAdmissionControllerPlan({ plan, documentChunks }) {
  exactKeys(plan, PLAN_KEYS, "plan");
  assertion(SHA256.test(plan.plan_sha256 ?? "")
    && plan.plan_sha256 === sha256(Buffer.from(canonicalJson(planWithoutDigest(plan)), "utf8")),
  "plan.plan_sha256 does not bind the exact plan");
  const rebuilt = prepareResponseAdmissionController({
    attemptId: plan.attempt_id,
    trialId: plan.trial_id,
    documentValidation: plan.document_validation,
    documentChunks,
    batchChunkIds: plan.batch_chunk_ids,
    expectedModel: plan.expected_model,
    maxOutputTokens: plan.max_output_tokens,
  });
  assertion(canonicalJson(rebuilt) === canonicalJson(plan), "plan drifted from the exact document chunks");
  return plan;
}

function completedAggregate(admissions) {
  const contributors = [];
  const seen = new Set();
  for (const admission of admissions) {
    for (const contributor of admission.proposal.contributors) {
      if (!seen.has(contributor.name)) {
        seen.add(contributor.name);
        contributors.push(contributor.name);
      }
    }
  }
  return {
    contributor_names: contributors,
    contributor_count: contributors.length,
    contributor_count_derivation: "derived_from_unique_exact_admitted_contributor_names",
    input_admission_sha256s: admissions.map(admission => sha256(Buffer.from(canonicalJson(admission), "utf8"))),
  };
}

export async function runResponseAdmissionControllerAttempt({ plan, documentChunks, invokeBatch }) {
  validateResponseAdmissionControllerPlan({ plan, documentChunks });
  assertion(typeof invokeBatch === "function", "invokeBatch must be a function");
  const batchOutcomes = [];
  const admissions = [];
  let modelCalls = 0;
  let failure = null;

  for (const batch of plan.batches) {
    if (batch.action === "skip_reference_section") {
      batchOutcomes.push({
        batch_ordinal: batch.batch_ordinal,
        action: batch.action,
        chunk_ids: batch.chunk_ids,
        status: "skipped_reference_section",
        model_call_count: 0,
        raw_response_artifact: null,
        response_observation: null,
        admission: null,
        admission_sha256: null,
      });
      continue;
    }
    let invoked;
    let retainedRawArtifact = null;
    try {
      invoked = await invokeBatch({
        batch: structuredClone(batch),
        document_validation: structuredClone(plan.document_validation),
        expected_model: plan.expected_model,
        max_output_tokens: plan.max_output_tokens,
      });
      exactKeys(invoked, ["raw_response_artifact", "response_bytes"], "invokeBatch result");
      const responseBytes = Buffer.isBuffer(invoked.response_bytes)
        ? invoked.response_bytes
        : Buffer.from(invoked.response_bytes);
      validateRawResponseArtifact(invoked.raw_response_artifact, responseBytes);
      retainedRawArtifact = structuredClone(invoked.raw_response_artifact);
      const admission = admitStructuredModelResponse({
        responseBytes,
        expectedModel: plan.expected_model,
        maxOutputTokens: plan.max_output_tokens,
        documentId: plan.document_validation.document_id,
        documentMapSha256: plan.document_validation.document_map_sha256,
        documentChunks,
        batchChunkIds: batch.chunk_ids,
        batchPolicy: batch.policy,
      });
      modelCalls += 1;
      const admissionSha256 = sha256(Buffer.from(canonicalJson(admission), "utf8"));
      admissions.push(admission);
      batchOutcomes.push({
        batch_ordinal: batch.batch_ordinal,
        action: batch.action,
        chunk_ids: batch.chunk_ids,
        status: "admitted",
        model_call_count: 1,
        raw_response_artifact: retainedRawArtifact,
        response_observation: admission.observation,
        admission,
        admission_sha256: admissionSha256,
      });
    } catch (error) {
      const typed = error instanceof ModelOutputAdmissionError;
      failure = {
        classification: typed ? "product_failure" : "harness_failure",
        reason_code: typed ? error.code : "controller_failure",
        message: String(error?.message ?? error),
      };
      batchOutcomes.push({
        batch_ordinal: batch.batch_ordinal,
        action: batch.action,
        chunk_ids: batch.chunk_ids,
        status: failure.reason_code,
        model_call_count: invoked ? 1 : 0,
        raw_response_artifact: retainedRawArtifact,
        response_observation: typed ? error.observation : null,
        admission: null,
        admission_sha256: null,
      });
      if (invoked) modelCalls += 1;
      break;
    }
  }

  const completed = failure === null;
  const receipt = receiptWithDigest({
    contract: { name: "pdf-tools.verified-extraction-response-controller-receipt", version: 1 },
    attempt_id: plan.attempt_id,
    trial_id: plan.trial_id,
    controller_plan_sha256: plan.plan_sha256,
    document_id: plan.document_validation.document_id,
    document_map_sha256: plan.document_validation.document_map_sha256,
    denominator: structuredClone(plan.denominator),
    observed: {
      batch_outcomes: batchOutcomes.length,
      admitted_batches: admissions.length,
      model_calls: modelCalls,
      skipped_reference_batches: batchOutcomes.filter(item => item.status === "skipped_reference_section").length,
      unattempted_batches: plan.batches.length - batchOutcomes.length,
    },
    batch_outcomes: batchOutcomes,
    outcome: failure ?? { classification: "completed", reason_code: "none", message: null },
    calculation_evidence: completed ? completedAggregate(admissions) : null,
    benchmark_claim_ready: false,
  });
  return { receipt, admissions };
}

export const VERIFIED_EXTRACTION_RESPONSE_CONTROLLER_POLICY = Object.freeze({
  name: "pdf-tools.verified-extraction-response-controller",
  version: "1.0.0-experimental",
  boundary: "The controller exact-binds one validated document map and its complete ordered chunk denominator, skips the reference-section suffix before invocation, admits only strict source-replayed batch responses, derives calculation evidence from admitted proposals, and retains one denominator-preserving receipt for typed model-output or controller failure. It performs no model or provider call by itself.",
});
