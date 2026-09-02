import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  classifySourceBoundBatch,
  validateNormalizedSourcePageBundle,
} from "./verified-extraction-response-admission.mjs";

export const VERIFIED_EXTRACTION_REQUEST_MODE = "prompted_json_with_exact_chunk_page_metadata";
export const VERIFIED_EXTRACTION_CONTEXT_CAPACITY_POLICY = Object.freeze({
  name: "pdf-tools.model-context-capacity",
  version: 1,
  estimator: "utf8_request_bytes_plus_fixed_chat_template_ceiling",
  maximum_prompt_tokens_per_request_utf8_byte: 1,
  chat_template_overhead_token_ceiling: 512,
});
const CHUNK_ID = /^chunk\.[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_CANONICAL_SOURCE_PAGE_PROMPT_BYTES = 48 * 1024;
const MAX_CANONICAL_SOURCE_PROMPT_BYTES = 96 * 1024;
const sha256 = value => createHash("sha256").update(value).digest("hex");
const canonicalJson = value => Array.isArray(value) ? `[${value.map(canonicalJson).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
    : JSON.stringify(value);

export class ModelContextCapacityError extends Error {
  constructor(observation) {
    super(`Model request capacity upper bound ${observation.required_context_tokens_upper_bound}`
      + ` exceeds context ${observation.context_window_tokens}`);
    this.name = "ModelContextCapacityError";
    this.code = "model_context_capacity_exceeded";
    this.observation = structuredClone(observation);
  }
}

export function buildModelContextCapacityBinding({ model, contextWindowTokens }) {
  assert.equal(typeof model, "string");
  assert.ok(model.length > 0);
  assert.ok(Number.isSafeInteger(contextWindowTokens) && contextWindowTokens > 0);
  const body = {
    contract: { name: "pdf-tools.model-context-capacity-binding", version: 1 },
    model,
    context_window_tokens: contextWindowTokens,
    policy: structuredClone(VERIFIED_EXTRACTION_CONTEXT_CAPACITY_POLICY),
  };
  return {
    ...body,
    binding_sha256: sha256(Buffer.from(canonicalJson(body), "utf8")),
  };
}

export function observeSourceBoundExtractionRequestCapacity({ request, contextBinding }) {
  assert.deepEqual(Object.keys(request).sort(), [
    "max_tokens", "messages", "model", "seed", "stream", "temperature", "top_p",
  ]);
  assert.deepEqual(Object.keys(contextBinding).sort(), [
    "binding_sha256", "context_window_tokens", "contract", "model", "policy",
  ]);
  const rebuiltBinding = buildModelContextCapacityBinding({
    model: contextBinding.model,
    contextWindowTokens: contextBinding.context_window_tokens,
  });
  assert.deepEqual(contextBinding, rebuiltBinding);
  assert.equal(request.model, contextBinding.model);
  assert.ok(Number.isSafeInteger(request.max_tokens) && request.max_tokens > 0);
  assert.ok(Array.isArray(request.messages) && request.messages.length === 2);
  request.messages.forEach((message, index) => {
    assert.deepEqual(Object.keys(message).sort(), ["content", "role"]);
    assert.equal(message.role, index === 0 ? "system" : "user");
    assert.equal(typeof message.content, "string");
  });
  const requestPromptShape = { model: request.model, messages: request.messages };
  const requestUtf8Bytes = Buffer.byteLength(canonicalJson(requestPromptShape), "utf8");
  const promptTokensUpperBound = requestUtf8Bytes
    * contextBinding.policy.maximum_prompt_tokens_per_request_utf8_byte
    + contextBinding.policy.chat_template_overhead_token_ceiling;
  const requiredContextTokensUpperBound = promptTokensUpperBound + request.max_tokens;
  const body = {
    contract: { name: "pdf-tools.model-context-capacity-observation", version: 1 },
    context_binding_sha256: contextBinding.binding_sha256,
    model: request.model,
    request_sha256: sha256(Buffer.from(canonicalJson(request), "utf8")),
    request_utf8_bytes: requestUtf8Bytes,
    prompt_tokens_upper_bound: promptTokensUpperBound,
    reserved_output_tokens: request.max_tokens,
    required_context_tokens_upper_bound: requiredContextTokensUpperBound,
    context_window_tokens: contextBinding.context_window_tokens,
    fits: requiredContextTokensUpperBound <= contextBinding.context_window_tokens,
    estimator: contextBinding.policy.estimator,
    model_or_provider_calls_made: 0,
  };
  const observation = {
    ...body,
    observation_sha256: sha256(Buffer.from(canonicalJson(body), "utf8")),
  };
  return observation;
}

export function preflightSourceBoundExtractionRequest({ request, contextBinding }) {
  const observation = observeSourceBoundExtractionRequestCapacity({ request, contextBinding });
  if (!observation.fits) throw new ModelContextCapacityError(observation);
  return observation;
}

export function buildSourceBoundExtractionRequest({
  model,
  maxOutputTokens,
  schema,
  documentChunks,
  documentTableRegions,
  documentSourcePages,
  batchPolicy,
  batchChunkIds,
}) {
  assert.equal(typeof model, "string");
  assert.ok(model.length > 0);
  assert.ok(Number.isInteger(maxOutputTokens) && maxOutputTokens > 0);
  assert.equal(schema?.type, "object");
  assert.equal(schema?.additionalProperties, false);
  assert.ok(Array.isArray(documentChunks));
  assert.ok(Array.isArray(batchChunkIds) && batchChunkIds.length > 0);
  const validatedSourcePages = validateNormalizedSourcePageBundle(documentSourcePages, {
    documentId: documentChunks[0]?.document_id,
    sourceSha256: batchPolicy?.source_sha256,
  });
  const recomputedBatchPolicy = classifySourceBoundBatch({
    documentId: batchPolicy?.document_id,
    documentMapSha256: batchPolicy?.document_map_sha256,
    sourceSha256: batchPolicy?.source_sha256,
    documentChunks,
    documentTableRegions,
    documentSourcePages,
    batchChunkIds,
  });
  assert.deepEqual(batchPolicy, recomputedBatchPolicy);
  assert.equal(batchPolicy.source_page_text_bundle_sha256, validatedSourcePages.sha256);
  const admitted = new Set(batchChunkIds);
  assert.equal(admitted.size, batchChunkIds.length);
  const selected = documentChunks.filter((item) => admitted.has(item.chunk_id));
  assert.equal(selected.length, batchChunkIds.length);
  assert.deepEqual(selected.map((item) => item.chunk_id), batchChunkIds);
  const documentId = selected[0]?.document_id;
  assert.equal(typeof documentId, "string");
  assert.ok(documentId.length > 0);
  for (const chunk of selected) {
    assert.equal(chunk.document_id, documentId);
    assert.match(chunk.chunk_id, CHUNK_ID);
    assert.equal(typeof chunk.content, "string");
    assert.ok(chunk.content.length > 0);
    assert.match(chunk.content_sha256, SHA256);
    assert.equal(chunk.content_sha256, sha256(Buffer.from(chunk.content, "utf8")));
    assert.ok(Number.isInteger(chunk.page_range?.start_page));
    assert.ok(chunk.page_range.start_page >= 1);
    assert.equal(chunk.page_range.start_page, chunk.page_range.end_page);
  }

  const firstTablePage = batchPolicy.first_actual_table?.page_one_based ?? null;
  const firstTableSupportAnchor = batchPolicy.first_actual_table?.support_anchor ?? null;
  const sourceChunks = selected.map((item) => {
    const isFirstTablePage = item.page_range.start_page === firstTablePage;
    return [
      `[chunk_id=${item.chunk_id} page_one_based=${item.page_range.start_page} first_table_source_heading=${isFirstTablePage}]`,
      item.content,
    ].join("\n");
  });
  const selectedPages = [...new Set(selected.map(item => item.page_range.start_page))];
  let canonicalSourcePromptBytes = 0;
  const canonicalSourcePages = selectedPages.map((pageOneBased) => {
    const page = validatedSourcePages.pagesByNumber.get(pageOneBased);
    assert.ok(page, `canonical source page ${pageOneBased} is absent`);
    const pageBytes = Buffer.byteLength(page.normalized_text, "utf8");
    assert.ok(pageBytes <= MAX_CANONICAL_SOURCE_PAGE_PROMPT_BYTES,
      `canonical source page ${pageOneBased} exceeds the prompt byte limit`);
    canonicalSourcePromptBytes += pageBytes;
    assert.ok(canonicalSourcePromptBytes <= MAX_CANONICAL_SOURCE_PROMPT_BYTES,
      "canonical source pages exceed the aggregate prompt byte limit");
    return `[canonical_source_page=${pageOneBased} sha256=${page.normalized_text_sha256}]\n${page.normalized_text}`;
  });
  const userPrompt = [
    "Return exactly one JSON object. Output no prose, markdown, code fences, or a second JSON value.",
    "The object must match the JSON schema below. All required keys must be present and no extra keys are allowed.",
    "Use only values and citation quotes copied literally from the CANONICAL SOURCE PAGES below.",
    "Each citation chunk_id must name a SOURCE CHUNK on the same physical page that contains the same value; canonical source-page text controls punctuation and spacing.",
    "A requested field may be absent from this batch. Use null or an empty array when the supplied chunks do not support it.",
    "Do not cite or extract people from a References section.",
    "Each contributors item must be one complete human-readable individual display name copied from source; never combine people with 'and' or a semicolon.",
    "When a Suggested citation: label exists, publication_citation_excerpt must copy a 50-700 character source span that begins with that exact label and includes the DOI.",
    "The page_one_based metadata is authoritative physical PDF page evidence; never infer it from printed page labels or table numbers.",
    firstTablePage === null
      ? "No deterministic first table source heading exists; first_table must be null."
      : `The first source-classified actual data table heading is on physical page ${firstTablePage}. first_table must be null unless its exact cited chunk has first_table_source_heading=true; when non-null, page_one_based must be ${firstTablePage}, and anchor_excerpt must begin with the exact deterministic support prefix ${JSON.stringify(firstTableSupportAnchor)} and contain 20-360 characters from the actual heading.`,
    "OUTPUT JSON SCHEMA:",
    JSON.stringify(schema),
    "SOURCE CHUNKS:",
    ...sourceChunks,
    "CANONICAL SOURCE PAGES:",
    ...canonicalSourcePages,
  ].join("\n\n");

  return {
    model,
    messages: [
      { role: "system", content: "You are a deterministic source-bound JSON extraction engine. Output exactly one JSON object." },
      { role: "user", content: userPrompt },
    ],
    temperature: 0,
    top_p: 1,
    seed: 20260829,
    max_tokens: maxOutputTokens,
    stream: false,
  };
}
