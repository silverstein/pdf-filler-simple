import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { LUMIN_SIGN_V1_OPERATION_REFERENCES } from "../server/lumin-sign-v1-operation.js";
import {
  LUMIN_SIGN_V1_OPENAPI_PROJECTION,
  LUMIN_SIGN_V1_OPENAPI_PROJECTION_SHA256,
  LUMIN_SIGN_V1_OPENAPI_SOURCE,
  projectLuminSignV1OpenApi,
  verifyLuminSignV1OpenApiBytes,
} from "../scripts/verify-lumin-sign-v1-openapi.mjs";

function syntheticSpecification() {
  return {
    openapi: "3.1.0",
    info: { title: "Lumin API Reference", version: "1.0.0" },
    servers: [{ url: "https://api.luminpdf.com/v1" }],
    paths: {
      "/signature_request/send": {
        post: {
          security: [{ ApiKey: [] }, { BearerAuth: ["sign:requests"] }],
          requestBody: {
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/SignatureRequestDTO" } },
            },
          },
          responses: { 201: {}, "4XX": {} },
        },
      },
      "/signature_request/{signature_request_id}": {
        get: {
          security: [
            { ApiKey: [] },
            { BearerAuth: ["sign:requests.read"] },
            { BearerAuth: ["sign:requests"] },
          ],
          responses: {
            200: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      signature_request: { $ref: "#/components/schemas/SignatureRequest" },
                    },
                  },
                },
              },
            },
            "4XX": {},
          },
        },
      },
      "/signature_request/{signature_request_id}/file": {
        get: {
          security: [
            { ApiKey: [] },
            { BearerAuth: ["sign:requests.read"] },
            { BearerAuth: ["sign:requests"] },
          ],
          parameters: [
            {
              in: "query",
              name: "type",
              schema: {
                type: "string",
                enum: ["agreement", "coc", "merged"],
                default: "agreement",
              },
            },
          ],
          responses: {
            200: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      signed_url: { type: "string" },
                      expires_at: { type: "integer", format: "unix-epoch" },
                    },
                  },
                },
                "application/pdf": { schema: { type: "string", format: "binary" } },
              },
            },
            "4XX": {},
          },
        },
      },
    },
    components: {
      securitySchemes: {
        ApiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
        BearerAuth: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: "https://auth.luminpdf.com/oauth2/auth",
              tokenUrl: "https://auth.luminpdf.com/oauth2/token",
              scopes: {
                "sign:requests": "Create, update, or view signature requests.",
                "sign:requests.read": "View signature requests.",
              },
            },
          },
        },
      },
      schemas: {
        SignatureRequestDTO: {
          required: ["signers", "title", "expires_at"],
          properties: {
            file_url: { type: "string" },
            file: { type: "string" },
            file_urls: { type: "array" },
            files: { type: "array" },
            signers: { type: "array", items: { $ref: "#/components/schemas/Signer" } },
            viewers: { type: "array", items: { $ref: "#/components/schemas/Viewer" } },
            title: { type: "string", minLength: 1, maxLength: 255 },
            expires_at: { type: "integer", format: "unix-epoch" },
            use_text_tags: { type: "boolean" },
            signing_type: { type: "string", enum: ["SAME_TIME", "ORDER"] },
            custom_email: { type: "object" },
          },
          example: { signers: [{ group: 1 }] },
        },
        Signer: {
          required: ["email_address", "name"],
          properties: {
            email_address: { type: "string" },
            name: { type: "string" },
            group: { type: "string" },
            verification: { type: "object" },
          },
        },
        Viewer: {
          required: ["email_address", "name"],
          properties: {
            email_address: { type: "string" },
            name: { type: "string" },
          },
        },
        SignatureRequest: {
          properties: {
            status: {
              type: "string",
              enum: [
                "NEED_TO_SIGN",
                "WAITING_FOR_OTHERS",
                "APPROVED",
                "REJECTED",
                "WAITING_FOR_PROCESSING",
                "FAILED",
                "CANCELLED",
              ],
            },
          },
        },
      },
    },
  };
}

