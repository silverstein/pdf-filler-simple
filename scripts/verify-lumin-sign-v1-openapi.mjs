#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const LUMIN_SIGN_V1_OPENAPI_SOURCE = Object.freeze({
  url: "https://developers.luminpdf.com/tabs/api-reference/openapi.json",
  bytes: 118_174,
  sha256: "8842b7938870ea05b8c8d5869a33cc16b33b2eb0b8f2b1c60607203e39bfd037",
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function required(value, label) {
  if (value === undefined || value === null) throw new Error(`LUMIN_OPENAPI_INVALID: missing ${label}`);
  return value;
}

function sortedStrings(value, label) {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    throw new Error(`LUMIN_OPENAPI_INVALID: invalid ${label}`);
  }
  return [...value].sort();
}

function authAlternatives(specification, operation) {
  if (!Array.isArray(operation.security)) {
    throw new Error("LUMIN_OPENAPI_INVALID: invalid operation security");
  }
  return operation.security.map((alternative, index) => {
    const entries = Object.entries(alternative ?? {});
    if (entries.length !== 1) throw new Error(`LUMIN_OPENAPI_INVALID: invalid security alternative ${index}`);
    const [[schemeName, scopes]] = entries;
    const scheme = required(specification.components?.securitySchemes?.[schemeName], `security scheme ${schemeName}`);
    const projected = {
      scheme: schemeName,
      type: required(scheme.type, `${schemeName}.type`),
      required_scopes: sortedStrings(scopes, `${schemeName} scopes`),
    };
    if (scheme.type === "apiKey") {
      projected.location = required(scheme.in, `${schemeName}.in`);
      projected.name = required(scheme.name, `${schemeName}.name`);
    } else if (scheme.type === "oauth2") {
      const flowEntries = Object.entries(scheme.flows ?? {});
      if (flowEntries.length !== 1) throw new Error(`LUMIN_OPENAPI_INVALID: invalid ${schemeName} flows`);
      const [[flowName, flow]] = flowEntries;
      projected.flow = flowName;
      projected.authorization_url = required(flow.authorizationUrl, `${schemeName}.authorizationUrl`);
      projected.token_url = required(flow.tokenUrl, `${schemeName}.tokenUrl`);
      for (const scope of projected.required_scopes) {
        required(flow.scopes?.[scope], `${schemeName} scope ${scope}`);
      }
    } else {
      throw new Error(`LUMIN_OPENAPI_INVALID: unsupported security type ${scheme.type}`);
    }
    return projected;
  }).sort((left, right) => left.scheme.localeCompare(right.scheme));
}

export function projectLuminSignV1OpenApi(specification) {
  const operation = required(specification?.paths?.["/signature_request/send"]?.post, "send operation");
  const requestSchemaRef = required(
    operation.requestBody?.content?.["application/json"]?.schema?.$ref,
    "send application/json request schema",
  );
  const requestSchema = required(specification.components?.schemas?.SignatureRequestDTO, "SignatureRequestDTO");
  const signer = required(specification.components?.schemas?.Signer, "Signer");
  const viewer = required(specification.components?.schemas?.Viewer, "Viewer");
  const exampleSigner = required(requestSchema.example?.signers?.[0], "SignatureRequestDTO example signer");
  const signerGroupSchemaType = required(signer.properties?.group?.type, "Signer group type");
  const signerGroupExampleType = typeof required(exampleSigner.group, "example signer group");
  return {
    openapi_version: required(specification.openapi, "openapi version"),
    api_title: required(specification.info?.title, "info title"),
    api_version: required(specification.info?.version, "info version"),
    server_url: required(specification.servers?.[0]?.url, "primary server URL"),
    operation: {
      method: "POST",
      path: "/signature_request/send",
      request_content_type: "application/json",
      request_schema_ref: requestSchemaRef,
      required_fields: sortedStrings(requestSchema.required, "SignatureRequestDTO required fields"),
      response_codes: Object.keys(required(operation.responses, "send responses")).sort(),
    },
    authentication_alternatives: authAlternatives(specification, operation),
    request_body: {
      property_names: Object.keys(required(requestSchema.properties, "SignatureRequestDTO properties")).sort(),
      file_url_type: required(requestSchema.properties?.file_url?.type, "file_url type"),
      signers_items_ref: required(requestSchema.properties?.signers?.items?.$ref, "signers item ref"),
      viewers_items_ref: required(requestSchema.properties?.viewers?.items?.$ref, "viewers item ref"),
      title: {
        type: required(requestSchema.properties?.title?.type, "title type"),
        min_length: required(requestSchema.properties?.title?.minLength, "title minLength"),
        max_length: required(requestSchema.properties?.title?.maxLength, "title maxLength"),
      },
      expires_at: {
        type: required(requestSchema.properties?.expires_at?.type, "expires_at type"),
        format: required(requestSchema.properties?.expires_at?.format, "expires_at format"),
      },
      use_text_tags_type: required(requestSchema.properties?.use_text_tags?.type, "use_text_tags type"),
      signing_type: {
        type: required(requestSchema.properties?.signing_type?.type, "signing_type type"),
        enum: sortedStrings(requestSchema.properties?.signing_type?.enum, "signing_type enum"),
      },
      signer: {
        property_names: Object.keys(required(signer.properties, "Signer properties")).sort(),
        required_fields: sortedStrings(signer.required, "Signer required fields"),
        email_address_type: required(signer.properties?.email_address?.type, "Signer email_address type"),
        name_type: required(signer.properties?.name?.type, "Signer name type"),
        group_schema_type: signerGroupSchemaType,
        group_example_type: signerGroupExampleType,
      },
      viewer: {
        property_names: Object.keys(required(viewer.properties, "Viewer properties")).sort(),
        required_fields: sortedStrings(viewer.required, "Viewer required fields"),
        email_address_type: required(viewer.properties?.email_address?.type, "Viewer email_address type"),
        name_type: required(viewer.properties?.name?.type, "Viewer name type"),
      },
    },
    discrepancy_codes: signerGroupSchemaType === signerGroupExampleType
      ? []
      : ["SIGNER_GROUP_SCHEMA_EXAMPLE_TYPE_MISMATCH"],
  };
}

