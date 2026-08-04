import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LUMIN_SIGN_V1_MAPPER_CONTRACT_SHA256,
  mapLuminSignV1SignatureRequest,
} from "../server/lumin-sign-v1-mapper.js";

const NOW_MS = 1_800_000_000_000;

function validIntent() {
  return {
    schema_version: 1,
    prepared_document: {
      sha256: "a".repeat(64),
      size_bytes: 12_345,
      transfer: {
        kind: "https_url",
        url: "https://objects.example.com/prepared/document.pdf?grant=one-object",
      },
    },
    field_mapping: {
      method: "lumin_text_tags",
      evidence_status: "caller_asserted",
    },
    title: "Consulting agreement",
    expires_at_ms: NOW_MS + 86_400_000,
    signing_type: "ORDER",
    signers: [
      {
        participant_id: "signer.client",
        email_address: "client@example.com",
        name: "Client Signer",
        group: 1,
      },
      {
        participant_id: "signer.consultant",
        email_address: "consultant@example.com",
        name: "Consultant Signer",
        group: 2,
      },
    ],
    viewers: [
      {
        participant_id: "viewer.counsel",
        email_address: "counsel@example.com",
        name: "Review Counsel",
      },
    ],
  };
}

function map(intent = validIntent()) {
  return mapLuminSignV1SignatureRequest(intent, { nowMs: NOW_MS });
}

function expectInvalid(intent, sentinels = []) {
  try {
    map(intent);
    throw new Error("expected mapper to reject intent");
  } catch (error) {
    expect(error).toMatchObject({
      code: "LUMIN_MAPPING_INVALID",
      message: "LUMIN_MAPPING_INVALID: The Lumin Sign request intent failed local validation.",
    });
    for (const sentinel of sentinels) expect(error.message).not.toContain(sentinel);
  }
}

