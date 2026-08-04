import { describe, expect, it } from "vitest";
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
              scopes: { "sign:requests": "Create, update, or view signature requests." },
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
      "8f3fb987391ce1552ff25c8784b9dc2725cac9b2f833abe005e9f2569a9b2701",
    );
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
      bytes: 121_913,
      sha256: "d59ba4a27b0ce795c1d366a81735a3dc918619951ecc5ec3fb7a7f80d878d5bc",
    });
    expect(JSON.stringify(LUMIN_SIGN_V1_OPENAPI_PROJECTION)).not.toMatch(
      /credential|secret|access_token|refresh_token/i,
    );
  });
});
