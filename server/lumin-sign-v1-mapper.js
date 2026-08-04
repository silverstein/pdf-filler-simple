import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { types as utilTypes } from "node:util";

const MAX_LOCAL_PREPARED_DOCUMENT_BYTES = 200 * 1024 * 1024;
const MAX_LOCAL_PARTICIPANTS = 100;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const MAPPER_CONTRACT = Object.freeze({
  provider: "lumin_sign",
  provider_api_path_version: "v1",
  base_url: "https://api.luminpdf.com/v1",
  method: "POST",
  path: "/signature_request/send",
  informational_reference_url: "https://developers.luminpdf.com/tabs/api-reference/api/signature-requests/send-signature-request",
  official_openapi_source_url: "https://developers.luminpdf.com/tabs/api-reference/openapi.json",
  official_openapi_source_bytes: 121_913,
  official_openapi_source_sha256: "d59ba4a27b0ce795c1d366a81735a3dc918619951ecc5ec3fb7a7f80d878d5bc",
  official_openapi_projection_sha256: "8f3fb987391ce1552ff25c8784b9dc2725cac9b2f833abe005e9f2569a9b2701",
  official_reference_identity_status: "exact_snapshot_pinned",
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
  supported_transfer: "https_url",
  supported_field_mapping: "lumin_text_tags",
  supported_signing_types: ["SAME_TIME"],
  blocked_signing_types: ["ORDER"],
  unmapped_official_request_options: [
    "custom_email",
    "file",
    "file_urls",
    "files",
    "signer_verification",
  ],
  transport: "disabled",
});

export const LUMIN_SIGN_V1_MAPPER_CONTRACT_SHA256 = createHash("sha256")
  .update(canonicalJson(MAPPER_CONTRACT))
  .digest("hex");

function mappingError() {
  const error = new Error("LUMIN_MAPPING_INVALID: The Lumin Sign request intent failed local validation.");
  Object.defineProperty(error, "code", {
    value: "LUMIN_MAPPING_INVALID",
    enumerable: true,
    writable: false,
    configurable: false,
  });
  return error;
}

