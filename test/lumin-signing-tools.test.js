import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  LUMIN_SIGNING_DISCLOSURE,
  LUMIN_SIGNING_TOOL_DEFINITIONS,
  createLuminSigningToolHandler,
} from "../server/lumin-signing-tools.js";
import { validateStructuredToolResult } from "../server/output-schemas.js";
import { LUMIN_SIGN_V1_DIRECT_UPLOAD_CONFIRMATION } from "../server/lumin-sign-v1-transport.js";

const NOW_MS = Date.parse("2030-01-01T00:00:30.000Z");
const PDF_BYTES = Buffer.from("%PDF-1.7\n%%EOF\n", "ascii");
const PDF_SHA256 = createHash("sha256").update(PDF_BYTES).digest("hex");
const PDF_PATH = "/synthetic/prepared.pdf";
const STATE_ROOT = "/synthetic/private-state";
const ACCESS_TOKEN = "access-token-that-must-never-escape";
const SIGNED_URL = "https://download.example/agreement.pdf?secret=must-never-escape";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
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
      canonical_path: PDF_PATH,
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

function prepareInput(overrides = {}) {
  return {
    pdf_path: PDF_PATH,
    preparation_receipt: preparationReceipt(),
    title: "Synthetic signing request",
    expires_at: "2030-01-02T00:00:00.000Z",
    signers: [{
      participant_id: "signer.client",
      name: "Client Signer",
      email_address: "client@example.com",
    }],
    viewers: [{
      participant_id: "viewer.audit",
      name: "Audit Viewer",
      email_address: "audit@example.com",
    }],
    ...overrides,
  };
}

function workflow(overrides = {}) {
  const ids = ["authorization.session", "preparation.request"];
  const createOAuthSession = vi.fn(async () => ({
    authorizationUrl: "https://auth.luminpdf.com/oauth2/auth?opaque=one",
    waitForCallback: vi.fn(async () => ({ code: "one-time", redirectUri: "http://127.0.0.1:12345/callback" })),
    exchangeToken: vi.fn(async () => ({
      accessToken: ACCESS_TOKEN,
      refreshToken: "refresh-token-that-must-never-escape",
      expiresIn: 3600,
      scope: "openid profile.read sign:requests sign:requests.read",
      tokenType: "Bearer",
    })),
    close: vi.fn(async () => {}),
  }));
  const dependencies = {
    clientId: "public-client-id",
    stateRoot: STATE_ROOT,
    readPreparedPdf: vi.fn(async () => ({ canonicalPath: PDF_PATH, bytes: Buffer.from(PDF_BYTES) })),
    resolveOutputPath: vi.fn(value => value),
    downloadSignedPdf: vi.fn(async ({ outputPath }) => ({
      canonicalPath: outputPath,
      bytes: PDF_BYTES.length,
      sha256: PDF_SHA256,
    })),
    createOAuthSession,
    openExternal: vi.fn(async () => {}),
    executeCreate: vi.fn(async input => ({
      result: {
        response: {
          signature_request_id: "sigreq.synthetic-123",
          status: "WAITING_FOR_PROCESSING",
          created_at: 1_893_456_030,
        },
      },
      operation: { operation_status: "request_created" },
      receivedToken: input.access_token,
    })),
    pollStatus: vi.fn(async () => ({
      authority_sha256: "a".repeat(64),
      signature_request_id: "sigreq.synthetic-123",
      status: "APPROVED",
      observed_at: new Date(NOW_MS).toISOString(),
      observation_sha256: "b".repeat(64),
    })),
    requestArtifact: vi.fn(async () => ({
      file_type: "agreement",
      signed_url: SIGNED_URL,
      expires_at: Math.floor(NOW_MS / 1000) + 600,
      observation: { observation_sha256: "c".repeat(64) },
    })),
    fetchImpl: vi.fn(),
    now: () => NOW_MS,
    idFactory: () => ids.shift(),
    ...overrides,
  };
  return { dependencies, handle: createLuminSigningToolHandler(dependencies) };
}

async function connect(handle) {
  const started = await handle("start_lumin_authorization", {});
  const connected = await handle("finish_lumin_authorization", {
    authorization_session_id: started.authorization_session_id,
  });
  return connected.authorization_session_id;
}

