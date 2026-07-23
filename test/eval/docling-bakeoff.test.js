import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  validateCandidateResponse,
  validateFinalization,
  validateReceipt,
} from "../../scripts/eval-capture-docling-bakeoff.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const PERMISSIVE_OBJECT_SCHEMA = {
  type: "object",
  additionalProperties: true,
};

function receiptFixture() {
  const inputs = [{ role: "input", sha256: "a".repeat(64) }];
  const fixtures = [{ ordinal: 1, sha256: "b".repeat(64) }];
  const identity = {
    protocol: "pdf-tools.docling-macos-handoff.v1",
    inputs: structuredClone(inputs),
    fixtures: structuredClone(fixtures),
  };
  return {
    identity,
    inputs,
    fixtures,
    handoff_id: sha256(Buffer.from(
      `pdf-tools.docling-macos-handoff.v1\0${canonicalJson(identity)}`,
    )),
  };
}

describe("Docling bakeoff evidence validators", () => {
  it("requires the handoff identity to bind both retained inventories", () => {
    const receipt = receiptFixture();
    expect(validateReceipt(receipt, PERMISSIVE_OBJECT_SCHEMA)).toBe(receipt);

    const split = structuredClone(receipt);
    split.identity.fixtures[0].sha256 = "c".repeat(64);
    split.handoff_id = sha256(Buffer.from(
      `pdf-tools.docling-macos-handoff.v1\0${canonicalJson(split.identity)}`,
    ));
    expect(() => validateReceipt(split, PERMISSIVE_OBJECT_SCHEMA)).toThrow(/inventories are invalid/);
  });

  it("requires the finalization digest and receipt binding", () => {
    const receipt = receiptFixture();
    const receiptSha256 = "d".repeat(64);
    const core = {
      protocol: "pdf-tools.docling-finalization.v1",
      handoff_id: receipt.handoff_id,
      receipt_sha256: receiptSha256,
      execution_state: "setup_complete_not_executed",
    };
    const finalization = {
      ...core,
      finalization_id: sha256(Buffer.from(
        `pdf-tools.docling-finalization.v1\0${canonicalJson(core)}`,
      )),
    };
    expect(validateFinalization(
      finalization,
      PERMISSIVE_OBJECT_SCHEMA,
      receipt,
      receiptSha256,
    )).toBe(finalization);

    const drifted = { ...finalization, receipt_sha256: "e".repeat(64) };
    expect(() => validateFinalization(
      drifted,
      PERMISSIVE_OBJECT_SCHEMA,
      receipt,
      receiptSha256,
    )).toThrow(/identity is invalid/);
  });

  it("requires every candidate response to match its request", () => {
    const request = { protocol: "pdf-tools.extraction-candidate.v1", request_id: "f".repeat(64) };
    const response = { protocol: request.protocol, request_id: request.request_id };
    expect(validateCandidateResponse(response, request, PERMISSIVE_OBJECT_SCHEMA)).toBe(response);
    expect(() => validateCandidateResponse(
      { ...response, request_id: "0".repeat(64) },
      request,
      PERMISSIVE_OBJECT_SCHEMA,
    )).toThrow(/not bound/);
  });
});
