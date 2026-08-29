import { createHash } from "node:crypto";

import {
  prepareResponseAdmissionController,
  runResponseAdmissionControllerAttempt,
} from "./verified-extraction-response-controller.mjs";
import { validateNormalizedSourcePageBundle } from "./verified-extraction-response-admission.mjs";
import { buildSourceBoundExtractionRequest } from "./verified-extraction-response-request.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const CHUNK_ID = /^chunk\.[a-f0-9]{64}$/u;

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

function nonzeroSha256(value, label) {
  assertion(SHA256.test(value ?? "") && value !== "0".repeat(64), `${label} is invalid`);
  return value;
}

function withoutKey(value, key) {
  const copy = structuredClone(value);
  delete copy[key];
  return copy;
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
}) {
  const documentValidation = buildSourceBoundDocumentValidation({
    documentId,
    documentMap,
    documentChunks,
    documentSourcePages,
  });
  const plan = prepareResponseAdmissionController({
    attemptId,
    trialId,
    predecessorRoleIds,
    documentValidation,
    documentChunks,
    documentSourcePages,
    batchChunkIds,
    expectedModel,
    maxOutputTokens,
  });
  return {
    plan,
    document_source_pages: structuredClone(documentSourcePages),
  };
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
      return invokeRequest({ batch: structuredClone(batch), request });
    },
  });
}

export const VERIFIED_EXTRACTION_RESPONSE_PIPELINE_POLICY = Object.freeze({
  name: "pdf-tools.verified-extraction-response-pipeline",
  version: "1.0.0-experimental",
  boundary: "The pipeline derives one exact document-validation object from the retained document map and canonical source-page bundle, passes that same bundle through plan validation and response admission, and constructs every model request with the controller-frozen batch policy. It performs no model or provider call by itself.",
});
