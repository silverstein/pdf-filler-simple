import { createHash } from "node:crypto";

import {
  admitStructuredModelResponse,
  buildVerifiedExtractionProposalSchema,
  classifySourceBoundBatch,
  compareAdmittedCitationEvidence,
  ModelOutputAdmissionError,
} from "./verified-extraction-response-admission.mjs";
import {
  buildSourceBoundExtractionRequest,
  buildModelContextCapacityBinding,
  ModelContextCapacityError,
  observeSourceBoundExtractionRequestCapacity,
} from "./verified-extraction-response-request.mjs";
import { validateSchemaDirectedEvidencePlan } from "./verified-extraction-evidence-router.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const CHUNK_ID = /^chunk\.[a-f0-9]{64}$/u;
const PLAN_KEYS = [
  "attempt_id", "batch_chunk_ids", "batches", "benchmark_claim_ready", "contract", "denominator",
  "document_validation", "expected_model", "max_output_tokens", "plan_sha256", "trial_id",
];
const CURRENT_CONTROLLER_VERSION = "1.7.0-experimental";
const REPLAYABLE_CONTROLLER_VERSIONS = new Set([
  "1.3.0-experimental",
  "1.4.0-experimental",
  "1.5.0-experimental",
  "1.6.0-experimental",
  CURRENT_CONTROLLER_VERSION,
]);
const MODEL_CONTEXT_CONTROLLER_VERSIONS = new Set([
  "1.5.0-experimental",
  "1.6.0-experimental",
  CURRENT_CONTROLLER_VERSION,
]);
const ROUTED_CONTROLLER_VERSIONS = new Set([CURRENT_CONTROLLER_VERSION]);

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
    "source_page_text_bundle_sha256", "source_sha256", "table_regions",
  ], "documentValidation");
  boundedString(value.document_id, "documentValidation.document_id", 512);
  for (const field of ["document_map_sha256", "renderer_sha256", "schema_sha256", "source_sha256",
    "source_page_text_bundle_sha256"]) {
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

function validateDocumentRouting(value, documentValidation, documentChunks, documentSourcePages,
  selectedChunkIds) {
  validateSchemaDirectedEvidencePlan({
    plan: value,
    documentChunks,
    documentTableRegions: documentValidation.table_regions,
    documentSourcePages,
  });
  assertion(value.document_id === documentValidation.document_id
    && value.document_map_sha256 === documentValidation.document_map_sha256
    && value.source_sha256 === documentValidation.source_sha256
    && value.source_page_text_bundle_sha256 === documentValidation.source_page_text_bundle_sha256,
  "documentRouting identity drifted from the frozen document validation");
  assertion(value.total_chunk_count === documentChunks.length,
    "documentRouting total chunk denominator drifted");
  assertion(Array.isArray(value.selected_chunk_ids) && value.selected_chunk_ids.length > 0
    && canonicalJson(value.selected_chunk_ids) === canonicalJson(selectedChunkIds),
  "documentRouting selected chunk scope drifted");
  const position = new Map(documentValidation.ordered_chunk_ids.map((chunkId, index) => [chunkId, index]));
  let previous = -1;
  for (const chunkId of value.selected_chunk_ids) {
    const current = position.get(chunkId);
    assertion(Number.isSafeInteger(current) && current > previous,
      "documentRouting must be a unique ordered subset of the frozen chunk denominator");
    previous = current;
  }
}

function planWithoutDigest(plan) {
  const copy = structuredClone(plan);
  delete copy.plan_sha256;
  return copy;
}

function receiptWithDigest(receipt) {
  return { ...receipt, receipt_sha256: sha256(Buffer.from(canonicalJson(receipt), "utf8")) };
}

function prepareResponseAdmissionControllerForVersion({
  attemptId, trialId, predecessorRoleIds = [], documentValidation, documentChunks, documentSourcePages,
  batchChunkIds, expectedModel, maxOutputTokens, contextWindowTokens, documentRouting,
}, controllerVersion) {
  assertion(REPLAYABLE_CONTROLLER_VERSIONS.has(controllerVersion),
    "controller plan version is unsupported");
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
  const bindsModelContext = MODEL_CONTEXT_CONTROLLER_VERSIONS.has(controllerVersion);
  if (bindsModelContext) {
    assertion(Number.isSafeInteger(contextWindowTokens) && contextWindowTokens > maxOutputTokens,
      "contextWindowTokens must exceed maxOutputTokens");
  } else {
    assertion(contextWindowTokens === undefined,
      "legacy controller plans cannot add a model-context binding");
  }
  assertion(Array.isArray(documentChunks)
    && documentChunks.length === documentValidation.ordered_chunk_ids.length,
  "documentChunks does not match the frozen chunk denominator");
  assertion(canonicalJson(documentChunks.map(chunk => chunk.chunk_id))
    === canonicalJson(documentValidation.ordered_chunk_ids),
  "documentChunks does not match the frozen ordered chunk scope");
  assertion(Array.isArray(batchChunkIds) && batchChunkIds.length > 0
    && batchChunkIds.every(batch => Array.isArray(batch) && batch.length > 0),
  "batchChunkIds must contain non-empty batches");
  const selectedChunkIds = batchChunkIds.flat();
  const bindsDocumentRouting = ROUTED_CONTROLLER_VERSIONS.has(controllerVersion);
  if (bindsDocumentRouting && documentRouting !== undefined && documentRouting !== null) {
    validateDocumentRouting(documentRouting, documentValidation, documentChunks, documentSourcePages,
      selectedChunkIds);
  } else {
    assertion(documentRouting === undefined || (bindsDocumentRouting && documentRouting === null),
      "legacy controller plans cannot add a document-routing binding");
    assertion(canonicalJson(selectedChunkIds) === canonicalJson(documentValidation.ordered_chunk_ids),
      "batchChunkIds must cover the exact ordered full chunk scope once");
  }

  const modelContext = bindsModelContext ? buildModelContextCapacityBinding({
    model: expectedModel,
    contextWindowTokens,
  }) : null;
  const batches = batchChunkIds.map((chunkIds, index) => {
    const policy = classifySourceBoundBatch({
      documentId: documentValidation.document_id,
      documentMapSha256: documentValidation.document_map_sha256,
      sourceSha256: documentValidation.source_sha256,
      documentChunks,
      documentTableRegions: documentValidation.table_regions,
      documentSourcePages,
      batchChunkIds: chunkIds,
    });
    assertion(policy.source_page_text_bundle_sha256 === documentValidation.source_page_text_bundle_sha256,
      "documentSourcePages does not match the frozen source-page bundle identity");
    const schema = buildVerifiedExtractionProposalSchema({ allowedFields: policy.allowed_fields });
    const policyKinds = new Set(policy.chunk_policies.map(item => item.evidence_admission));
    assertion(policyKinds.size === 1,
      "a batch cannot cross the source-evidence/reference-section boundary");
    const action = policy.model_call_recommended ? "model_call" : "skip_reference_section";
    const contextCapacityObservation = bindsModelContext && action === "model_call"
      ? observeSourceBoundExtractionRequestCapacity({
          request: buildSourceBoundExtractionRequest({
            model: expectedModel,
            maxOutputTokens,
            schema,
            documentChunks,
            documentTableRegions: documentValidation.table_regions,
            documentSourcePages,
            batchPolicy: policy,
            batchChunkIds: chunkIds,
          }),
          contextBinding: modelContext,
        })
      : null;
    return {
      batch_ordinal: index + 1,
      chunk_ids: [...chunkIds],
      policy,
      policy_sha256: sha256(Buffer.from(canonicalJson(policy), "utf8")),
      schema,
      schema_sha256: sha256(Buffer.from(canonicalJson(schema), "utf8")),
      action,
      ...(bindsModelContext ? { context_capacity_observation: contextCapacityObservation } : {}),
    };
  });
  if (controllerVersion !== CURRENT_CONTROLLER_VERSION) {
    let referenceSeen = false;
    for (const batch of batches) {
      if (batch.action === "skip_reference_section") referenceSeen = true;
      else assertion(!referenceSeen, "a model-call batch cannot follow the reference-section boundary");
    }
  }
  const modelBatches = batches.filter(batch => batch.action === "model_call");
  const referenceBatches = batches.filter(batch => batch.action === "skip_reference_section");
  const plan = {
    contract: { name: "pdf-tools.verified-extraction-response-controller", version: controllerVersion },
    attempt_id: attemptId,
    trial_id: trialId,
    document_validation: structuredClone(documentValidation),
    batch_chunk_ids: structuredClone(batchChunkIds),
    batches,
    expected_model: expectedModel,
    max_output_tokens: maxOutputTokens,
    ...(bindsModelContext ? { model_context: modelContext } : {}),
    ...(bindsDocumentRouting ? { document_routing: documentRouting === undefined
      ? null : structuredClone(documentRouting) } : {}),
    denominator: {
      document_chunks: documentChunks.length,
      ...(bindsDocumentRouting ? {
        routed_chunks: selectedChunkIds.length,
        unrouted_chunks: documentChunks.length - selectedChunkIds.length,
      } : {}),
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

export function prepareResponseAdmissionController(options) {
  return prepareResponseAdmissionControllerForVersion(options, CURRENT_CONTROLLER_VERSION);
}

export function validateResponseAdmissionControllerPlan({ plan, documentChunks, documentSourcePages }) {
  const bindsModelContext = MODEL_CONTEXT_CONTROLLER_VERSIONS.has(plan?.contract?.version);
  const bindsDocumentRouting = ROUTED_CONTROLLER_VERSIONS.has(plan?.contract?.version);
  exactKeys(plan, [
    ...PLAN_KEYS,
    ...(bindsModelContext ? ["model_context"] : []),
    ...(bindsDocumentRouting ? ["document_routing"] : []),
  ], "plan");
  exactKeys(plan.contract, ["name", "version"], "plan.contract");
  assertion(plan.contract.name === "pdf-tools.verified-extraction-response-controller"
    && REPLAYABLE_CONTROLLER_VERSIONS.has(plan.contract.version),
  "plan.contract is unsupported");
  assertion(SHA256.test(plan.plan_sha256 ?? "")
    && plan.plan_sha256 === sha256(Buffer.from(canonicalJson(planWithoutDigest(plan)), "utf8")),
  "plan.plan_sha256 does not bind the exact plan");
  const rebuilt = prepareResponseAdmissionControllerForVersion({
    attemptId: plan.attempt_id,
    trialId: plan.trial_id,
    documentValidation: plan.document_validation,
    documentChunks,
    documentSourcePages,
    batchChunkIds: plan.batch_chunk_ids,
    expectedModel: plan.expected_model,
    maxOutputTokens: plan.max_output_tokens,
    contextWindowTokens: bindsModelContext ? plan.model_context?.context_window_tokens : undefined,
    documentRouting: bindsDocumentRouting ? plan.document_routing : undefined,
  }, plan.contract.version);
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

function retainedCitation(citation) {
  return {
    ...structuredClone(citation),
    page: citation.page_one_based,
    public_citation: {
      page: citation.page_one_based,
      quote: citation.quote,
    },
    workspace_citation: {
      chunk_id: citation.chunk_id,
      start_utf8_byte: citation.chunk_start_utf8_byte,
      end_utf8_byte: citation.chunk_end_utf8_byte,
      quote_sha256: citation.chunk_source_excerpt_sha256,
    },
  };
}

export function materializeAdmittedSourceExtraction({
  plan, admissions, documentChunks, documentSourcePages,
}) {
  validateResponseAdmissionControllerPlan({ plan, documentChunks, documentSourcePages });
  assertion(Array.isArray(admissions), "admissions must be an array");
  const admittedBatches = plan.batches.filter(batch => batch.action === "model_call");
  const batchesByPolicySha256 = new Map(admittedBatches.map(batch => [batch.policy_sha256, batch]));
  const seenPolicies = new Set();
  const selected = {
    publication: { agency: null, publication_citation_excerpt: null },
    contributors: [],
    summary: { contributor_count: 0, first_table: null },
  };
  const citations = {};
  const contributorNames = new Set();
  const inputAdmissionSha256s = [];
  let precedingBatchOrdinal = 0;

  for (const [admissionIndex, admission] of admissions.entries()) {
    const batch = batchesByPolicySha256.get(admission?.batch_policy_sha256);
    assertion(batch && !seenPolicies.has(batch.policy_sha256),
      `admissions[${admissionIndex}] has an unplanned or duplicate batch policy`);
    assertion(batch.batch_ordinal > precedingBatchOrdinal,
      "admissions are not in frozen batch order");
    seenPolicies.add(batch.policy_sha256);
    precedingBatchOrdinal = batch.batch_ordinal;
    compareAdmittedCitationEvidence({
      admission,
      batchPolicy: batch.policy,
      documentChunks,
      documentSourcePages,
    });
    const admissionSha256 = sha256(Buffer.from(canonicalJson(admission), "utf8"));
    inputAdmissionSha256s.push(admissionSha256);
    const evidenceByField = new Map(admission.source_replay.citations.map(citation => {
      assertion(!citation.field.startsWith("contributors[") || /^contributors\[[0-9]+\]$/u.test(citation.field),
        "admission contributor citation field is invalid");
      return [citation.field, citation];
    }));

    for (const field of ["agency", "publication_citation_excerpt"]) {
      const item = admission.proposal[field];
      if (selected.publication[field] !== null || item === null) continue;
      const evidence = evidenceByField.get(field);
      assertion(evidence, `admission omitted canonical ${field} evidence`);
      selected.publication[field] = item.value;
      citations[`publication.${field}`] = retainedCitation(evidence);
    }

    admission.proposal.contributors.forEach((contributor, contributorIndex) => {
      if (contributorNames.has(contributor.name)) return;
      const evidence = evidenceByField.get(`contributors[${contributorIndex}]`);
      assertion(evidence, `admission omitted canonical contributors[${contributorIndex}] evidence`);
      contributorNames.add(contributor.name);
      selected.contributors.push({ name: contributor.name });
      citations[`contributors[name=${contributor.name}]`] = retainedCitation(evidence);
    });

    const table = admission.proposal.first_table;
    if (table !== null && (selected.summary.first_table === null
      || table.page_one_based < selected.summary.first_table.page_one_based)) {
      const evidence = evidenceByField.get("first_table");
      assertion(evidence && evidence.page_one_based === table.page_one_based,
        "admission omitted canonical first_table evidence");
      selected.summary.first_table = {
        page_one_based: table.page_one_based,
        anchor_excerpt: table.anchor_excerpt,
      };
      citations["summary.first_table"] = retainedCitation(evidence);
    }
  }

  const missingRequiredPaths = [];
  selected.summary.contributor_count = selected.contributors.length;
  if (selected.publication.agency === null) missingRequiredPaths.push("publication.agency");
  if (selected.publication.publication_citation_excerpt === null) {
    missingRequiredPaths.push("publication.publication_citation_excerpt");
  }
  if (selected.contributors.length === 0) missingRequiredPaths.push("contributors");
  if (selected.summary.first_table === null) missingRequiredPaths.push("summary.first_table");
  missingRequiredPaths.sort();
  const complete = missingRequiredPaths.length === 0;
  const body = {
    contract: { name: "pdf-tools.verified-extraction-source-materialization", version: 1 },
    document_id: plan.document_validation.document_id,
    document_map_sha256: plan.document_validation.document_map_sha256,
    source_sha256: plan.document_validation.source_sha256,
    source_page_text_bundle_sha256: plan.document_validation.source_page_text_bundle_sha256,
    input_admission_sha256s: inputAdmissionSha256s,
    status: complete ? "complete" : "incomplete",
    result: complete ? structuredClone(selected) : null,
    selected,
    citation_evidence: citations,
    public_citations: Object.fromEntries(Object.entries(citations).map(([field, citation]) => (
      [field, structuredClone(citation.public_citation)]
    ))),
    workspace_citations: Object.fromEntries(Object.entries(citations).map(([field, citation]) => (
      [field, structuredClone(citation.workspace_citation)]
    ))),
    missing_required_paths: missingRequiredPaths,
    benchmark_claim_ready: false,
  };
  return {
    ...body,
    extraction_sha256: sha256(Buffer.from(canonicalJson(body), "utf8")),
  };
}

export async function runResponseAdmissionControllerAttempt({ plan, documentChunks, documentSourcePages, invokeBatch }) {
  validateResponseAdmissionControllerPlan({ plan, documentChunks, documentSourcePages });
  assertion(typeof invokeBatch === "function", "invokeBatch must be a function");
  const batchOutcomes = [];
  const admissions = [];
  let modelCalls = 0;
  let fatalFailure = null;
  const typedFailures = [];

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
        sourceSha256: plan.document_validation.source_sha256,
        documentChunks,
        documentTableRegions: plan.document_validation.table_regions,
        documentSourcePages,
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
      const typed = error instanceof ModelOutputAdmissionError
        || error instanceof ModelContextCapacityError;
      const failure = {
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
      if (typed) typedFailures.push(failure);
      else {
        fatalFailure = failure;
        break;
      }
    }
  }

  const completed = fatalFailure === null;
  const completedOutcome = typedFailures.length === 0
    ? { classification: "completed", reason_code: "none", message: null }
    : {
        classification: "completed",
        reason_code: "typed_batch_rejections",
        message: `${typedFailures.length} model batch response(s) failed strict admission`,
      };
  const sourceExtraction = completed ? materializeAdmittedSourceExtraction({
    plan, admissions, documentChunks, documentSourcePages,
  }) : null;
  const receipt = receiptWithDigest({
    contract: { name: "pdf-tools.verified-extraction-response-controller-receipt", version: 2 },
    attempt_id: plan.attempt_id,
    trial_id: plan.trial_id,
    controller_plan_sha256: plan.plan_sha256,
    document_id: plan.document_validation.document_id,
    document_map_sha256: plan.document_validation.document_map_sha256,
    denominator: structuredClone(plan.denominator),
    observed: {
      batch_outcomes: batchOutcomes.length,
      admitted_batches: admissions.length,
      typed_rejected_batches: typedFailures.length,
      model_calls: modelCalls,
      skipped_reference_batches: batchOutcomes.filter(item => item.status === "skipped_reference_section").length,
      unattempted_batches: plan.batches.length - batchOutcomes.length,
    },
    batch_outcomes: batchOutcomes,
    outcome: fatalFailure ?? completedOutcome,
    calculation_evidence: completed ? completedAggregate(admissions) : null,
    source_extraction: sourceExtraction,
    benchmark_claim_ready: false,
  });
  return { receipt, admissions, source_extraction: sourceExtraction };
}

export const VERIFIED_EXTRACTION_RESPONSE_CONTROLLER_POLICY = Object.freeze({
  name: "pdf-tools.verified-extraction-response-controller",
  version: CURRENT_CONTROLLER_VERSION,
  boundary: "The controller exact-binds one validated document map, the canonical PDF.js source-page bundle, the model context capacity, and the complete ordered chunk denominator. Current plans may additionally bind a schema-directed routing plan whose selected chunks must be a unique ordered subset of that denominator; both routed and unrouted chunk counts remain explicit. Without that binding, callers must still cover the full chunk scope exactly once. It permits first-table proposals only in the batch containing the first classified actual data table, skips each reference-section span before invocation while allowing a later explicit appendix to reopen source eligibility, isolates typed response or pre-invocation context-capacity rejection while continuing later frozen batches, and materializes final selected fields and citations only from the already-validated canonical source-replay spans retained by each admission. Each selected citation retains full evidence plus separate canonical-page scoring and exact-chunk workspace-verification projections. It never reinterprets those spans through a second byte-exact chunk check, and every incomplete materialization retains exact missing paths. Harness or invocation failure remains fatal and denominator preserving. It performs no model or provider call by itself.",
});