function assertExactKeys(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new Error("invalid object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("invalid object prototype");
  const allowed = [...required, ...optional].sort();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length < required.length || ownKeys.length > allowed.length) throw new Error("invalid object key count");
  if (ownKeys.some(key => typeof key !== "string")) throw new Error("invalid object key type");
  const actual = ownKeys.sort();
  if (actual.some(key => !allowed.includes(key)) || required.some(key => !actual.includes(key))) {
    throw new Error("invalid object keys");
  }
  const normalized = Object.create(null);
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error("invalid object property");
    Object.defineProperty(normalized, key, {
      value: descriptor.value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(normalized);
}

function assertDenseArray(value, { min = 0, max }) {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error("invalid array");
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor?.value;
  if (!Number.isSafeInteger(length) || length < min || length > max) throw new Error("invalid array length");
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some(key => typeof key !== "string") || ownKeys.length !== length + 1) {
    throw new Error("invalid array keys");
  }
  const normalized = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error("invalid array element");
    Object.defineProperty(normalized, key, {
      value: descriptor.value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(normalized);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function isolateOutputRecords(value) {
  if (Array.isArray(value)) {
    const normalized = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      normalized[index] = isolateOutputRecords(value[index]);
    }
    Object.setPrototypeOf(normalized, null);
    return normalized;
  }
  if (!value || typeof value !== "object") return value;
  const normalized = Object.create(null);
  for (const key of Object.keys(value)) {
    Object.defineProperty(normalized, key, {
      value: isolateOutputRecords(value[key]),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return normalized;
}

function assertBoundedString(value, { min = 1, max }) {
  if (typeof value !== "string" || value !== value.trim() || value.length < min || value.length > max) {
    throw new Error("invalid string");
  }
  return value;
}

function assertEmail(value) {
  const email = assertBoundedString(value, { max: 320 });
  if (!EMAIL_PATTERN.test(email)) throw new Error("invalid email");
  return email;
}

function assertParticipantId(value) {
  const participantId = assertBoundedString(value, { max: 128 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(participantId)) throw new Error("invalid participant id");
  return participantId;
}

function assertPublicHttpsUrl(value) {
  const raw = assertBoundedString(value, { max: 4096 });
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("invalid transfer url");
  const parsedHostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const terminalDotCount = parsedHostname.length - parsedHostname.replace(/\.+$/, "").length;
  if (terminalDotCount > 1) throw new Error("invalid transfer hostname");
  const hostname = parsedHostname.replace(/\.$/, "");
  const ipVersion = isIP(hostname);
  const invalidDnsName = ipVersion === 0 && hostname.split(".").some(label => (
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
  ));
  if (
    hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname.endsWith(".home.arpa")
    || !hostname.includes(".")
    || ipVersion !== 0
    || invalidDnsName
  ) {
    throw new Error("non-public transfer url");
  }
  return raw;
}

function mapSigner(value) {
  const signerIntent = assertExactKeys(value, ["email_address", "name", "participant_id"]);
  const participantId = assertParticipantId(signerIntent.participant_id);
  const emailAddress = assertEmail(signerIntent.email_address);
  const name = assertBoundedString(signerIntent.name, { max: 255 });
  return { participantId, signer: { email_address: emailAddress, name } };
}

function mapViewer(value) {
  const viewerIntent = assertExactKeys(value, ["email_address", "name", "participant_id"]);
  return {
    participantId: assertParticipantId(viewerIntent.participant_id),
    viewer: {
      email_address: assertEmail(viewerIntent.email_address),
      name: assertBoundedString(viewerIntent.name, { max: 255 }),
    },
  };
}

export function mapLuminSignV1SignatureRequest(intent, options = {}) {
  try {
    const validatedOptions = assertExactKeys(options, [], ["nowMs"]);
    const nowMs = validatedOptions.nowMs === undefined ? Date.now() : validatedOptions.nowMs;
    const requestIntent = assertExactKeys(intent, [
      "expires_at_ms",
      "field_mapping",
      "prepared_document",
      "schema_version",
      "signers",
      "signing_type",
      "title",
    ], ["viewers"]);
    if (requestIntent.schema_version !== 1) throw new Error("unsupported intent schema");
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("invalid clock");

    const preparedDocument = assertExactKeys(requestIntent.prepared_document, ["sha256", "size_bytes", "transfer"]);
    if (!SHA256_PATTERN.test(preparedDocument.sha256)) throw new Error("invalid prepared sha256");
    if (
      !Number.isSafeInteger(preparedDocument.size_bytes)
      || preparedDocument.size_bytes < 1
      || preparedDocument.size_bytes > MAX_LOCAL_PREPARED_DOCUMENT_BYTES
    ) {
      throw new Error("invalid prepared size");
    }
    const transfer = assertExactKeys(preparedDocument.transfer, ["kind", "url"]);
    if (transfer.kind !== "https_url") throw new Error("unsupported transfer");
    const fileUrl = assertPublicHttpsUrl(transfer.url);

    const fieldMapping = assertExactKeys(requestIntent.field_mapping, ["evidence_status", "method"]);
    if (fieldMapping.method !== "lumin_text_tags" || fieldMapping.evidence_status !== "caller_asserted") {
      throw new Error("unsupported provider field mapping assertion");
    }

    const title = assertBoundedString(requestIntent.title, { max: 255 });
    if (!Number.isSafeInteger(requestIntent.expires_at_ms) || requestIntent.expires_at_ms <= nowMs) {
      throw new Error("invalid expiry");
    }
    if (!MAPPER_CONTRACT.supported_signing_types.includes(requestIntent.signing_type)) {
      throw new Error("unsupported signing type");
    }
    const signerIntents = assertDenseArray(requestIntent.signers, { min: 1, max: MAX_LOCAL_PARTICIPANTS });
    const viewerIntents = requestIntent.viewers === undefined
      ? Object.freeze([])
      : assertDenseArray(requestIntent.viewers, { max: MAX_LOCAL_PARTICIPANTS });

    const mappedSigners = signerIntents.map(mapSigner);
    const mappedViewers = viewerIntents.map(mapViewer);
    if (mappedSigners.length + mappedViewers.length > MAX_LOCAL_PARTICIPANTS) {
      throw new Error("too many participants");
    }
    const participantIds = [...mappedSigners, ...mappedViewers].map(value => value.participantId);
    if (new Set(participantIds).size !== participantIds.length) throw new Error("duplicate participant binding");
    const body = {
      file_url: fileUrl,
      title,
      signers: mappedSigners.map(value => value.signer),
      expires_at: requestIntent.expires_at_ms,
      use_text_tags: true,
      signing_type: requestIntent.signing_type,
      ...(mappedViewers.length ? { viewers: mappedViewers.map(value => value.viewer) } : {}),
    };

    return deepFreeze(isolateOutputRecords({
      schema_version: 1,
      provider: "lumin_sign",
      provider_api_path_version: "v1",
      mapper_contract_sha256: LUMIN_SIGN_V1_MAPPER_CONTRACT_SHA256,
      request_mapping_status: "provisional_unverified",
      official_reference_identity_status: MAPPER_CONTRACT.official_reference_identity_status,
      official_reference: {
        source_url: MAPPER_CONTRACT.official_openapi_source_url,
        source_bytes: MAPPER_CONTRACT.official_openapi_source_bytes,
        source_sha256: MAPPER_CONTRACT.official_openapi_source_sha256,
        contract_projection_sha256: MAPPER_CONTRACT.official_openapi_projection_sha256,
        openapi_document_version: "3.1.0",
        provider_info_version: "1.0.0",
        discrepancy_codes: ["SIGNER_GROUP_SCHEMA_EXAMPLE_TYPE_MISMATCH"],
        unmapped_official_request_options: [...MAPPER_CONTRACT.unmapped_official_request_options],
      },
      transport_allowed: false,
      transport_status: "not_requested",
      provider_execution_status: "not_requested",
      field_mapping_status: "caller_asserted_not_independently_verified",
      idempotency_status: "not_established",
      automatic_retry_allowed: false,
      request: {
        base_url: MAPPER_CONTRACT.base_url,
        method: MAPPER_CONTRACT.method,
        path: MAPPER_CONTRACT.path,
        content_type: "application/json",
        authentication_alternatives: MAPPER_CONTRACT.authentication_alternatives.map(alternative => ({
          ...alternative,
          required_scopes: [...alternative.required_scopes],
        })),
        body,
      },
      bindings: {
        prepared_document_sha256: preparedDocument.sha256,
        prepared_document_size_bytes: preparedDocument.size_bytes,
        participant_ids: participantIds,
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
    }));
  } catch {
    throw mappingError();
  }
}
