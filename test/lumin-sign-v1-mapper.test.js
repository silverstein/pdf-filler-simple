import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LUMIN_SIGN_V1_MAPPER_CONTRACT_SHA256,
  mapLuminSignV1SignatureRequest,
} from "../server/lumin-sign-v1-mapper.js";
import {
  LUMIN_SIGN_V1_OPENAPI_PROJECTION_SHA256,
  LUMIN_SIGN_V1_OPENAPI_SOURCE,
} from "../scripts/verify-lumin-sign-v1-openapi.mjs";

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
    signing_type: "SAME_TIME",
    signers: [
      {
        participant_id: "signer.client",
        email_address: "client@example.com",
        name: "Client Signer",
      },
      {
        participant_id: "signer.consultant",
        email_address: "consultant@example.com",
        name: "Consultant Signer",
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

function expectIsolatedOutputGraph(value) {
  if (!value || typeof value !== "object") return;
  expect(Object.getPrototypeOf(value)).toBeNull();
  for (const key of Object.keys(value)) expectIsolatedOutputGraph(value[key]);
}

describe("mapLuminSignV1SignatureRequest", () => {
  it("maps a provisional same-time text-tag request bound to the exact OpenAPI snapshot without claiming provider execution, credentials, or transport", () => {
    const result = map();
    expect(result).toEqual({
      schema_version: 1,
      provider: "lumin_sign",
      provider_api_path_version: "v1",
      mapper_contract_sha256: LUMIN_SIGN_V1_MAPPER_CONTRACT_SHA256,
      request_mapping_status: "provisional_unverified",
      official_reference_identity_status: "exact_snapshot_pinned",
      official_reference: {
        source_url: LUMIN_SIGN_V1_OPENAPI_SOURCE.url,
        source_bytes: LUMIN_SIGN_V1_OPENAPI_SOURCE.bytes,
        source_sha256: LUMIN_SIGN_V1_OPENAPI_SOURCE.sha256,
        contract_projection_sha256: LUMIN_SIGN_V1_OPENAPI_PROJECTION_SHA256,
        openapi_document_version: "3.1.0",
        provider_info_version: "1.0.0",
        discrepancy_codes: ["SIGNER_GROUP_SCHEMA_EXAMPLE_TYPE_MISMATCH"],
        unmapped_official_request_options: [
          "custom_email",
          "file",
          "file_urls",
          "files",
          "signer_verification",
        ],
      },
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
        authentication_alternatives: [
          {
            scheme: "ApiKey",
            type: "apiKey",
            location: "header",
            name: "X-API-Key",
            required_scopes: [],
          },
          {
            scheme: "BearerAuth",
            type: "oauth2",
            flow: "authorizationCode",
            required_scopes: ["sign:requests"],
          },
        ],
        body: {
          file_url: "https://objects.example.com/prepared/document.pdf?grant=one-object",
          title: "Consulting agreement",
          signers: [
            { email_address: "client@example.com", name: "Client Signer" },
            { email_address: "consultant@example.com", name: "Consultant Signer" },
          ],
          expires_at: NOW_MS + 86_400_000,
          use_text_tags: true,
          signing_type: "SAME_TIME",
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
        "provider_signer_group_type_reference_inconsistent",
        "ordered_signing_blocked_pending_group_wire_type_resolution",
        "prepared_file_size_bound_is_local_safety_policy_not_provider_limit",
        "participant_bounds_are_local_safety_policy_not_provider_limits",
        "participant_field_constraints_are_local_narrowing",
        "provider_expiry_horizon_not_established",
        "plan_specific_upload_limit_not_established",
        "transfer_url_destination_not_resolved",
        "transport_not_requested",
      ],
    });
    expect(result.request).not.toHaveProperty("headers");
    expect(result.request).not.toHaveProperty("authorization");
    expect(result.request.body).not.toHaveProperty("api_key");
    expect(LUMIN_SIGN_V1_MAPPER_CONTRACT_SHA256).toBe(
      "1c4c9ccff8f17e7317f280101cfa7a3df0850698edf8e8fdd57d376bf052657e",
    );
  });

  it("fails closed on ordered signing or any signer group until the official type conflict is resolved", () => {
    const ordered = validIntent();
    ordered.signing_type = "ORDER";
    ordered.signers[0].group = 1;
    expectInvalid(ordered);

    const groupedSameTime = validIntent();
    groupedSameTime.signers[0].group = "1";
    expectInvalid(groupedSameTime);
  });

  it("refuses visual placeholders or any unsupported field-mapping evidence status", () => {
    const intent = validIntent();
    intent.field_mapping = { method: "pdf_tools_visual_placeholders", evidence_status: "caller_asserted" };
    expectInvalid(intent);
    intent.field_mapping = { method: "lumin_text_tags", evidence_status: "independently_verified" };
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

    const deceptiveTarget = { ...validIntent(), api_key: "proxy-hidden-secret" };
    const deceptiveIntent = new Proxy(deceptiveTarget, {
      ownKeys(target) {
        return Reflect.ownKeys(target).filter(key => key !== "api_key");
      },
    });
    expectInvalid(deceptiveIntent, ["proxy-hidden-secret"]);
  });

  it("always maps caller-controlled exceptions to the fixed public error", () => {
    const sentinel = "SENTINEL_SECRET_FROM_PROXY";
    const intent = new Proxy(validIntent(), {
      ownKeys() {
        const error = new Error(sentinel);
        error.code = "LUMIN_MAPPING_INVALID";
        throw error;
      },
    });
    expectInvalid(intent, [sentinel]);

    const optionsSentinel = "SENTINEL_OPTIONS_SECRET";
    const options = new Proxy({}, {
      ownKeys() {
        throw new Error(optionsSentinel);
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

  it("isolates every output record and array from hostile prototype serialization", () => {
    const sentinel = "SENTINEL_HOSTILE_TO_JSON";
    let calls = 0;
    Object.defineProperty(Object.prototype, "toJSON", {
      value() {
        calls += 1;
        return sentinel;
      },
      configurable: true,
    });
    try {
      const result = map();
      expectIsolatedOutputGraph(result);
      const serialized = JSON.stringify(result);
      expect(calls).toBe(0);
      expect(serialized).not.toContain(sentinel);
      expect(JSON.parse(serialized)).toMatchObject({
        request: {
          authentication_alternatives: [
            { scheme: "ApiKey" },
            { scheme: "BearerAuth" },
          ],
          body: { signers: [{ name: "Client Signer" }, { name: "Consultant Signer" }] },
        },
        limitations: expect.arrayContaining([
          "ordered_signing_blocked_pending_group_wire_type_resolution",
        ]),
      });
    } finally {
      Reflect.deleteProperty(Object.prototype, "toJSON");
    }
  });

  it("defines dense output indices without invoking an inherited numeric setter", () => {
    let calls = 0;
    let capturedValue;
    Object.defineProperty(Object.prototype, "0", {
      set(value) {
        calls += 1;
        capturedValue = value;
      },
      configurable: true,
    });
    let result;
    try {
      result = map();
    } finally {
      Reflect.deleteProperty(Object.prototype, "0");
    }
    expect(calls).toBe(0);
    expect(capturedValue).toBeUndefined();
    expect(Object.hasOwn(result.request.body.signers, "0")).toBe(true);
    expect(Object.keys(result.request.body.signers)).toEqual(["0", "1"]);
    expect(JSON.parse(JSON.stringify(result)).request.body.signers).toEqual([
      { email_address: "client@example.com", name: "Client Signer" },
      { email_address: "consultant@example.com", name: "Consultant Signer" },
    ]);
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
    }));
    expectInvalid(intent);
  });

  it("rejects an oversized unknown-key envelope before sorting it", () => {
    const intent = validIntent();
    for (let index = 0; index < 1_000; index += 1) intent[`unknown_${index}`] = index;
    expectInvalid(intent);
  });

  it("never consumes inherited optional intent, option, or signer values", () => {
    Object.defineProperties(Object.prototype, {
      viewers: {
        value: [{ participant_id: "polluted.viewer", email_address: "polluted@example.com", name: "Polluted" }],
        configurable: true,
        writable: true,
      },
      nowMs: { value: 0, configurable: true, writable: true },
      group: { value: 1, configurable: true, writable: true },
    });
    try {
      const noViewers = validIntent();
      delete noViewers.viewers;
      const result = map(noViewers);
      expect(Object.hasOwn(result.request.body, "viewers")).toBe(false);
      expect(result.bindings.participant_ids).not.toContain("polluted.viewer");

      const stale = validIntent();
      stale.expires_at_ms = 1;
      try {
        mapLuminSignV1SignatureRequest(stale);
        throw new Error("expected mapper to reject inherited clock");
      } catch (error) {
        expect(error).toMatchObject({ code: "LUMIN_MAPPING_INVALID" });
      }

      const inheritedGroup = validIntent();
      const inheritedGroupResult = map(inheritedGroup);
      expect(inheritedGroupResult.request.body.signers[0]).not.toHaveProperty("group");
    } finally {
      Reflect.deleteProperty(Object.prototype, "viewers");
      Reflect.deleteProperty(Object.prototype, "nowMs");
      Reflect.deleteProperty(Object.prototype, "group");
    }
  });

  it("rejects sparse or property-bearing participant arrays", () => {
    const sparse = validIntent();
    sparse.signers = new Array(1);
    expectInvalid(sparse);

    const decorated = validIntent();
    decorated.signers.api_key = "array-secret";
    expectInvalid(decorated, ["array-secret"]);

    const proxied = validIntent();
    proxied.signers = new Proxy(proxied.signers, {});
    expectInvalid(proxied);
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
    expect(Object.isFrozen(result.official_reference)).toBe(true);
    expect(Object.isFrozen(result.official_reference.discrepancy_codes)).toBe(true);
    expect(Object.isFrozen(result.official_reference.unmapped_official_request_options)).toBe(true);
    expect(Object.isFrozen(result.request.authentication_alternatives)).toBe(true);
    expect(Object.isFrozen(result.request.authentication_alternatives[1].required_scopes)).toBe(true);
    expect(Object.isFrozen(result.bindings.participant_ids)).toBe(true);
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.getPrototypeOf(result.request)).toBeNull();
    expect(Object.getPrototypeOf(result.request.body.signers[0])).toBeNull();
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
