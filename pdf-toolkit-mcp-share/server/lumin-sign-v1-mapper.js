import { createHash } from "node:crypto";
import { isIP } from "node:net";

const MAX_PROVIDER_FILE_BYTES = 200 * 1024 * 1024;
const MAX_PARTICIPANTS = 100;
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
  api_version: "v1",
  base_url: "https://api.luminpdf.com/v1",
  method: "POST",
  path: "/signature_request/send",
  required_oauth_scope: "sign:requests",
  reference_url: "https://developers.luminpdf.com/tabs/api-reference/api/signature-requests/send-signature-request",
  reference_checked_at: "2026-08-04",
  supported_transfer: "https_url",
  supported_field_mapping: "lumin_text_tags",
  supported_signing_types: ["ORDER", "SAME_TIME"],
  transport: "disabled",
});

export const LUMIN_SIGN_V1_MAPPER_CONTRACT_SHA256 = createHash("sha256")
  .update(canonicalJson(MAPPER_CONTRACT))
  .digest("hex");

function mappingError() {
  const error = new Error("LUMIN_MAPPING_INVALID: The Lumin Sign request intent failed local validation.");
  error.code = "LUMIN_MAPPING_INVALID";
  return error;
}

function assertExactKeys(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid object");
  const allowed = [...required, ...optional].sort();
  const actual = Object.keys(value).sort();
  if (actual.some(key => !allowed.includes(key)) || required.some(key => !actual.includes(key))) {
    throw new Error("invalid object keys");
  }
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
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ipVersion = isIP(hostname);
  if (
    hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname.endsWith(".home.arpa")
    || !hostname.includes(".")
    || ipVersion !== 0
  ) {
    throw new Error("non-public transfer url");
  }
  return raw;
}

function mapSigner(value, signingType) {
  assertExactKeys(value, ["email_address", "name", "participant_id"], ["group"]);
  const participantId = assertParticipantId(value.participant_id);
  const signer = {
    email_address: assertEmail(value.email_address),
    name: assertBoundedString(value.name, { max: 255 }),
  };
  if (signingType === "ORDER") {
    if (!Number.isSafeInteger(value.group) || value.group < 1 || value.group > MAX_PARTICIPANTS) {
      throw new Error("invalid signing group");
    }
    signer.group = value.group;
  } else if (value.group !== undefined) {
    throw new Error("unexpected signing group");
  }
  return { participantId, signer };
}

function mapViewer(value) {
  assertExactKeys(value, ["email_address", "name", "participant_id"]);
  return {
    participantId: assertParticipantId(value.participant_id),
    viewer: {
      email_address: assertEmail(value.email_address),
      name: assertBoundedString(value.name, { max: 255 }),
    },
  };
}

function assertContiguousGroups(signers) {
  const groups = [...new Set(signers.map(signer => signer.group))].sort((left, right) => left - right);
  if (groups.some((group, index) => group !== index + 1)) throw new Error("noncontiguous signing groups");
}

export function mapLuminSignV1SignatureRequest(intent, { nowMs = Date.now() } = {}) {
  try {
    assertExactKeys(intent, [
      "expires_at_ms",
      "field_mapping",
      "prepared_document",
      "schema_version",
      "signers",
      "signing_type",
      "title",
    ], ["viewers"]);
    if (intent.schema_version !== 1) throw new Error("unsupported intent schema");
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("invalid clock");

    assertExactKeys(intent.prepared_document, ["sha256", "size_bytes", "transfer"]);
    if (!SHA256_PATTERN.test(intent.prepared_document.sha256)) throw new Error("invalid prepared sha256");
    if (
      !Number.isSafeInteger(intent.prepared_document.size_bytes)
      || intent.prepared_document.size_bytes < 1
      || intent.prepared_document.size_bytes > MAX_PROVIDER_FILE_BYTES
    ) {
      throw new Error("invalid prepared size");
    }
    assertExactKeys(intent.prepared_document.transfer, ["kind", "url"]);
    if (intent.prepared_document.transfer.kind !== "https_url") throw new Error("unsupported transfer");
    const fileUrl = assertPublicHttpsUrl(intent.prepared_document.transfer.url);

    assertExactKeys(intent.field_mapping, ["evidence_status", "method"]);
    if (intent.field_mapping.method !== "lumin_text_tags" || intent.field_mapping.evidence_status !== "caller_asserted") {
      throw new Error("unsupported provider field mapping assertion");
    }

    const title = assertBoundedString(intent.title, { max: 255 });
    if (!Number.isSafeInteger(intent.expires_at_ms) || intent.expires_at_ms <= nowMs) {
      throw new Error("invalid expiry");
    }
    if (!MAPPER_CONTRACT.supported_signing_types.includes(intent.signing_type)) {
      throw new Error("unsupported signing type");
    }
    if (!Array.isArray(intent.signers) || intent.signers.length < 1 || intent.signers.length > MAX_PARTICIPANTS) {
      throw new Error("invalid signers");
    }
    if (!Array.isArray(intent.viewers ?? []) || (intent.viewers ?? []).length > MAX_PARTICIPANTS) {
      throw new Error("invalid viewers");
    }

    const mappedSigners = intent.signers.map(value => mapSigner(value, intent.signing_type));
    const mappedViewers = (intent.viewers ?? []).map(mapViewer);
    const participantIds = [...mappedSigners, ...mappedViewers].map(value => value.participantId);
    if (new Set(participantIds).size !== participantIds.length) throw new Error("duplicate participant binding");
    if (intent.signing_type === "ORDER") assertContiguousGroups(mappedSigners.map(value => value.signer));

    const body = {
      file_url: fileUrl,
      title,
      signers: mappedSigners.map(value => value.signer),
      expires_at: intent.expires_at_ms,
      use_text_tags: true,
      signing_type: intent.signing_type,
    };
    if (mappedViewers.length) body.viewers = mappedViewers.map(value => value.viewer);

    return {
      schema_version: 1,
      provider: "lumin_sign",
      api_version: "v1",
      mapper_contract_sha256: LUMIN_SIGN_V1_MAPPER_CONTRACT_SHA256,
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
        required_oauth_scope: MAPPER_CONTRACT.required_oauth_scope,
        body,
      },
      bindings: {
        prepared_document_sha256: intent.prepared_document.sha256,
        prepared_document_size_bytes: intent.prepared_document.size_bytes,
        participant_ids: participantIds,
      },
      limitations: [
        "credential_custody_not_established",
        "provider_environment_not_established",
        "provider_create_idempotency_not_established",
        "field_mapping_not_independently_verified",
        "plan_specific_upload_limit_not_established",
        "transfer_url_destination_not_resolved",
        "transport_not_requested",
      ],
    };
  } catch (error) {
    if (error?.code === "LUMIN_MAPPING_INVALID") throw error;
    throw mappingError();
  }
}
