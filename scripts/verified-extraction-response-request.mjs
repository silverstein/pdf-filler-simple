import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const VERIFIED_EXTRACTION_REQUEST_MODE = "prompted_json_with_exact_chunk_page_metadata";
const CHUNK_ID = /^chunk\.[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const sha256 = value => createHash("sha256").update(value).digest("hex");

function validateTableRegions(value) {
  assert.equal(typeof value, "object");
  assert.ok(Array.isArray(value.items));
  const first = value.items[0] ?? null;
  if (first !== null) {
    assert.ok(Number.isInteger(first.page) && first.page >= 1);
    assert.match(first.region_id, /^p[1-9][0-9]*-t[1-9][0-9]*$/u);
  }
  return first;
}

export function buildSourceBoundExtractionRequest({
  model,
  maxOutputTokens,
  schema,
  documentChunks,
  documentTableRegions,
  batchChunkIds,
}) {
  assert.equal(typeof model, "string");
  assert.ok(model.length > 0);
  assert.ok(Number.isInteger(maxOutputTokens) && maxOutputTokens > 0);
  assert.equal(schema?.type, "object");
  assert.equal(schema?.additionalProperties, false);
  assert.ok(Array.isArray(documentChunks));
  assert.ok(Array.isArray(batchChunkIds) && batchChunkIds.length > 0);
  const firstTableRegion = validateTableRegions(documentTableRegions);
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

  const firstTablePage = firstTableRegion?.page ?? null;
  const sourceChunks = selected.map((item) => {
    const isFirstTablePage = item.page_range.start_page === firstTablePage;
    return [
      `[chunk_id=${item.chunk_id} page_one_based=${item.page_range.start_page} first_table_region=${isFirstTablePage}]`,
      item.content,
    ].join("\n");
  });
  const userPrompt = [
    "Return exactly one JSON object. Output no prose, markdown, code fences, or a second JSON value.",
    "The object must match the JSON schema below. All required keys must be present and no extra keys are allowed.",
    "Use only literal values and citation quotes from the SOURCE CHUNKS below.",
    "A requested field may be absent from this batch. Use null or an empty array when the supplied chunks do not support it.",
    "Do not cite or extract people from a References section.",
    "The page_one_based metadata is authoritative physical PDF page evidence; never infer it from printed page labels or table numbers.",
    firstTablePage === null
      ? "No deterministic first table region exists; first_table must be null."
      : `The deterministic first table region is on physical page ${firstTablePage}. first_table must be null unless its exact cited chunk has first_table_region=true; when non-null, page_one_based must be ${firstTablePage}.`,
    "OUTPUT JSON SCHEMA:",
    JSON.stringify(schema),
    "SOURCE CHUNKS:",
    ...sourceChunks,
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
