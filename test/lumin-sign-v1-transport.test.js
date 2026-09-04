import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LUMIN_SIGN_V1_MAPPER_CONTRACT_SHA256,
  mapLuminSignV1SignatureRequest,
} from "../server/lumin-sign-v1-mapper.js";
import {
  executeAuthorizedLuminSignV1DirectUpload,
  LUMIN_SIGN_V1_DIRECT_UPLOAD_CONFIRMATION,
  LUMIN_SIGN_V1_DIRECT_UPLOAD_REFERENCE,
} from "../server/lumin-sign-v1-transport.js";

const NOW_MS = Date.parse("2030-01-01T00:00:30.000Z");
const PDF_BYTES = Buffer.from("%PDF-1.7\n%%EOF\n", "ascii");
const PDF_SHA256 = createHash("sha256").update(PDF_BYTES).digest("hex");
const ACCESS_TOKEN = "test-access-token-never-returned";

function canonicalJson(value) {
  if (Array.isArray(value)) {
    const items = [];
    for (let index = 0; index < value.length; index += 1) items.push(canonicalJson(value[index]));
    return `[${items.join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function preparationReceipt() {
  const receipt = {
    schema_version: "1.0",
    preparation_engine: "pdf-tools.prepare-signing-packet.v1",
    source_document: {
      canonical_path: "/synthetic/source.pdf",
      size_bytes: PDF_BYTES.length,
      sha256: PDF_SHA256,
      identity_method: "race_aware_descriptor_sha256",
    },
    prepared_document: {
      canonical_path: "/synthetic/prepared.pdf",
      size_bytes: PDF_BYTES.length,
      sha256: PDF_SHA256,
      identity_method: "race_aware_descriptor_sha256",
    },
    source_preservation: {
      mode: "source_path_unchanged",
      source_path_reverified_after_commit: true,
      backup_identity_verified_after_commit: false,
      backup_path: null,
      backup_document: null,
    },
    output_commit: {
      status: "committed",
      protocol: "pdf-tools.atomic-output-transaction.v1",
      target_mode: "new_path",
      source_binding_verified_at_commit: true,
      prepared_identity_verified_after_commit: true,
      replacement_identity_supplied: false,
    },
    page_count: 1,
    geometry_policy: {
      native_coordinate_space: "pdf-tools.media-box-top-left-points.v1",
      display_coordinate_space: "pdf-tools.crop-box-rotated-top-left-points.v1",
      page_box_basis: "MediaBox",
      crop_box_observed: true,
      rotation_policy: "clockwise_quarter_turns",
    },
    pages: [{ page: 1 }],
    field_outcomes: [],
    zones: [{
      zone_id: "signature.client",
      label: "Client signature",
      field_type: "signature",
      page: 1,
      native_region: { x: 10, y: 20, width: 100, height: 30 },
      display_region: { x: 10, y: 20, width: 100, height: 30 },
      visibility_status: "visible",
      coordinate_space_version: "pdf-tools.media-box-top-left-points.v1",
      evidence_source: "caller_supplied",
      evidence_binding_status: "caller_declared",
      participant_binding: {
        status: "bound",
        participant_id: "signer.client",
        participant_role: "signer",
      },
    }],
    existing_signature_observation: {
      present: false,
      field_count: 0,
      field_names: [],
      allow_resign: false,
    },
    xfa_observation: {
      present: false,
      force_xfa: false,
      stripping_authorized: false,
    },
    handoff_status: "ready_for_provider_mapping",
    missing_inputs: [],
    limitations: ["synthetic fixture"],
    provider_execution_status: "not_requested",
  };
  return {
    ...receipt,
    receipt_sha256: createHash("sha256")
      .update(`pdf-tools.signing-preparation-receipt.v1\0${canonicalJson(receipt)}`)
      .digest("hex"),
  };
}

function mapping() {
  return mapLuminSignV1SignatureRequest({
    schema_version: 1,
    prepared_document: {
      sha256: PDF_SHA256,
      size_bytes: PDF_BYTES.length,
      transfer: { kind: "direct_file" },
    },
    field_mapping: {
      method: "lumin_text_tags",
      evidence_status: "caller_asserted",
    },
    title: "Synthetic signing test",
    expires_at_ms: NOW_MS + 86_400_000,
    signing_type: "SAME_TIME",
    signers: [{
      participant_id: "signer.client",
      email_address: "client@example.com",
      name: "Client Signer",
    }],
    viewers: [{
      participant_id: "viewer.audit",
      email_address: "audit@example.com",
      name: "Audit Viewer",
    }],
  }, { nowMs: NOW_MS });
}

function authority(receipt = preparationReceipt(), mapped = mapping()) {
  const participantIds = Array.from(
    { length: mapped.bindings.participant_ids.length },
    (_, index) => mapped.bindings.participant_ids[index],
  );
  return {
    schema_version: 1,
    provider: "lumin_sign",
    action: "create_signature_request",
    transport: "direct_pdf_multipart",
    confirmation: LUMIN_SIGN_V1_DIRECT_UPLOAD_CONFIRMATION,
    approved_at: "2030-01-01T00:00:00.000Z",
    expires_at: "2030-01-01T00:05:00.000Z",
    preparation_receipt_sha256: receipt.receipt_sha256,
    mapper_contract_sha256: LUMIN_SIGN_V1_MAPPER_CONTRACT_SHA256,
    request_mapping_sha256: createHash("sha256")
      .update(`pdf-tools.lumin-sign-v1-request-mapping.v1\0${canonicalJson(mapped)}`)
      .digest("hex"),
    prepared_document_sha256: PDF_SHA256,
    participant_ids: participantIds,
    automatic_retry_allowed: false,
  };
}

function input() {
  const receipt = preparationReceipt();
  const mapped = structuredClone(mapping());
  return {
    access_token: ACCESS_TOKEN,
    execution_authority: authority(receipt, mapped),
    mapping: mapped,
    preparation_receipt: receipt,
    prepared_pdf_bytes: Buffer.from(PDF_BYTES),
  };
}

function successResponse(overrides = {}) {
  return new Response(JSON.stringify({
    signature_request: {
      signature_request_id: "sigreq.synthetic-123",
      status: "WAITING_FOR_PROCESSING",
      created_at: 1_893_456_030,
      ...overrides,
    },
  }), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
}

async function execute(value, fetchImpl) {
  return executeAuthorizedLuminSignV1DirectUpload(value, {
    fetchImpl,
    nowMs: NOW_MS,
    timeoutMs: 5_000,
  });
}

describe("executeAuthorizedLuminSignV1DirectUpload", () => {
  it("pins the exact official direct-upload example used by the transport contract", () => {
    expect(LUMIN_SIGN_V1_DIRECT_UPLOAD_REFERENCE).toEqual({
      repository: "https://github.com/luminpdf/lumin-sign-api-docs",
      commit: "cd8ddd73e32c016038691dad21d0e4594c8eeebb",
      path: "src/theme/ApiDemoPanel/signature-request.multipart.js",
      bytes: 7_288,
      sha256: "8b82481c0c06bd560e1e107c08ed90b31640d9bd4cd3941635bbf4d328c814c4",
    });
  });
  it("sends one exact direct-file request and returns a token-free identity receipt", async () => {
    let calls = 0;
    const result = await execute(input(), async (url, options) => {
      calls += 1;
      expect(url).toBe("https://api.luminpdf.com/v1/signature_request/send");
      expect(options).toMatchObject({ method: "POST", redirect: "error" });
      expect(options.headers).toEqual({
        accept: "application/json",
        authorization: `Bearer ${ACCESS_TOKEN}`,
      });
      expect(options.headers).not.toHaveProperty("content-type");
      expect(options.body).toBeInstanceOf(FormData);
      expect([...options.body.keys()]).toEqual([
        "file",
        "title",
        "expires_at",
        "signers[0][email_address]",
        "signers[0][name]",
        "viewers[0][email_address]",
        "viewers[0][name]",
        "use_text_tags",
        "signing_type",
      ]);
      const file = options.body.get("file");
      expect(file).toBeInstanceOf(Blob);
      expect(file.name).toBe("prepared-document.pdf");
      expect(file.type).toBe("application/pdf");
      expect(Buffer.from(await file.arrayBuffer())).toEqual(PDF_BYTES);
      expect(options.body.get("title")).toBe("Synthetic signing test");
      expect(options.body.get("signers[0][email_address]")).toBe("client@example.com");
      expect(options.body.get("use_text_tags")).toBe("true");
      return successResponse();
    });

    expect(calls).toBe(1);
    expect(result).toMatchObject({
      schema_version: 1,
      provider: "lumin_sign",
      provider_execution_status: "request_created",
      attempt_count: 1,
      automatic_retry_performed: false,
      request: {
        prepared_document_sha256: PDF_SHA256,
        prepared_document_size_bytes: PDF_BYTES.length,
        participant_ids: ["signer.client", "viewer.audit"],
        direct_upload_reference: LUMIN_SIGN_V1_DIRECT_UPLOAD_REFERENCE,
        request_mapping_sha256: createHash("sha256")
          .update(`pdf-tools.lumin-sign-v1-request-mapping.v1\0${canonicalJson(mapping())}`)
          .digest("hex"),
      },
      response: {
        status_code: 201,
        signature_request_id: "sigreq.synthetic-123",
        status: "WAITING_FOR_PROCESSING",
      },
      transport_receipt_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(result)).not.toContain("client@example.com");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.getPrototypeOf(result)).toBeNull();
  });

  it.each([
    ["prepared bytes", value => { value.prepared_pdf_bytes = Buffer.from("%PDF-drift"); }],
    ["receipt digest", value => { value.preparation_receipt.receipt_sha256 = "f".repeat(64); }],
    ["prepared binding", value => { value.mapping.bindings.prepared_document_sha256 = "f".repeat(64); }],
    ["mapper contract", value => {
      value.mapping.mapper_contract_sha256 = "f".repeat(64);
      value.execution_authority.mapper_contract_sha256 = "f".repeat(64);
    }],
    ["malformed signer", value => { value.mapping.request.body.signers[0].email_address = "not-an-email"; }],
    ["signer binding", value => { value.preparation_receipt.zones[0].participant_binding.participant_id = "signer.other"; }],
    ["authority confirmation", value => { value.execution_authority.confirmation = "yes"; }],
    ["authority participant", value => { value.execution_authority.participant_ids[0] = "signer.other"; }],
    ["authority request mapping", value => { value.mapping.request.body.title = "Unapproved title"; }],
    ["expired authority", value => { value.execution_authority.expires_at = "2030-01-01T00:00:20.000Z"; }],
    ["retry authority", value => { value.execution_authority.automatic_retry_allowed = true; }],
    ["token whitespace", value => { value.access_token = ` ${ACCESS_TOKEN}`; }],
    ["extra key", value => { value.client_secret = "must-not-be-consumed"; }],
  ])("rejects %s before transport", async (_label, mutate) => {
    const value = input();
    mutate(value);
    let calls = 0;
    await expect(execute(value, async () => {
      calls += 1;
      return successResponse();
    })).rejects.toMatchObject({
      code: "LUMIN_TRANSPORT_INPUT_INVALID",
      message: "LUMIN_TRANSPORT_INPUT_INVALID: The Lumin signing request failed local validation before any provider call.",
    });
    expect(calls).toBe(0);
  });

  it("requires an injected transport and never defaults to live fetch", async () => {
    await expect(executeAuthorizedLuminSignV1DirectUpload(input())).rejects.toMatchObject({
      code: "LUMIN_TRANSPORT_INPUT_INVALID",
    });
  });

  it("accepts RFC bearer padding without exposing the access token", async () => {
    const value = input();
    value.access_token = "synthetic-token==";
    const result = await execute(value, async () => successResponse());
    expect(JSON.stringify(result)).not.toContain(value.access_token);
  });

  it("keeps the timeout active while reading the provider response body", async () => {
    let calls = 0;
    await expect(executeAuthorizedLuminSignV1DirectUpload(input(), {
      nowMs: NOW_MS,
      timeoutMs: 5,
      fetchImpl: async (_url, options) => {
        calls += 1;
        const body = new ReadableStream({
          start(controller) {
            options.signal.addEventListener("abort", () => controller.error(new Error("aborted")));
          },
        });
        return new Response(body, {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    })).rejects.toMatchObject({ code: "LUMIN_CREATE_OUTCOME_UNKNOWN" });
    expect(calls).toBe(1);
  });

  it("preserves an ambiguous one-attempt outcome without retrying or leaking causes", async () => {
    let calls = 0;
    const sentinel = "provider-secret-sentinel";
    await expect(execute(input(), async () => {
      calls += 1;
      throw new Error(sentinel);
    })).rejects.toMatchObject({
      code: "LUMIN_CREATE_OUTCOME_UNKNOWN",
      message: "LUMIN_CREATE_OUTCOME_UNKNOWN: The Lumin request outcome is unknown. It was not retried automatically.",
    });
    expect(calls).toBe(1);
  });

  it.each([
    ["wrong status", () => new Response(JSON.stringify({ error: "no" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }), "LUMIN_CREATE_REJECTED"],
    ["wrong media", () => new Response("no", {
      status: 201,
      headers: { "content-type": "text/plain" },
    }), "LUMIN_CREATE_OUTCOME_UNKNOWN"],
    ["invalid JSON", () => new Response("{", {
      status: 201,
      headers: { "content-type": "application/json" },
    }), "LUMIN_CREATE_OUTCOME_UNKNOWN"],
    ["extra response key", () => new Response(JSON.stringify({
      signature_request: {
        signature_request_id: "sigreq.synthetic-123",
        status: "WAITING_FOR_PROCESSING",
        created_at: 1_893_456_030,
        access_token: "secret",
      },
    }), {
      status: 201,
      headers: { "content-type": "application/json" },
    }), "LUMIN_CREATE_OUTCOME_UNKNOWN"],
    ["oversized declaration", () => new Response("{}", {
      status: 201,
      headers: {
        "content-type": "application/json",
        "content-length": String(256 * 1024 + 1),
      },
    }), "LUMIN_CREATE_OUTCOME_UNKNOWN"],
  ])("fails closed on %s", async (_label, response, code) => {
    let calls = 0;
    await expect(execute(input(), async () => {
      calls += 1;
      return response();
    })).rejects.toMatchObject({ code });
    expect(calls).toBe(1);
  });

  it("keeps the source and share transport bytes identical", async () => {
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const [source, share] = await Promise.all([
      fs.readFile(path.join(repoRoot, "server/lumin-sign-v1-transport.js")),
      fs.readFile(path.join(repoRoot, "pdf-toolkit-mcp-share/server/lumin-sign-v1-transport.js")),
    ]);
    expect(share.equals(source)).toBe(true);
  });

  it("keeps the provider transport internal and absent from both MCP entry points", async () => {
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const [sourceIndex, shareIndex] = await Promise.all([
      fs.readFile(path.join(repoRoot, "server/index.js"), "utf8"),
      fs.readFile(path.join(repoRoot, "pdf-toolkit-mcp-share/server/index.js"), "utf8"),
    ]);
    expect(sourceIndex).not.toContain("lumin-sign-v1-transport");
    expect(sourceIndex).not.toContain("executeAuthorizedLuminSignV1DirectUpload");
    expect(shareIndex).not.toContain("lumin-sign-v1-transport");
    expect(shareIndex).not.toContain("executeAuthorizedLuminSignV1DirectUpload");
  });
});
