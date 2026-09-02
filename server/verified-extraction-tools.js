import { randomBytes } from "node:crypto";

import {
  compileExtractionLeafObligations,
  verifyWorkspaceExtractionProposal,
} from "../scripts/verified-extraction-proposal.mjs";
import {
  appendUnverifiedWorkspaceProposal,
  appendVerifiedWorkspaceResult,
  canonicalWorkspaceJson,
  createExtractionWorkspace,
  deleteExtractionWorkspace,
  inspectExtractionWorkspace,
  readExtractionWorkspaceContext,
  readExtractionWorkspacePage,
} from "../scripts/verified-extraction-workspace.mjs";
import {
  buildSourceBoundDocumentMap,
  readSourceBoundDocumentChunk,
  validateSourceBoundDocumentMap,
} from "./document-map.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const EVENT_ID = /^event\.[a-f0-9]{64}$/u;
const CHUNK_ID = /^chunk\.[a-f0-9]{64}$/u;
const WORKSPACE_ID = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u;
const COLLECTIONS = ["document_map_chunks", "pending_leaves", "events", "proposals", "results"];
const TOOL_ARGUMENTS = Object.freeze({
  inspect_extraction_state: ["workspace_id", "workspace_identity_sha256"],
  read_extraction_workspace: [
    "workspace_id", "workspace_identity_sha256", "collection", "limit", "cursor",
  ],
  read_extraction_chunk: [
    "pdf_path", "password", "workspace_id", "workspace_identity_sha256", "chunk_id",
  ],
  submit_extraction_proposal: [
    "workspace_id", "workspace_identity_sha256", "parent_generation_sha256",
    "leaf_pointer", "proposed_value", "chunk_ids",
  ],
  verify_extraction_proposal: [
    "pdf_path", "password", "workspace_id", "workspace_identity_sha256",
    "proposal_generation_sha256", "proposal_event_id", "citations", "method",
  ],
  delete_extraction_workspace: [
    "workspace_id", "workspace_identity_sha256", "current_generation_sha256", "confirm",
  ],
});

function assertion(condition, message) {
  if (!condition) throw new Error(message);
}