function expectValidStructuredOutput(toolName, structuredContent) {
  const result = {
    content: [{ type: "text", text: `${toolName} completed` }],
    structuredContent,
  };
  expect(validateStructuredToolResult(toolName, result)).toBe(result);
}

describe("public Lumin signing workflow", () => {
  it("exposes a complete, explicitly annotated public workflow", () => {
    expect(LUMIN_SIGNING_TOOL_DEFINITIONS.map(tool => tool.name)).toEqual([
      "start_lumin_authorization",
      "finish_lumin_authorization",
      "prepare_lumin_request",
      "send_lumin_request",
      "check_lumin_status",
      "download_lumin_artifact",
    ]);
    expect(LUMIN_SIGNING_TOOL_DEFINITIONS.find(tool => tool.name === "send_lumin_request")?.annotations)
      .toEqual({
        title: "Send Lumin Signing Request",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      });
  });

  it("starts and completes PKCE without returning or persisting credentials", async () => {
    const { dependencies, handle } = workflow();
    const started = await handle("start_lumin_authorization", {});
    expect(dependencies.createOAuthSession).toHaveBeenCalledWith({
      clientId: "public-client-id",
      scopes: ["openid", "profile.read", "sign:requests", "sign:requests.read"],
      timeoutMs: 300_000,
    });
    expect(dependencies.openExternal).toHaveBeenCalledWith("https://auth.luminpdf.com/oauth2/auth?opaque=one");
    expect(JSON.stringify(started)).not.toContain("auth.luminpdf.com");
    expectValidStructuredOutput("start_lumin_authorization", started);
    const completed = await handle("finish_lumin_authorization", {
      authorization_session_id: started.authorization_session_id,
    });
    expect(completed).toMatchObject({
      status: "connected",
      authorization_session_id: "authorization.session",
      access_token_persisted: false,
      refresh_token_persisted: false,
      pdf_sent: false,
    });
    expect(JSON.stringify(completed)).not.toContain("token-that-must-never-escape");
    expectValidStructuredOutput("finish_lumin_authorization", completed);
  });

  it("refuses an unconfigured client before creating a callback or opening a browser", async () => {
    const { dependencies, handle } = workflow({ clientId: null });
    await expect(handle("start_lumin_authorization", {})).rejects.toMatchObject({
      code: "LUMIN_OAUTH_NOT_CONFIGURED",
    });
    expect(dependencies.createOAuthSession).not.toHaveBeenCalled();
    expect(dependencies.openExternal).not.toHaveBeenCalled();
  });

  it("sanitizes authorization startup failures", async () => {
    const { handle } = workflow({
      createOAuthSession: vi.fn(async () => {
        const error = new Error(`callback failed with ${ACCESS_TOKEN}`);
        error.code = "LUMIN_OAUTH_CALLBACK_UNAVAILABLE";
        throw error;
      }),
    });
    const attempt = handle("start_lumin_authorization", {});
    await expect(attempt).rejects.toMatchObject({ code: "LUMIN_OAUTH_CALLBACK_UNAVAILABLE" });
    await expect(attempt).rejects.not.toThrow(ACCESS_TOKEN);
  });

  it("prepares locally and binds the exact PDF, receipt, recipients, disclosure, and confirmation", async () => {
    const { dependencies, handle } = workflow();
    const prepared = await handle("prepare_lumin_request", prepareInput());
    expect(prepared).toMatchObject({
      status: "ready_for_user_confirmation",
      request_preparation_id: "authorization.session",
      disclosure: LUMIN_SIGNING_DISCLOSURE,
      confirmation_statement_required: LUMIN_SIGN_V1_DIRECT_UPLOAD_CONFIRMATION,
      prepared_document: { canonical_path: PDF_PATH, sha256: PDF_SHA256 },
      provider_contacted: false,
      pdf_sent: false,
    });
    expect(prepared.signers).toEqual(prepareInput().signers);
    expect(dependencies.executeCreate).not.toHaveBeenCalled();
    expect(dependencies.fetchImpl).not.toHaveBeenCalled();
    expectValidStructuredOutput("prepare_lumin_request", prepared);
  });

  it("rejects a changed PDF or receipt before preparing a send", async () => {
    const changed = workflow({
      readPreparedPdf: vi.fn(async () => ({ canonicalPath: PDF_PATH, bytes: Buffer.from("%PDF-changed", "ascii") })),
    });
    await expect(changed.handle("prepare_lumin_request", prepareInput())).rejects.toMatchObject({
      code: "LUMIN_PREPARED_PDF_CHANGED",
    });

    const drifted = preparationReceipt();
    drifted.handoff_status = "needs_input";
    const { handle } = workflow();
    await expect(handle("prepare_lumin_request", prepareInput({ preparation_receipt: drifted })))
      .rejects.toMatchObject({ code: "LUMIN_PREPARATION_NOT_READY" });
  });

  it("requires an exact fresh user confirmation before the sole create attempt", async () => {
    const { dependencies, handle } = workflow();
    const authorizationId = await connect(handle);
    const prepared = await handle("prepare_lumin_request", prepareInput());
    const input = {
      request_preparation_id: prepared.request_preparation_id,
      authorization_session_id: authorizationId,
      confirmation_sha256: prepared.confirmation_sha256,
      confirmation_statement: LUMIN_SIGN_V1_DIRECT_UPLOAD_CONFIRMATION,
      user_confirmed_at: new Date(NOW_MS).toISOString(),
    };
    await expect(handle("send_lumin_request", {
      ...input,
      confirmation_statement: "Yes, send it",
    })).rejects.toMatchObject({ code: "LUMIN_USER_CONFIRMATION_INVALID" });
    expect(dependencies.executeCreate).not.toHaveBeenCalled();

    const result = await handle("send_lumin_request", input);
    expect(result).toMatchObject({
      status: "request_created",
      signature_request_id: "sigreq.synthetic-123",
      attempt_count: 1,
      automatic_retry_performed: false,
      create_retry_allowed: false,
      access_token_persisted: false,
    });
    expect(result.authority_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(dependencies.executeCreate).toHaveBeenCalledTimes(1);
    const [createInput, createOptions] = dependencies.executeCreate.mock.calls[0];
    expect(createInput.access_token).toBe(ACCESS_TOKEN);
    expect(createInput.execution_authority).toMatchObject({
      confirmation: LUMIN_SIGN_V1_DIRECT_UPLOAD_CONFIRMATION,
      automatic_retry_allowed: false,
    });
    expect(createOptions).toMatchObject({ stateRoot: STATE_ROOT, nowMs: NOW_MS });
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
    expectValidStructuredOutput("send_lumin_request", result);
  });

  it("rejects stale confirmation without touching the provider", async () => {
    const { dependencies, handle } = workflow();
    const authorizationId = await connect(handle);
    const prepared = await handle("prepare_lumin_request", prepareInput());
    await expect(handle("send_lumin_request", {
      request_preparation_id: prepared.request_preparation_id,
      authorization_session_id: authorizationId,
      confirmation_sha256: prepared.confirmation_sha256,
      confirmation_statement: LUMIN_SIGN_V1_DIRECT_UPLOAD_CONFIRMATION,
      user_confirmed_at: new Date(NOW_MS - 600_000).toISOString(),
    })).rejects.toMatchObject({ code: "LUMIN_USER_CONFIRMATION_EXPIRED" });
    expect(dependencies.executeCreate).not.toHaveBeenCalled();
  });

  it("consumes the confirmation before an ambiguous create failure", async () => {
    const { dependencies, handle } = workflow({
      executeCreate: vi.fn(async () => {
        const error = new Error(`LUMIN_CREATE_OUTCOME_UNKNOWN: ${ACCESS_TOKEN}`);
        error.code = "LUMIN_CREATE_OUTCOME_UNKNOWN";
        throw error;
      }),
    });
    const authorizationId = await connect(handle);
    const prepared = await handle("prepare_lumin_request", prepareInput());
    const input = {
      request_preparation_id: prepared.request_preparation_id,
      authorization_session_id: authorizationId,
      confirmation_sha256: prepared.confirmation_sha256,
      confirmation_statement: LUMIN_SIGN_V1_DIRECT_UPLOAD_CONFIRMATION,
      user_confirmed_at: new Date(NOW_MS).toISOString(),
    };
    const firstAttempt = handle("send_lumin_request", input);
    await expect(firstAttempt).rejects.toMatchObject({ code: "LUMIN_CREATE_OUTCOME_UNKNOWN" });
    await expect(firstAttempt).rejects.not.toThrow(ACCESS_TOKEN);
    await expect(handle("send_lumin_request", input)).rejects.toMatchObject({
      code: "LUMIN_REQUEST_PREPARATION_EXPIRED",
    });
    expect(dependencies.executeCreate).toHaveBeenCalledTimes(1);
  });

  it("polls an existing request without exposing the token or authorizing create retry", async () => {
    const { dependencies, handle } = workflow();
    const authorizationId = await connect(handle);
    const result = await handle("check_lumin_status", {
      authority_sha256: "a".repeat(64),
      authorization_session_id: authorizationId,
    });
    expect(result).toMatchObject({
      status: "observed",
      provider_status: "APPROVED",
      read_retry_safe: true,
      create_retry_allowed: false,
      access_token_persisted: false,
    });
    expect(dependencies.pollStatus).toHaveBeenCalledWith({
      access_token: ACCESS_TOKEN,
      authority_sha256: "a".repeat(64),
      state_root: STATE_ROOT,
    }, expect.objectContaining({ nowMs: NOW_MS }));
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
    expectValidStructuredOutput("check_lumin_status", result);
  });

  it("consumes a signed artifact URL internally and returns only a local PDF identity", async () => {
    const { dependencies, handle } = workflow();
    const authorizationId = await connect(handle);
    const result = await handle("download_lumin_artifact", {
      authority_sha256: "a".repeat(64),
      authorization_session_id: authorizationId,
      file_type: "agreement",
      output_path: "/synthetic/downloads/agreement.pdf",
    });
    expect(dependencies.downloadSignedPdf).toHaveBeenCalledWith({
      signedUrl: SIGNED_URL,
      outputPath: "/synthetic/downloads/agreement.pdf",
    });
    expect(result).toMatchObject({
      status: "downloaded",
      pdf_path: "/synthetic/downloads/agreement.pdf",
      sha256: PDF_SHA256,
      access_url_persisted: false,
      access_url_returned: false,
      access_token_persisted: false,
      create_retry_allowed: false,
    });
    expect(JSON.stringify(result)).not.toContain("must-never-escape");
    expectValidStructuredOutput("download_lumin_artifact", result);
  });

  it("sanitizes signed URL failures", async () => {
    const { handle } = workflow({
      downloadSignedPdf: vi.fn(async ({ signedUrl }) => {
        throw new Error(`failed ${signedUrl}`);
      }),
    });
    const authorizationId = await connect(handle);
    await expect(handle("download_lumin_artifact", {
      authority_sha256: "a".repeat(64),
      authorization_session_id: authorizationId,
      file_type: "agreement",
      output_path: "/synthetic/downloads/agreement.pdf",
    })).rejects.toMatchObject({
      code: "LUMIN_ARTIFACT_DOWNLOAD_FAILED",
      message: expect.not.stringContaining("must-never-escape"),
    });
  });

  it("sanitizes a URL-bearing Lumin artifact error while preserving its code", async () => {
    const { handle } = workflow({
      requestArtifact: vi.fn(async () => {
        const error = new Error(`LUMIN_ARTIFACT_OBSERVATION_RETRYABLE: ${SIGNED_URL}`);
        error.code = "LUMIN_ARTIFACT_OBSERVATION_RETRYABLE";
        throw error;
      }),
    });
    const authorizationId = await connect(handle);
    const attempt = handle("download_lumin_artifact", {
      authority_sha256: "a".repeat(64),
      authorization_session_id: authorizationId,
      file_type: "agreement",
      output_path: "/synthetic/downloads/agreement.pdf",
    });
    await expect(attempt).rejects.toMatchObject({ code: "LUMIN_ARTIFACT_OBSERVATION_RETRYABLE" });
    await expect(attempt).rejects.not.toThrow("must-never-escape");
  });
});
