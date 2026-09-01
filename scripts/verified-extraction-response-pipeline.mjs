import { createHash } from "node:crypto";

import {
  materializeAdmittedSourceExtraction,
  prepareResponseAdmissionController,
  runResponseAdmissionControllerAttempt,
} from "./verified-extraction-response-controller.mjs";
import {
  buildVerifiedExtractionProposalSchema,
  classifySourceBoundBatch,
  validateNormalizedSourcePageBundle,
} from "./verified-extraction-response-admission.mjs";
import {
  buildModelContextCapacityBinding,
  buildSourceBoundExtractionRequest,
  ModelContextCapacityError,
  observeSourceBoundExtractionRequestCapacity,
  preflightSourceBoundExtractionRequest,
} from "./verified-extraction-response-request.mjs";
import {
  buildSchemaDirectedEvidencePlan,
  canonicalizeSchemaDirectedExtraction,
} from "./verified-extraction-evidence-router.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const CHUNK_ID = /^chunk\.[a-f0-9]{64}$/u;
const CONTRIBUTOR_CITATION = /^contributors\[name=(.+)\]$/u;

const sha256 = value => createHash("sha256").update(value).digest("hex");
const canonicalJson = value => Array.isArray(value) ? `[${value.map(canonicalJson).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
    : JSON.stringify(value);

function assertion(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
  assertion(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assertion(canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort()),
    `${label} keys are invalid`);
}

function withoutDigest(value, key) {
  const copy = structuredClone(value);
  delete copy[key];
  return copy;
}

export function deriveRetainedPagePartition({ pageCount, retainedPageNumbers, aggregateTraceRetained }) {
  assertion(Number.isSafeInteger(pageCount) && pageCount > 0,
    "pageCount must be a positive safe integer");
  assertion(Array.isArray(retainedPageNumbers)
    && retainedPageNumbers.every(page => Number.isSafeInteger(page) && page >= 1 && page <= pageCount)
    && new Set(retainedPageNumbers).size === retainedPageNumbers.length,
  "retainedPageNumbers must contain unique in-range pages");
  const orderedRetained = [...retainedPageNumbers].sort((left, right) => left - right);
  assertion(canonicalJson(orderedRetained) === canonicalJson(retainedPageNumbers),
    "retainedPageNumbers must be in ascending order");
  assertion(typeof aggregateTraceRetained === "boolean",
    "aggregateTraceRetained must be a boolean");
  const processed = aggregateTraceRetained ? orderedRetained : [];
  const processedSet = new Set(processed);
  return {
    processed_page_numbers: processed,
    unprocessed_page_numbers: Array.from({ length: pageCount }, (_, index) => index + 1)
      .filter(page => !processedSet.has(page)),
  };
}

function nonzeroSha256(value, label) {
  assertion(SHA256.test(value ?? "") && value !== "0".repeat(64), `${label} is invalid`);
  return value;
}

function withoutKey(value, key) {
  const copy = structuredClone(value);
  delete copy[key];
  return copy;
}

function normalizeSourceText(value) {
  assertion(typeof value === "string", "source text must be a string");
  return value.replace(/\s+/gu, " ").trim();
}

function citationSupportValue(result, citationKey) {
  if (citationKey === "publication.agency") return result.publication.agency;
  if (citationKey === "publication.publication_citation_excerpt") {
    return result.publication.publication_citation_excerpt;
  }
  if (citationKey === "summary.first_table") return result.summary.first_table.anchor_excerpt;
  const contributor = CONTRIBUTOR_CITATION.exec(citationKey);
  assertion(contributor && result.contributors.some(item => item.name === contributor[1]),
    `canonical workspace citation key is unsupported: ${citationKey}`);
  return contributor[1];
}

function sourceTokens(value) {
  return [...new Set(normalizeSourceText(value).toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]+/gu) ?? [])].filter(token => token.length >= 2);
}

function tokenCoverage(needleTokens, contentTokens) {
  if (needleTokens.length === 0) return { count: 0, basis_points: 0 };
  const content = new Set(contentTokens);
  const count = needleTokens.filter(token => content.has(token)).length;
  return { count, basis_points: Math.floor((count * 10_000) / needleTokens.length) };
}

function compareSupportScore(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function selectWorkspaceCitationChunk({ citationKey, citation, supportValue, chunks }) {
  const quote = normalizeSourceText(citation.quote);
  const support = normalizeSourceText(supportValue);
  const quoteTokens = sourceTokens(quote);
  const supportTokens = sourceTokens(support);
  const candidates = chunks.map(chunk => {
    const normalizedContent = normalizeSourceText(chunk.content);
    const contentTokens = sourceTokens(normalizedContent);
    const supportCoverage = tokenCoverage(supportTokens, contentTokens);
    const quoteCoverage = tokenCoverage(quoteTokens, contentTokens);
    return {
      chunk,
      supportCoverage,
      quoteCoverage,
      score: [
        Number(normalizedContent.includes(support)),
        Number(normalizedContent.includes(quote)),
        supportCoverage.basis_points,
        quoteCoverage.basis_points,
        Number(chunk.page_range.start_page === citation.page),
      ],
    };
  }).filter(candidate => candidate.score[0] === 1 || candidate.score[1] === 1
    || (candidate.supportCoverage.count >= 2 && candidate.supportCoverage.basis_points >= 5_000)
    || (candidate.quoteCoverage.count >= 4 && candidate.quoteCoverage.basis_points >= 2_500));
  assertion(candidates.length > 0,
    `canonical citation ${citationKey} has no source-bound workspace support`);
  candidates.sort((left, right) => compareSupportScore(right.score, left.score));
  // Stable sort retains the already validated document-map chunk order as the final tie-breaker.
  // Repeated organization names and headers are common in government reports, so equal semantic
  // support is a representation tie rather than grounds to discard an otherwise valid result.
  return candidates[0].chunk;
}

export function buildSchemaDirectedWorkspaceState({ canonicalProjection, documentChunks }) {
  exactKeys(canonicalProjection, ["benchmark_claim_ready", "citations", "contract", "diagnostics",
    "evidence_plan_sha256", "projection_sha256", "result"], "canonical projection");
  assertion(canonicalProjection.benchmark_claim_ready === false,
    "canonical projection cannot authorize a benchmark claim");
  const projectionBody = structuredClone(canonicalProjection);
  delete projectionBody.projection_sha256;
  assertion(SHA256.test(canonicalProjection.projection_sha256 ?? "")
    && canonicalProjection.projection_sha256
      === sha256(Buffer.from(canonicalJson(projectionBody), "utf8")),
  "canonical projection digest drifted");
  assertion(Array.isArray(documentChunks) && documentChunks.length > 0,
    "documentChunks must be a non-empty array");
  const chunks = documentChunks.map((chunk, index) => {
    exactKeys(chunk, ["chunk_id", "content", "content_sha256", "document_id", "page_range",
      "starts_at_heading"], `documentChunks[${index}]`);
    assertion(CHUNK_ID.test(chunk.chunk_id ?? "")
      && chunk.page_range?.start_page === chunk.page_range?.end_page
      && Number.isSafeInteger(chunk.page_range.start_page) && chunk.page_range.start_page > 0
      && typeof chunk.content === "string" && chunk.content.length > 0
      && SHA256.test(chunk.content_sha256 ?? "")
      && sha256(Buffer.from(chunk.content, "utf8")) === chunk.content_sha256,
    `documentChunks[${index}] binding is invalid`);
    return chunk;
  });
  assertion(new Set(chunks.map(chunk => chunk.chunk_id)).size === chunks.length,
    "documentChunks contain duplicate identities");
  assertion(new Set(chunks.map(chunk => chunk.document_id)).size === 1,
    "documentChunks span multiple documents");
  const workspaceCitations = {};
  for (const [citationKey, citation] of Object.entries(canonicalProjection.citations)) {
    exactKeys(citation, ["page", "quote"], `canonical citation ${citationKey}`);
    assertion(Number.isSafeInteger(citation.page) && citation.page > 0
      && typeof citation.quote === "string" && citation.quote.length > 0,
    `canonical citation ${citationKey} is invalid`);
    const supportValue = normalizeSourceText(citationSupportValue(canonicalProjection.result, citationKey));
    const quote = normalizeSourceText(citation.quote);
    assertion(quote.includes(supportValue),
      `canonical citation ${citationKey} does not contain its submitted value`);
    const chunk = selectWorkspaceCitationChunk({
      citationKey,
      citation,
      supportValue,
      chunks,
    });
    workspaceCitations[citationKey] = {
      page: chunk.page_range.start_page,
      quote: chunk.content,
      chunk_id: chunk.chunk_id,
      start_utf8_byte: 0,
      end_utf8_byte: Buffer.byteLength(chunk.content, "utf8"),
      quote_sha256: chunk.content_sha256,
    };
  }
  return {
    publication: structuredClone(canonicalProjection.result.publication),
    contributors: structuredClone(canonicalProjection.result.contributors),
    summary: structuredClone(canonicalProjection.result.summary),
    citations: workspaceCitations,
  };
}

function fitBatchChunkIdsToModelContext({ documentValidation, documentChunks, documentSourcePages,
  batchChunkIds, expectedModel, maxOutputTokens, contextWindowTokens }) {
  assertion(Array.isArray(batchChunkIds) && batchChunkIds.length > 0,
    "batchChunkIds must be a non-empty array");
  const contextBinding = buildModelContextCapacityBinding({
    model: expectedModel,
    contextWindowTokens,
  });
  const documentPolicy = classifySourceBoundBatch({
    documentId: documentValidation.document_id,
    documentMapSha256: documentValidation.document_map_sha256,
    sourceSha256: documentValidation.source_sha256,
    documentChunks,
    documentTableRegions: documentValidation.table_regions,
    documentSourcePages,
    batchChunkIds: documentChunks.map(chunk => chunk.chunk_id),
  });
  const evidenceByChunk = new Map(documentPolicy.chunk_policies.map(item => (
    [item.chunk_id, item.evidence_admission]
  )));
  const evidenceScoped = batchChunkIds.flatMap(chunkIds => {
    const groups = [];
    for (const chunkId of chunkIds) {
      const evidence = evidenceByChunk.get(chunkId);
      assertion(typeof evidence === "string", "batchChunkIds contains an unknown chunk identity");
      const previous = groups.at(-1);
      if (previous?.evidence === evidence) previous.chunk_ids.push(chunkId);
      else groups.push({ evidence, chunk_ids: [chunkId] });
    }
    return groups.map(group => group.chunk_ids);
  });
  const fitted = [];
  const fit = chunkIds => {
    const policy = classifySourceBoundBatch({
      documentId: documentValidation.document_id,
      documentMapSha256: documentValidation.document_map_sha256,
      sourceSha256: documentValidation.source_sha256,
      documentChunks,
      documentTableRegions: documentValidation.table_regions,
      documentSourcePages,
      batchChunkIds: chunkIds,
    });
    if (!policy.model_call_recommended) {
      fitted.push([...chunkIds]);
      return;
    }
    const request = buildSourceBoundExtractionRequest({
      model: expectedModel,
      maxOutputTokens,
      schema: buildVerifiedExtractionProposalSchema({ allowedFields: policy.allowed_fields }),
      documentChunks,
      documentTableRegions: documentValidation.table_regions,
      documentSourcePages,
      batchPolicy: policy,
      batchChunkIds: chunkIds,
    });
    const observation = observeSourceBoundExtractionRequestCapacity({ request, contextBinding });
    if (observation.fits || chunkIds.length === 1) {
      fitted.push([...chunkIds]);
      return;
    }
    const midpoint = Math.ceil(chunkIds.length / 2);
    fit(chunkIds.slice(0, midpoint));
    fit(chunkIds.slice(midpoint));
  };
  evidenceScoped.forEach(fit);
  return fitted;
}

export function buildSourceBoundDocumentValidation({ documentId, documentMap, documentChunks,
  documentSourcePages }) {
  assertion(typeof documentId === "string" && documentId.length > 0,
    "documentId must be a non-empty string");
  assertion(documentMap && typeof documentMap === "object" && !Array.isArray(documentMap),
    "documentMap must be an object");
  assertion(Array.isArray(documentChunks) && documentChunks.length > 0,
    "documentChunks must be a non-empty array");
  const documentMapSha256 = nonzeroSha256(documentMap.document_map_sha256,
    "documentMap.document_map_sha256");
  assertion(documentMapSha256
    === sha256(Buffer.from(canonicalJson(withoutKey(documentMap, "document_map_sha256")), "utf8")),
  "documentMap.document_map_sha256 does not match the retained map bytes");
  const sourceSha256 = nonzeroSha256(documentMap.bindings?.source?.sha256,
    "documentMap.bindings.source.sha256");
  const schemaSha256 = nonzeroSha256(documentMap.bindings?.schema?.sha256,
    "documentMap.bindings.schema.sha256");
  assertion(documentMap.bindings?.renderer && typeof documentMap.bindings.renderer === "object"
    && !Array.isArray(documentMap.bindings.renderer),
  "documentMap.bindings.renderer must be an object");
  const rendererSha256 = sha256(Buffer.from(canonicalJson(documentMap.bindings.renderer), "utf8"));
  const descriptors = documentMap.chunks?.descriptors;
  assertion(Array.isArray(descriptors) && descriptors.length > 0,
    "documentMap.chunks.descriptors must be a non-empty array");
  const orderedChunkIds = descriptors.map((descriptor, index) => {
    const chunkId = descriptor?.chunk_id;
    assertion(CHUNK_ID.test(chunkId ?? ""), `documentMap.chunks.descriptors[${index}] is invalid`);
    return chunkId;
  });
  assertion(new Set(orderedChunkIds).size === orderedChunkIds.length,
    "documentMap contains duplicate chunk identities");
  assertion(canonicalJson(documentChunks.map(chunk => chunk?.chunk_id)) === canonicalJson(orderedChunkIds),
    "documentChunks does not match the exact document-map descriptor scope");
  assertion(documentSourcePages && typeof documentSourcePages === "object"
    && !Array.isArray(documentSourcePages), "documentSourcePages must be an object");
  assertion(documentSourcePages.document_id === documentId,
    "documentSourcePages belongs to another document");
  assertion(documentSourcePages.source_identity?.pdf_sha256 === sourceSha256,
    "documentSourcePages source identity drifted from the document map");
  assertion(documentSourcePages.source_identity?.page_count === documentMap.page_count,
    "documentSourcePages page denominator drifted from the document map");
  const sourcePageTextBundleSha256 = validateNormalizedSourcePageBundle(documentSourcePages, {
    documentId,
    sourceSha256,
  }).sha256;
  assertion(documentMap.table_regions && typeof documentMap.table_regions === "object"
    && !Array.isArray(documentMap.table_regions), "documentMap.table_regions must be an object");
  return {
    document_id: documentId,
    document_map_sha256: documentMapSha256,
    ordered_chunk_ids: orderedChunkIds,
    renderer_sha256: rendererSha256,
    schema_sha256: schemaSha256,
    source_page_text_bundle_sha256: sourcePageTextBundleSha256,
    source_sha256: sourceSha256,
    table_regions: structuredClone(documentMap.table_regions),
  };
}

export function prepareSourceBoundResponsePipeline({
  attemptId,
  trialId,
  predecessorRoleIds = [],
  documentId,
  documentMap,
  documentChunks,
  documentSourcePages,
  batchChunkIds,
  expectedModel,
  maxOutputTokens,
  contextWindowTokens,
  documentRouting,
}) {
  const documentValidation = buildSourceBoundDocumentValidation({
    documentId,
    documentMap,
    documentChunks,
    documentSourcePages,
  });
  const fittedBatchChunkIds = fitBatchChunkIdsToModelContext({
    documentValidation,
    documentChunks,
    documentSourcePages,
    batchChunkIds,
    expectedModel,
    maxOutputTokens,
    contextWindowTokens,
  });
  const plan = prepareResponseAdmissionController({
    attemptId,
    trialId,
    predecessorRoleIds,
    documentValidation,
    documentChunks,
    documentSourcePages,
    batchChunkIds: fittedBatchChunkIds,
    expectedModel,
    maxOutputTokens,
    contextWindowTokens,
    documentRouting,
  });
  return {
    plan,
    document_source_pages: structuredClone(documentSourcePages),
  };
}

export function prepareSchemaDirectedSourceBoundResponsePipeline({
  attemptId,
  trialId,
  predecessorRoleIds = [],
  documentId,
  documentMap,
  documentChunks,
  documentSourcePages,
  expectedModel,
  maxOutputTokens,
  contextWindowTokens,
}) {
  const evidencePlan = buildSchemaDirectedEvidencePlan({
    documentId,
    documentMapSha256: documentMap?.document_map_sha256,
    sourceSha256: documentMap?.bindings?.source?.sha256,
    documentChunks,
    documentTableRegions: documentMap?.table_regions,
    documentSourcePages,
  });
  const prepared = prepareSourceBoundResponsePipeline({
    attemptId,
    trialId,
    predecessorRoleIds,
    documentId,
    documentMap,
    documentChunks,
    documentSourcePages,
    batchChunkIds: evidencePlan.selected_pages.map(page => page.chunk_ids),
    expectedModel,
    maxOutputTokens,
    contextWindowTokens,
    documentRouting: evidencePlan,
  });
  return { evidence_plan: evidencePlan, prepared };
}

export function projectSchemaDirectedSourceBoundResponsePipelineResult({
  evidencePlan,
  documentChunks,
  documentTableRegions,
  documentSourcePages,
  finalized,
}) {
  exactKeys(finalized, ["extraction_sha256", "public_citations", "result", "workspace_state"],
    "finalized source pipeline");
  const canonicalProjection = canonicalizeSchemaDirectedExtraction({
    plan: evidencePlan,
    documentChunks,
    documentTableRegions,
    documentSourcePages,
    result: finalized.result,
  });
  const workspaceState = buildSchemaDirectedWorkspaceState({
    canonicalProjection,
    documentChunks,
  });
  return {
    evidence_plan_sha256: evidencePlan.plan_sha256,
    source_extraction_sha256: finalized.extraction_sha256,
    canonical_projection: canonicalProjection,
    workspace_state: workspaceState,
    source_pipeline: structuredClone(finalized),
    benchmark_claim_ready: false,
  };
}

function replayCompletedControllerAttempt({ prepared, documentChunks, attempt }) {
  exactKeys(prepared, ["document_source_pages", "plan"], "prepared pipeline");
  exactKeys(attempt, ["admissions", "receipt", "source_extraction"], "pipeline attempt");
  assertion(attempt.receipt?.outcome?.classification === "completed",
    "Only a completed response-controller attempt can be replayed");
  assertion(canonicalJson(attempt.receipt.source_extraction)
    === canonicalJson(attempt.source_extraction),
  "Response-controller receipt and returned source extraction drifted");
  const expected = materializeAdmittedSourceExtraction({
    plan: prepared.plan,
    admissions: attempt.admissions,
    documentChunks,
    documentSourcePages: prepared.document_source_pages,
  });
  assertion(canonicalJson(attempt.source_extraction) === canonicalJson(expected),
    "Response-controller source extraction does not replay from retained admissions");
  return expected;
}

function submittedContributorCandidates(admissions) {
  const names = [];
  const seen = new Set();
  for (const [admissionIndex, admission] of admissions.entries()) {
    const submitted = admission?.submitted_proposal?.contributors;
    assertion(Array.isArray(submitted),
      `admissions[${admissionIndex}] omitted submitted contributor candidates`);
    for (const [contributorIndex, contributor] of submitted.entries()) {
      exactKeys(contributor, ["citation", "name"],
        `admissions[${admissionIndex}].submitted_proposal.contributors[${contributorIndex}]`);
      assertion(typeof contributor.name === "string" && contributor.name.length > 0,
        `admissions[${admissionIndex}] submitted an invalid contributor name`);
      if (seen.has(contributor.name)) continue;
      seen.add(contributor.name);
      names.push(contributor.name);
    }
  }
  return names;
}

/**
 * Deterministically repairs a completed-but-incomplete schema-directed attempt from the
 * source pages and model proposals that are already retained by that exact attempt.
 *
 * This path deliberately cannot recover the agency, cannot operate on a fatal controller
 * attempt, and cannot accept model-authored field values directly. The canonical projection
 * re-derives the publication excerpt and first-table anchor from the frozen source pages. It
 * uses submitted contributor strings only as candidates, then requires one unique complete
 * display name for every citation author on the frozen byline page.
 */
export function recoverSchemaDirectedSourceBoundResponsePipelineAttempt({
  evidencePlan,
  prepared,
  documentChunks,
  documentTableRegions,
  documentSourcePages,
  attempt,
}) {
  assertion(canonicalJson(prepared?.plan?.document_routing) === canonicalJson(evidencePlan),
    "Recovery evidence plan drifted from the controller plan");
  assertion(canonicalJson(prepared?.document_source_pages) === canonicalJson(documentSourcePages),
    "Recovery source pages drifted from the prepared pipeline");
  assertion(canonicalJson(prepared?.plan?.document_validation?.table_regions)
    === canonicalJson(documentTableRegions),
  "Recovery table regions drifted from the prepared pipeline");
  const expected = replayCompletedControllerAttempt({ prepared, documentChunks, attempt });
  assertion(expected.status === "incomplete" && expected.result === null,
    "Only an incomplete source extraction can use deterministic recovery");
  const recoverablePaths = new Set([
    "contributors",
    "publication.publication_citation_excerpt",
    "summary.first_table",
  ]);
  assertion(expected.missing_required_paths.length > 0
    && expected.missing_required_paths.every(field => recoverablePaths.has(field)),
  "Incomplete extraction contains a non-recoverable required path");
  assertion(typeof expected.selected.publication.agency === "string"
    && expected.selected.publication.agency.length > 0,
  "Deterministic recovery requires an admitted source-bound agency");

  const candidateNames = submittedContributorCandidates(attempt.admissions);
  const candidateResult = {
    publication: {
      agency: expected.selected.publication.agency,
      publication_citation_excerpt: expected.selected.publication.publication_citation_excerpt,
    },
    contributors: candidateNames.map(name => ({ name })),
    summary: {
      contributor_count: candidateNames.length,
      first_table: structuredClone(expected.selected.summary.first_table),
    },
  };
  const canonicalProjection = canonicalizeSchemaDirectedExtraction({
    plan: evidencePlan,
    documentChunks,
    documentTableRegions,
    documentSourcePages,
    result: candidateResult,
  });
  const workspaceState = buildSchemaDirectedWorkspaceState({
    canonicalProjection,
    documentChunks,
  });
  const finalized = {
    extraction_sha256: expected.extraction_sha256,
    result: structuredClone(canonicalProjection.result),
    public_citations: structuredClone(canonicalProjection.citations),
    workspace_state: workspaceState,
  };
  const receiptBody = {
    contract: { name: "pdf-tools.schema-directed-source-recovery", version: 1 },
    evidence_plan_sha256: evidencePlan.plan_sha256,
    source_extraction_sha256: expected.extraction_sha256,
    input_admission_sha256s: structuredClone(expected.input_admission_sha256s),
    recovered_paths: structuredClone(expected.missing_required_paths),
    submitted_contributor_candidates_sha256: sha256(Buffer.from(canonicalJson(candidateNames), "utf8")),
    canonical_projection_sha256: canonicalProjection.projection_sha256,
    workspace_state_sha256: sha256(Buffer.from(canonicalJson(workspaceState), "utf8")),
    model_or_provider_calls_made: 0,
    oracle_accessed: false,
    benchmark_claim_ready: false,
  };
  const recoveryReceipt = {
    ...receiptBody,
    receipt_sha256: sha256(Buffer.from(canonicalJson(receiptBody), "utf8")),
  };
  assertion(recoveryReceipt.receipt_sha256
    === sha256(Buffer.from(canonicalJson(withoutDigest(recoveryReceipt, "receipt_sha256")), "utf8")),
  "Recovery receipt self-digest drifted");
  return { finalized, recovery_receipt: recoveryReceipt };
}

export async function runSourceBoundResponsePipelineAttempt({ prepared, documentChunks, invokeRequest }) {
  exactKeys(prepared, ["document_source_pages", "plan"], "prepared pipeline");
  assertion(typeof invokeRequest === "function", "invokeRequest must be a function");
  return runResponseAdmissionControllerAttempt({
    plan: prepared.plan,
    documentChunks,
    documentSourcePages: prepared.document_source_pages,
    invokeBatch: async ({ batch }) => {
      const request = buildSourceBoundExtractionRequest({
        model: prepared.plan.expected_model,
        maxOutputTokens: prepared.plan.max_output_tokens,
        schema: batch.schema,
        documentChunks,
        documentTableRegions: prepared.plan.document_validation.table_regions,
        documentSourcePages: prepared.document_source_pages,
        batchPolicy: batch.policy,
        batchChunkIds: batch.chunk_ids,
      });
      let contextCapacityObservation;
      try {
        contextCapacityObservation = preflightSourceBoundExtractionRequest({
          request,
          contextBinding: prepared.plan.model_context,
        });
      } catch (error) {
        if (!(error instanceof ModelContextCapacityError)) throw error;
        assertion(canonicalJson(error.observation)
          === canonicalJson(batch.context_capacity_observation),
        "runtime context-capacity rejection drifted from the frozen batch plan");
        throw error;
      }
      assertion(canonicalJson(contextCapacityObservation)
        === canonicalJson(batch.context_capacity_observation),
      "runtime context-capacity observation drifted from the frozen batch plan");
      return invokeRequest({
        batch: structuredClone(batch),
        request,
        context_capacity_observation: contextCapacityObservation,
      });
    },
  });
}

export function finalizeSourceBoundResponsePipelineAttempt({ prepared, documentChunks, attempt }) {
  const expected = replayCompletedControllerAttempt({ prepared, documentChunks, attempt });
  if (expected.status !== "complete") {
    throw Object.assign(new Error("Required extraction paths remain unsupported"), {
      code: "incomplete_extraction",
      missing_required_paths: structuredClone(expected.missing_required_paths),
      extraction_sha256: expected.extraction_sha256,
    });
  }
  const citations = Object.fromEntries(Object.entries(expected.citation_evidence).map(([field, citation]) => [
    field,
    {
      page: citation.public_citation.page,
      quote: citation.public_citation.quote,
      ...structuredClone(citation.workspace_citation),
    },
  ]));
  return {
    extraction_sha256: expected.extraction_sha256,
    result: structuredClone(expected.result),
    public_citations: structuredClone(expected.public_citations),
    workspace_state: {
      publication: structuredClone(expected.result.publication),
      contributors: structuredClone(expected.result.contributors),
      summary: structuredClone(expected.result.summary),
      citations,
    },
  };
}

export const VERIFIED_EXTRACTION_RESPONSE_PIPELINE_POLICY = Object.freeze({
  name: "pdf-tools.verified-extraction-response-pipeline",
  version: "1.5.0-experimental",
  boundary: "The pipeline derives one exact document-validation object from the retained document map and canonical source-page bundle. Its schema-directed entrypoint routes only the source-bound publication-citation, credited-byline, and first-actual-table pages, then deterministically splits those batches at every source-evidence boundary and until each multi-chunk request fits the frozen model-context upper bound. It retains a typed pre-invocation rejection when even one chunk cannot fit. It repeats and exact-compares that capacity observation immediately before invocation, passes the same source bundle through response admission and final source materialization, and constructs every model request with the controller-frozen batch policy. Its finalization boundary recomputes the complete source extraction from the retained admissions, exact-compares the controller receipt and returned extraction, and exposes both public citations and exact-chunk workspace citations. A separate recovery boundary can operate only on a completed controller attempt whose admitted agency is present and whose missing fields are contributors, publication citation, or first table. It derives citation and table values from the frozen source, accepts submitted contributor strings only as candidates for unique complete byline names in citation order, emits a digest-bound recovery receipt, and refuses every other missing path. Its projection boundary deterministically removes reference-derived contributor noise, preserves complete source-bound display names in citation order, recomputes contributor count, selects canonical source spans for the publication citation and first actual table, and projects that same canonical state into unique exact page/chunk bindings for the verified workspace. Its page-partition helper derives processed pages only from the ordered retained page inventory and clears that inventory when the aggregate trace is unavailable. It performs no model or provider call by itself.",
});
