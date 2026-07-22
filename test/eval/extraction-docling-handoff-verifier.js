import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_RECEIPT_BYTES = 1024 * 1024;

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function computeDoclingHandoffId(identity) {
  return sha256(Buffer.from(`pdf-tools.docling-macos-handoff.v1\0${canonicalJson(identity)}`));
}

async function readReceiptAnchor(receiptPath, expectedReceiptSha256) {
  if (!SHA256.test(expectedReceiptSha256 ?? "")) throw new Error("Out-of-band Docling receipt SHA-256 is required");
  if (path.resolve(receiptPath) !== receiptPath) throw new Error("Docling receipt path must be canonical absolute");
  const handle = await fs.open(receiptPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(MAX_RECEIPT_BYTES)
      || Number(before.mode & 0o777n) !== 0o600) throw new Error("Docling receipt violates its file contract");
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (["dev", "ino", "nlink", "size", "mtimeNs", "ctimeNs"].some(property => String(before[property]) !== String(after[property]))
      || BigInt(bytes.length) !== before.size || sha256(bytes) !== expectedReceiptSha256) {
      throw new Error("Docling receipt differs from its out-of-band SHA-256 or changed while read");
    }
    const receipt = JSON.parse(bytes);
    if (!bytes.equals(Buffer.from(`${canonicalJson(receipt)}\n`))) throw new Error("Docling receipt is not canonical");
    return receipt;
  } finally {
    await handle.close();
  }
}

export async function verifyDoclingHandoff({ receiptPath, expectedReceiptSha256, protectedRootsJson }) {
  if (typeof protectedRootsJson !== "string" || !protectedRootsJson) throw new Error("Out-of-band protected roots JSON is required");
  const receipt = await readReceiptAnchor(receiptPath, expectedReceiptSha256);
  const authorityRecord = receipt.inputs?.find(item => item.role === "handoff_authority");
  if (!authorityRecord || !receipt.toolchain?.node?.path || !receipt.roots?.sidecar_snapshot) throw new Error("Docling receipt lacks retained authority identity");
  const authorityPath = path.join(receipt.roots.sidecar_snapshot, authorityRecord.filename);
  const result = spawnSync(process.execPath, [authorityPath, "verify", "--receipt", receiptPath,
    "--expected-receipt-sha256", expectedReceiptSha256, "--protected-roots-json", protectedRootsJson], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: {},
  });
  if (result.error || result.status !== 0) throw new Error(`Retained Docling authority rejected the handoff: ${(result.stderr || result.error?.message || "unknown error").trim()}`);
  const evidence = JSON.parse(result.stdout);
  if (evidence.verified !== true || evidence.handoff_id !== receipt.handoff_id || evidence.receipt_sha256 !== expectedReceiptSha256) {
    throw new Error("Retained Docling authority returned invalid verification evidence");
  }
  return { receipt, receipt_sha256: expectedReceiptSha256, authority_evidence: evidence };
}