function exactObject(value, allowed, label) {
  assertion(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`);
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  assertion(!unknown, `${label} has an unknown argument: ${unknown}.`);
  return value;
}

function requiredString(value, label, pattern = null) {
  assertion(typeof value === "string" && value.length > 0 && value.length <= 32_768,
    `${label} must be a non-empty string.`);
  assertion(!pattern || pattern.test(value), `${label} has an invalid format.`);
  return value;
}

function transactionId() {
  return randomBytes(16).toString("hex");
}

function schemaBytes(schema) {
  assertion(schema && typeof schema === "object" && !Array.isArray(schema),
    "schema must be a JSON Schema object.");
  return Buffer.from(`${canonicalWorkspaceJson(schema)}\n`, "utf8");
}

async function freshSourceContext({
  pdfPath,
  password,
  retained,
  resolvePdfPath,
  readPdfBytes,
  extractLayouts,
  maxPages = 200,
}) {
  const resolvedPath = resolvePdfPath(pdfPath);
  const sourceBytes = await readPdfBytes(resolvedPath);
  const layouts = await extractLayouts({
    resolvedPath,
    password,
    sourceBytes,
    maxPages,
  });
  validateSourceBoundDocumentMap(retained.document_map, {
    sourceBytes,
    schemaBytes: retained.schema_bytes,
    layouts,
  });
  return { resolvedPath, sourceBytes, layouts };
}

export const VERIFIED_EXTRACTION_TOOL_DEFINITIONS = Object.freeze([
  {
    name: "create_extraction_workspace",
    description: "Create a private local workspace bound to the exact PDF bytes and JSON Schema. The server maps every page with the local PDF parser, compiles the schema leaves, and stores no model output. Experimental and model-free.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        pdf_path: { type: "string" },
        password: { type: "string" },
        workspace_id: { type: "string", pattern: "^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$" },
        schema: { type: "object" },
        max_pages: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["pdf_path", "workspace_id", "schema"],
    },
    annotations: {
      title: "Create Verified Extraction Workspace",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "inspect_extraction_state",
    description: "Inspect the exact current generation and recovery state of a private verified-extraction workspace.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspace_id: { type: "string" },
        workspace_identity_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
      required: ["workspace_id", "workspace_identity_sha256"],
    },
    annotations: { title: "Inspect Verified Extraction Workspace", readOnlyHint: true,
      destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "read_extraction_workspace",
    description: "Read a bounded, cursor-bound page of document chunks, pending schema leaves, proposals, verification results, or append-only events.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspace_id: { type: "string" },
        workspace_identity_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        collection: { type: "string", enum: COLLECTIONS },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "string" },
      },
      required: ["workspace_id", "workspace_identity_sha256", "collection"],
    },
    annotations: { title: "Read Verified Extraction Workspace", readOnlyHint: true,
      destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "read_extraction_chunk",
    description: "Rebuild and return one source-bound chunk from the current PDF bytes. The chunk must belong to the workspace's returned inventory; omitted chunks cannot be requested.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        pdf_path: { type: "string" },
        password: { type: "string" },
        workspace_id: { type: "string" },
        workspace_identity_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        chunk_id: { type: "string", pattern: "^chunk\\.[a-f0-9]{64}$" },
      },
      required: ["pdf_path", "workspace_id", "workspace_identity_sha256", "chunk_id"],
    },
    annotations: { title: "Read Verified Extraction Chunk", readOnlyHint: true,
      destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "submit_extraction_proposal",
    description: "Append one explicitly unverified value proposal for a pending schema leaf, bound to one or more returned chunk IDs. This does not promote or trust the value.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspace_id: { type: "string" },
        workspace_identity_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        parent_generation_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        leaf_pointer: { type: "string" },
        proposed_value: {},
        chunk_ids: { type: "array", minItems: 1, maxItems: 32,
          items: { type: "string", pattern: "^chunk\\.[a-f0-9]{64}$" } },
      },
      required: ["workspace_id", "workspace_identity_sha256", "parent_generation_sha256",
        "leaf_pointer", "proposed_value", "chunk_ids"],
    },
    annotations: { title: "Submit Extraction Proposal", readOnlyHint: false,
      destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "verify_extraction_proposal",
    description: "Deterministically replay one proposal against fresh PDF bytes, the retained schema, and exact cited chunk byte ranges, then append the typed result. No model, network, or numeric confidence.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        pdf_path: { type: "string" },
        password: { type: "string" },
        workspace_id: { type: "string" },
        workspace_identity_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        proposal_generation_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        proposal_event_id: { type: "string", pattern: "^event\\.[a-f0-9]{64}$" },
        citations: { type: "array", maxItems: 32, items: {
          type: "object", additionalProperties: false,
          properties: {
            chunk_id: { type: "string", pattern: "^chunk\\.[a-f0-9]{64}$" },
            start_utf8_byte: { type: "integer", minimum: 0 },
            end_utf8_byte: { type: "integer", minimum: 1 },
            quote_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          }, required: ["chunk_id", "start_utf8_byte", "end_utf8_byte", "quote_sha256"],
        } },
        method: { type: "object" },
      },
      required: ["pdf_path", "workspace_id", "workspace_identity_sha256",
        "proposal_generation_sha256", "proposal_event_id", "citations", "method"],
    },
    annotations: { title: "Verify Extraction Proposal", readOnlyHint: false,
      destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "delete_extraction_workspace",
    description: "Permanently delete one private workspace only when both its exact identity and exact current generation match. Requires the literal confirmation DELETE.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspace_id: { type: "string" },
        workspace_identity_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        current_generation_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        confirm: { const: "DELETE" },
      },
      required: ["workspace_id", "workspace_identity_sha256", "current_generation_sha256", "confirm"],
    },
    annotations: { title: "Delete Verified Extraction Workspace", readOnlyHint: false,
      destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
]);

export function createVerifiedExtractionToolHandler({
  workspaceRoot,
  resolvePdfPath,
  readPdfBytes,
  extractLayouts,
}) {
  assertion(typeof workspaceRoot === "string" && workspaceRoot.length > 0,
    "workspaceRoot is required");
  assertion(typeof resolvePdfPath === "function" && typeof readPdfBytes === "function"
    && typeof extractLayouts === "function", "verified extraction dependencies are incomplete");

  return async function handleVerifiedExtractionTool(name, args) {
    if (name === "create_extraction_workspace") {
      const input = exactObject(args, ["pdf_path", "password", "workspace_id", "schema", "max_pages"], name);
      const workspaceId = requiredString(input.workspace_id, "workspace_id", WORKSPACE_ID);
      const exactSchemaBytes = schemaBytes(input.schema);
      const leafObligations = compileExtractionLeafObligations(exactSchemaBytes);
      const resolvedPath = resolvePdfPath(requiredString(input.pdf_path, "pdf_path"));
      const sourceBytes = await readPdfBytes(resolvedPath);
      const layouts = await extractLayouts({
        resolvedPath,
        password: input.password ?? null,
        sourceBytes,
        maxPages: input.max_pages ?? 200,
      });
      const documentMap = buildSourceBoundDocumentMap({
        sourceBytes,
        schemaBytes: exactSchemaBytes,
        layouts,
      });
      const created = await createExtractionWorkspace({
        rootPath: workspaceRoot,
        workspaceId,
        documentMap,
        sourceBytes,
        schemaBytes: exactSchemaBytes,
        layouts,
        leafObligations,
        transactionId: transactionId(),
      });
      return { ...created, leaf_obligations: leafObligations, document_map_sha256: documentMap.document_map_sha256 };
    }

    assertion(Object.hasOwn(TOOL_ARGUMENTS, name), `Unknown verified extraction tool: ${name}`);
    const input = exactObject(args, TOOL_ARGUMENTS[name], name);
    const workspaceId = requiredString(input.workspace_id, "workspace_id", WORKSPACE_ID);
    const identitySha256 = requiredString(
      input.workspace_identity_sha256,
      "workspace_identity_sha256",
      SHA256,
    );

    if (name === "inspect_extraction_state") {
      return inspectExtractionWorkspace({
        rootPath: workspaceRoot,
        workspaceId,
        expectedWorkspaceIdentitySha256: identitySha256,
      });
    }
    if (name === "read_extraction_workspace") {
      assertion(COLLECTIONS.includes(input.collection), "collection is unsupported.");
      return readExtractionWorkspacePage({
        rootPath: workspaceRoot,
        workspaceId,
        expectedWorkspaceIdentitySha256: identitySha256,
        collection: input.collection,
        limit: input.limit ?? 50,
        cursor: input.cursor ?? null,
      });
    }
    if (name === "submit_extraction_proposal") {
      requiredString(input.parent_generation_sha256, "parent_generation_sha256", SHA256);
      requiredString(input.leaf_pointer, "leaf_pointer");
      assertion(Array.isArray(input.chunk_ids) && input.chunk_ids.every(id => CHUNK_ID.test(id)),
        "chunk_ids are invalid.");
      return appendUnverifiedWorkspaceProposal({
        rootPath: workspaceRoot,
        workspaceId,
        expectedWorkspaceIdentitySha256: identitySha256,
        expectedParentGenerationSha256: input.parent_generation_sha256,
        leafPointer: input.leaf_pointer,
        proposedValue: input.proposed_value,
        chunkIds: input.chunk_ids,
        transactionId: transactionId(),
      });
    }
    if (name === "delete_extraction_workspace") {
      assertion(input.confirm === "DELETE", "confirm must be the literal DELETE.");
      requiredString(input.current_generation_sha256, "current_generation_sha256", SHA256);
      return deleteExtractionWorkspace({
        rootPath: workspaceRoot,
        workspaceId,
        expectedWorkspaceIdentitySha256: identitySha256,
        expectedCurrentGenerationSha256: input.current_generation_sha256,
      });
    }

    assertion(["read_extraction_chunk", "verify_extraction_proposal"].includes(name),
      `Unknown verified extraction tool: ${name}`);
    const retained = await readExtractionWorkspaceContext({
      rootPath: workspaceRoot,
      workspaceId,
      expectedWorkspaceIdentitySha256: identitySha256,
    });
    const fresh = await freshSourceContext({
      pdfPath: requiredString(input.pdf_path, "pdf_path"),
      password: input.password ?? null,
      retained,
      resolvePdfPath,
      readPdfBytes,
      extractLayouts,
    });
    if (name === "read_extraction_chunk") {
      requiredString(input.chunk_id, "chunk_id", CHUNK_ID);
      return readSourceBoundDocumentChunk({
        documentMap: retained.document_map,
        chunkId: input.chunk_id,
        sourceBytes: fresh.sourceBytes,
        schemaBytes: retained.schema_bytes,
        layouts: fresh.layouts,
      });
    }

    requiredString(input.proposal_generation_sha256, "proposal_generation_sha256", SHA256);
    requiredString(input.proposal_event_id, "proposal_event_id", EVENT_ID);
    assertion(Array.isArray(input.citations), "citations must be an array.");
    assertion(input.method && typeof input.method === "object" && !Array.isArray(input.method),
      "method must be an object.");
    const result = await verifyWorkspaceExtractionProposal({
      rootPath: workspaceRoot,
      workspaceId,
      expectedWorkspaceIdentitySha256: identitySha256,
      expectedGenerationSha256: input.proposal_generation_sha256,
      workspaceIdentity: retained.workspace_identity,
      proposalEventId: input.proposal_event_id,
      documentMap: retained.document_map,
      sourceBytes: fresh.sourceBytes,
      schemaBytes: retained.schema_bytes,
      layouts: fresh.layouts,
      citations: input.citations,
      method: input.method,
    });
    return appendVerifiedWorkspaceResult({
      rootPath: workspaceRoot,
      workspaceId,
      expectedWorkspaceIdentitySha256: identitySha256,
      expectedParentGenerationSha256: input.proposal_generation_sha256,
      verificationResult: result,
      transactionId: transactionId(),
    });
  };
}
