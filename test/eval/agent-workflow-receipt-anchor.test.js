import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  verify,
} from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendAnchoredReceipt,
  exportAnchoredReceipts,
} from "../../scripts/eval-agent-workflow-receipt-anchor.mjs";

const AUTHORITY_ID = "silvercloud-tailnet-receipt-ledger-v1";
const NAMESPACE_ID = "oda-pdf-tools-agent-workflow-v3";
const CAMPAIGN_ID = "pdf-tools-v3-test-campaign";
const roots = [];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function receipt({
  ordinal,
  previous,
  type,
  body = {},
}) {
  const unsigned = {
    schema_version: "pdf-tools.agent-workflow-receipt.v1",
    campaign_id: CAMPAIGN_ID,
    anchor_authority_id: AUTHORITY_ID,
    anchor_namespace_id: NAMESPACE_ID,
    receipt_ordinal: ordinal,
    previous_record_sha256: previous,
    type,
    ...body,
  };
  return {
    ...unsigned,
    record_sha256: sha256(canonicalJson(unsigned)),
  };
}

function unsignedEnvelope(value) {
  const copy = structuredClone(value);
  delete copy.signature_algorithm;
  delete copy.public_key_sha256;
  delete copy.signature_base64;
  return copy;
}

function verifies(value, publicKey) {
  return verify(
    null,
    Buffer.from(canonicalJson(unsignedEnvelope(value))),
    createPublicKey(publicKey),
    Buffer.from(value.signature_base64, "base64"),
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })));
});

describe("agent workflow receipt anchor", () => {
  it("signs one append-only campaign and refuses invalid or terminal continuation", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "pdf-receipt-anchor-")),
    );
    roots.push(root);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privateKeyPath = path.join(root, "private.pem");
    const publicKeyBytes = publicKey.export({ type: "spki", format: "pem" });
    await fs.writeFile(
      privateKeyPath,
      privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 },
    );
    await fs.mkdir(
      path.join(root, "namespaces", NAMESPACE_ID),
      { recursive: true, mode: 0o700 },
    );
    const options = {
      privateKeyPath,
      authorityId: AUTHORITY_ID,
      namespaceId: NAMESPACE_ID,
    };

    const invalidFirst = receipt({
      ordinal: 1,
      previous: null,
      type: "attempt_started",
    });
    await expect(appendAnchoredReceipt({
      ...options,
      recordText: `${JSON.stringify(invalidFirst)}\n`,
    })).rejects.toThrow(/first anchored receipt/);

    const header = receipt({
      ordinal: 1,
      previous: null,
      type: "campaign_header",
    });
    const headerAck = await appendAnchoredReceipt({
      ...options,
      recordText: `${JSON.stringify(header)}\n`,
    });
    expect(headerAck).toMatchObject({
      campaign_id: CAMPAIGN_ID,
      receipt_ordinal: 1,
      record_sha256: header.record_sha256,
      signature_algorithm: "Ed25519",
      public_key_sha256: sha256(publicKeyBytes),
    });
    expect(verifies(headerAck, publicKeyBytes)).toBe(true);

    const started = receipt({
      ordinal: 2,
      previous: header.record_sha256,
      type: "campaign_started",
    });
    const startedAck = await appendAnchoredReceipt({
      ...options,
      recordText: `${JSON.stringify(started)}\n`,
    });
    expect(verifies(startedAck, publicKeyBytes)).toBe(true);

    const finished = receipt({
      ordinal: 3,
      previous: started.record_sha256,
      type: "campaign_finished",
      body: { completed_runs: 0 },
    });
    await appendAnchoredReceipt({
      ...options,
      recordText: `${JSON.stringify(finished)}\n`,
    });
    const exported = await exportAnchoredReceipts({
      ...options,
      campaignId: CAMPAIGN_ID,
    });
    expect(exported).toMatchObject({
      campaign_id: CAMPAIGN_ID,
      receipt_count: 3,
      ledger_tip_sha256: finished.record_sha256,
      signature_algorithm: "Ed25519",
      public_key_sha256: sha256(publicKeyBytes),
    });
    expect(verifies(exported, publicKeyBytes)).toBe(true);

    const afterTerminal = receipt({
      ordinal: 4,
      previous: finished.record_sha256,
      type: "attempt_started",
    });
    await expect(appendAnchoredReceipt({
      ...options,
      recordText: `${JSON.stringify(afterTerminal)}\n`,
    })).rejects.toThrow(/not append-only/);
    await expect(appendAnchoredReceipt({
      ...options,
      recordText: `${JSON.stringify(header)}\n`,
    })).rejects.toThrow();
  });
});