describe("Lumin Sign v1 official OpenAPI contract", () => {
  it("projects only reviewed machine-readable send-request facts", () => {
    expect(projectLuminSignV1OpenApi(syntheticSpecification())).toEqual(
      LUMIN_SIGN_V1_OPENAPI_PROJECTION,
    );
    expect(LUMIN_SIGN_V1_OPENAPI_PROJECTION_SHA256).toBe(
      "bf2ca8985c3291e41e1fe78c42dc9782edc4e473be8134fe5c2ce4aa615c29f9",
    );
  });

  it("keeps lifecycle runtime enums bound to the machine-readable projection", () => {
    expect(LUMIN_SIGN_V1_OPERATION_REFERENCES.openapi.status_values).toEqual(
      LUMIN_SIGN_V1_OPENAPI_PROJECTION.lifecycle_operations.status.status_enum,
    );
    expect(LUMIN_SIGN_V1_OPERATION_REFERENCES.openapi.artifact_file_types).toEqual(
      LUMIN_SIGN_V1_OPENAPI_PROJECTION.lifecycle_operations.artifact.file_types,
    );
  });

  it("replays the exact pinned official snapshot in CI", async () => {
    const encoded = await readFile(
      new URL("./fixtures/lumin-sign-v1-openapi-2026-09-04.json.gz.b64", import.meta.url),
      "utf8",
    );
    const bytes = gunzipSync(Buffer.from(encoded.replace(/\s/g, ""), "base64"));
    expect(verifyLuminSignV1OpenApiBytes(bytes)).toMatchObject({
      source: LUMIN_SIGN_V1_OPENAPI_SOURCE,
      contract_projection_sha256: LUMIN_SIGN_V1_OPENAPI_PROJECTION_SHA256,
    });
  });

  it.each([
    ["status path", specification => { delete specification.paths["/signature_request/{signature_request_id}"]; }],
    ["artifact path", specification => { delete specification.paths["/signature_request/{signature_request_id}/file"]; }],
  ])("rejects a missing %s used by the lifecycle", (_label, mutate) => {
    const specification = syntheticSpecification();
    mutate(specification);
    expect(() => projectLuminSignV1OpenApi(specification)).toThrow();
  });

  it.each([
    ["status enum", specification => { specification.components.schemas.SignatureRequest.properties.status.enum.pop(); }],
    ["artifact type", specification => {
      specification.paths["/signature_request/{signature_request_id}/file"].get.parameters[0].schema.enum.pop();
    }],
  ])("detects %s drift used by the lifecycle", (_label, mutate) => {
    const specification = syntheticSpecification();
    mutate(specification);
    expect(projectLuminSignV1OpenApi(specification)).not.toEqual(LUMIN_SIGN_V1_OPENAPI_PROJECTION);
  });

  it("surfaces the schema/example group-type contradiction rather than choosing silently", () => {
    const specification = syntheticSpecification();
    expect(projectLuminSignV1OpenApi(specification).discrepancy_codes).toEqual([
      "SIGNER_GROUP_SCHEMA_EXAMPLE_TYPE_MISMATCH",
    ]);
    specification.components.schemas.Signer.properties.group.type = "number";
    expect(projectLuminSignV1OpenApi(specification).discrepancy_codes).toEqual([]);
    expect(projectLuminSignV1OpenApi(specification)).not.toEqual(LUMIN_SIGN_V1_OPENAPI_PROJECTION);
  });

  it("fails closed before parsing bytes that do not match the pinned snapshot", () => {
    expect(() => verifyLuminSignV1OpenApiBytes(Buffer.from("{}"))).toThrow(
      "LUMIN_OPENAPI_IDENTITY_MISMATCH: byte length differs",
    );
    const wrongBytes = Buffer.alloc(LUMIN_SIGN_V1_OPENAPI_SOURCE.bytes, 0x20);
    expect(() => verifyLuminSignV1OpenApiBytes(wrongBytes)).toThrow(
      "LUMIN_OPENAPI_IDENTITY_MISMATCH: SHA-256 differs",
    );
  });

  it("pins the official source without embedding provider credentials or transport", () => {
    expect(LUMIN_SIGN_V1_OPENAPI_SOURCE).toEqual({
      url: "https://developers.luminpdf.com/tabs/api-reference/openapi.json",
      bytes: 118_174,
      sha256: "8842b7938870ea05b8c8d5869a33cc16b33b2eb0b8f2b1c60607203e39bfd037",
    });
    expect(JSON.stringify(LUMIN_SIGN_V1_OPENAPI_PROJECTION)).not.toMatch(
      /credential|secret|access_token|refresh_token/i,
    );
  });
});