describe("mapLuminSignV1SignatureRequest", () => {
  it("maps a provisional ordered text-tag request without claiming provider verification, auth, or transport", () => {
    const result = map();
    expect(result).toEqual({
      schema_version: 1,
      provider: "lumin_sign",
      api_version: "v1",
      mapper_contract_sha256: LUMIN_SIGN_V1_MAPPER_CONTRACT_SHA256,
      request_mapping_status: "provisional_unverified",
      official_reference_identity_status: "not_established",
      transport_allowed: false,
      transport_status: "not_requested",
      provider_execution_status: "not_requested",
      field_mapping_status: "caller_asserted_not_independently_verified",
      idempotency_status: "not_established",
      automatic_retry_allowed: false,
      request: {
        base_url: "https://api.luminpdf.com/v1",
        method: "POST",
        path: "/signature_request/send",
        content_type: "application/json",
        required_oauth_scope: "sign:requests",
        body: {
          file_url: "https://objects.example.com/prepared/document.pdf?grant=one-object",
          title: "Consulting agreement",
          signers: [
            { email_address: "client@example.com", name: "Client Signer", group: 1 },
            { email_address: "consultant@example.com", name: "Consultant Signer", group: 2 },
          ],
          expires_at: NOW_MS + 86_400_000,
          use_text_tags: true,
          signing_type: "ORDER",
          viewers: [
            { email_address: "counsel@example.com", name: "Review Counsel" },
          ],
        },
      },
      bindings: {
        prepared_document_sha256: "a".repeat(64),
        prepared_document_size_bytes: 12_345,
        participant_ids: ["signer.client", "signer.consultant", "viewer.counsel"],
      },
      limitations: [
        "credential_custody_not_established",
        "provider_environment_not_established",
        "provider_create_idempotency_not_established",
        "field_mapping_not_independently_verified",
        "official_openapi_identity_not_frozen",
        "provider_reference_fixture_not_frozen",
        "provider_signer_group_type_reference_inconsistent",
        "provider_expiry_horizon_not_established",
        "plan_specific_upload_limit_not_established",
        "transfer_url_destination_not_resolved",
        "transport_not_requested",
      ],
    });
    expect(result.request).not.toHaveProperty("headers");
    expect(result.request).not.toHaveProperty("authorization");
    expect(result.request.body).not.toHaveProperty("api_key");
  });

  it("maps same-time signing only when no ordering groups are supplied", () => {
    const intent = validIntent();
    intent.signing_type = "SAME_TIME";
    intent.signers = intent.signers.map(({ group: _group, ...signer }) => signer);
    const result = map(intent);
    expect(result.request.body.signing_type).toBe("SAME_TIME");
    expect(result.request.body.signers.every(signer => signer.group === undefined)).toBe(true);
  });

  it("refuses visual placeholders or any unsupported field-mapping evidence status", () => {
    const intent = validIntent();
    intent.field_mapping = { method: "pdf_tools_visual_placeholders", evidence_status: "caller_asserted" };
    expectInvalid(intent);
    intent.field_mapping = { method: "lumin_text_tags", evidence_status: "independently_verified" };
    expectInvalid(intent);
  });

  it("requires contiguous ordered groups starting at one", () => {
    const intent = validIntent();
    intent.signers[1].group = 3;
    expectInvalid(intent);
    intent.signers[0].group = 0;
    expectInvalid(intent);
  });

  it("refuses unknown fields, credential-shaped additions, and unsupported verification", () => {
    const rootSecret = "secret-root-token";
    const intent = { ...validIntent(), api_key: rootSecret };
    expectInvalid(intent, [rootSecret]);
    const signerSecret = "secret-verification-payload";
    const signerIntent = validIntent();
    signerIntent.signers[0].verification = { method: signerSecret };
    expectInvalid(signerIntent, [signerSecret]);

    const inheritedIntent = validIntent();
    Object.setPrototypeOf(inheritedIntent, { api_key: "inherited-secret" });
    expectInvalid(inheritedIntent, ["inherited-secret"]);

    const symbolicIntent = validIntent();
    symbolicIntent[Symbol("credential")] = "symbol-secret";
    expectInvalid(symbolicIntent, ["symbol-secret"]);

    const hiddenIntent = validIntent();
    Object.defineProperty(hiddenIntent, "api_key", { value: "hidden-secret", enumerable: false });
    expectInvalid(hiddenIntent, ["hidden-secret"]);
  });

  it("always maps caller-controlled exceptions to the fixed public error", () => {
    const sentinel = "SENTINEL_SECRET_FROM_PROXY";
    const intent = new Proxy(validIntent(), {
      get(target, key, receiver) {
        if (key === "schema_version") {
          const error = new Error(sentinel);
          error.code = "LUMIN_MAPPING_INVALID";
          throw error;
        }
        return Reflect.get(target, key, receiver);
      },
    });
    expectInvalid(intent, [sentinel]);

    const optionsSentinel = "SENTINEL_OPTIONS_SECRET";
    const options = new Proxy({}, {
      get(target, key, receiver) {
        if (key === "nowMs") throw new Error(optionsSentinel);
        return Reflect.get(target, key, receiver);
      },
    });
    try {
      mapLuminSignV1SignatureRequest(validIntent(), options);
      throw new Error("expected mapper to reject options");
    } catch (error) {
      expect(error).toMatchObject({
        code: "LUMIN_MAPPING_INVALID",
        message: "LUMIN_MAPPING_INVALID: The Lumin Sign request intent failed local validation.",
      });
      expect(error.message).not.toContain(optionsSentinel);
    }
  });

  it("refuses duplicate participant bindings", () => {
    const intent = validIntent();
    intent.viewers[0].participant_id = intent.signers[0].participant_id;
    expectInvalid(intent);
  });

  it("bounds the combined participant envelope", () => {
    const intent = validIntent();
    intent.signers = Array.from({ length: 100 }, (_value, index) => ({
      participant_id: `signer.${index}`,
      email_address: `signer.${index}@example.com`,
      name: `Signer ${index}`,
      group: 1,
    }));
    expectInvalid(intent);
  });

  it("rejects an oversized unknown-key envelope before sorting it", () => {
    const intent = validIntent();
    for (let index = 0; index < 1_000; index += 1) intent[`unknown_${index}`] = index;
    expectInvalid(intent);
  });

  it("refuses stale expiry and invalid prepared-document identity", () => {
    const stale = validIntent();
    stale.expires_at_ms = NOW_MS;
    expectInvalid(stale);
    const badHash = validIntent();
    badHash.prepared_document.sha256 = "A".repeat(64);
    expectInvalid(badHash);
    const oversized = validIntent();
    oversized.prepared_document.size_bytes = 200 * 1024 * 1024 + 1;
    expectInvalid(oversized);
  });

  it.each([
    "http://objects.example.com/document.pdf",
    "https://user:password@objects.example.com/document.pdf",
    "https://localhost/document.pdf",
    "https://127.0.0.1/document.pdf",
    "https://10.20.30.40/document.pdf",
    "https://[::1]/document.pdf",
    "https://printer.local/document.pdf",
    "https://service.internal/document.pdf",
    "https://localhost./document.pdf",
    "https://printer.local./document.pdf",
    "https://service.internal./document.pdf",
    "https://host.home.arpa./document.pdf",
    "https://localhost../document.pdf",
    "https://printer.local../document.pdf",
    "https://service.internal../document.pdf",
    "https://host.home.arpa../document.pdf",
    "https://bad_label.example.com/document.pdf",
    "https://intranet/document.pdf",
    "https://objects.example.com/document.pdf#secret",
  ])("refuses a non-public or credential-bearing transfer URL: %s", url => {
    const intent = validIntent();
    intent.prepared_document.transfer.url = url;
    expectInvalid(intent, [url]);
  });

  it("returns a deeply immutable handoff graph", () => {
    const result = map();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.request)).toBe(true);
    expect(Object.isFrozen(result.request.body)).toBe(true);
    expect(Object.isFrozen(result.request.body.signers)).toBe(true);
    expect(Object.isFrozen(result.request.body.signers[0])).toBe(true);
    expect(Object.isFrozen(result.bindings.participant_ids)).toBe(true);
    expect(() => { result.automatic_retry_allowed = true; }).toThrow(TypeError);
    expect(() => { result.request.body.file_url = "https://changed.example.com/document.pdf"; }).toThrow(TypeError);
    expect(result.automatic_retry_allowed).toBe(false);
    expect(result.request.body.file_url).toBe("https://objects.example.com/prepared/document.pdf?grant=one-object");
  });

  it("keeps the source and share mapper bytes identical", async () => {
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const [source, share] = await Promise.all([
      fs.readFile(path.join(repoRoot, "server/lumin-sign-v1-mapper.js")),
      fs.readFile(path.join(repoRoot, "pdf-toolkit-mcp-share/server/lumin-sign-v1-mapper.js")),
    ]);
    expect(share.equals(source)).toBe(true);
    expect(createHash("sha256").update(source).digest("hex")).toMatch(/^[a-f0-9]{64}$/);
  });
});