export const LUMIN_SIGN_V1_OPENAPI_PROJECTION = deepFreeze({
  openapi_version: "3.1.0",
  api_title: "Lumin API Reference",
  api_version: "1.0.0",
  server_url: "https://api.luminpdf.com/v1",
  operation: {
    method: "POST",
    path: "/signature_request/send",
    request_content_type: "application/json",
    request_schema_ref: "#/components/schemas/SignatureRequestDTO",
    required_fields: ["expires_at", "signers", "title"],
    response_codes: ["201", "4XX"],
  },
  authentication_alternatives: [
    {
      scheme: "ApiKey",
      type: "apiKey",
      required_scopes: [],
      location: "header",
      name: "X-API-Key",
    },
    {
      scheme: "BearerAuth",
      type: "oauth2",
      required_scopes: ["sign:requests"],
      flow: "authorizationCode",
      authorization_url: "https://auth.luminpdf.com/oauth2/auth",
      token_url: "https://auth.luminpdf.com/oauth2/token",
    },
  ],
  request_body: {
    property_names: [
      "custom_email",
      "expires_at",
      "file",
      "file_url",
      "file_urls",
      "files",
      "signers",
      "signing_type",
      "title",
      "use_text_tags",
      "viewers",
    ],
    file_url_type: "string",
    signers_items_ref: "#/components/schemas/Signer",
    viewers_items_ref: "#/components/schemas/Viewer",
    title: { type: "string", min_length: 1, max_length: 255 },
    expires_at: { type: "integer", format: "unix-epoch" },
    use_text_tags_type: "boolean",
    signing_type: { type: "string", enum: ["ORDER", "SAME_TIME"] },
    signer: {
      property_names: ["email_address", "group", "name", "verification"],
      required_fields: ["email_address", "name"],
      email_address_type: "string",
      name_type: "string",
      group_schema_type: "string",
      group_example_type: "number",
    },
    viewer: {
      property_names: ["email_address", "name"],
      required_fields: ["email_address", "name"],
      email_address_type: "string",
      name_type: "string",
    },
  },
  discrepancy_codes: ["SIGNER_GROUP_SCHEMA_EXAMPLE_TYPE_MISMATCH"],
});

export const LUMIN_SIGN_V1_OPENAPI_PROJECTION_SHA256 = sha256(
  canonicalJson(LUMIN_SIGN_V1_OPENAPI_PROJECTION),
);

export function verifyLuminSignV1OpenApiBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== LUMIN_SIGN_V1_OPENAPI_SOURCE.bytes) {
    throw new Error("LUMIN_OPENAPI_IDENTITY_MISMATCH: byte length differs from the pinned official snapshot");
  }
  if (sha256(bytes) !== LUMIN_SIGN_V1_OPENAPI_SOURCE.sha256) {
    throw new Error("LUMIN_OPENAPI_IDENTITY_MISMATCH: SHA-256 differs from the pinned official snapshot");
  }
  let specification;
  try {
    specification = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("LUMIN_OPENAPI_INVALID: pinned bytes are not valid JSON");
  }
  const projection = projectLuminSignV1OpenApi(specification);
  if (canonicalJson(projection) !== canonicalJson(LUMIN_SIGN_V1_OPENAPI_PROJECTION)) {
    throw new Error("LUMIN_OPENAPI_CONTRACT_MISMATCH: derived send-signature contract differs from the reviewed projection");
  }
  return Object.freeze({
    schema_version: 1,
    verified: true,
    source: LUMIN_SIGN_V1_OPENAPI_SOURCE,
    contract_projection_sha256: LUMIN_SIGN_V1_OPENAPI_PROJECTION_SHA256,
    discrepancy_codes: Object.freeze([...projection.discrepancy_codes]),
    transport_status: "not_requested",
    credential_status: "not_requested",
    provider_execution_status: "not_requested",
  });
}

async function main() {
  if (process.argv.length !== 3) {
    throw new Error("Usage: node scripts/verify-lumin-sign-v1-openapi.mjs /absolute/path/to/openapi.json");
  }
  const inputPath = path.resolve(process.argv[2]);
  const report = verifyLuminSignV1OpenApiBytes(await readFile(inputPath));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
