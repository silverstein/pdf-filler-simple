#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseStrictJson } from "./eval-strict-json.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

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

function receiptHash(record) {
  const value = structuredClone(record);
  delete value.record_sha256;
  return sha256(canonicalJson(value));
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    values[rest[index]] = rest[index + 1];
  }
  if (
    !["append", "export"].includes(command)
    || !values["--private-key"]
    || !values["--authority-id"]
    || !values["--namespace-id"]
    || (command === "export" && !values["--campaign-id"])
  ) {
    throw new Error(
      "Usage: eval-agent-workflow-receipt-anchor.mjs <append|export> --private-key <absolute-path> --authority-id <id> --namespace-id <id> [--campaign-id <id>]",
    );
  }
  return {
    command,
    privateKeyPath: values["--private-key"],
    authorityId: values["--authority-id"],
    namespaceId: values["--namespace-id"],
    campaignId: values["--campaign-id"] ?? null,
  };
}

async function readStdin() {
  let value = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) value += chunk;
  return value;
}

function safeIdentity(value, label) {
  if (typeof value !== "string" || !/^[a-z0-9-]{1,100}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

async function loadAuthority({
  privateKeyPath,
  authorityId,
  namespaceId,
}) {
  safeIdentity(authorityId, "authorityId");
  safeIdentity(namespaceId, "namespaceId");
  if (
    !path.isAbsolute(privateKeyPath)
    || path.resolve(privateKeyPath) !== privateKeyPath
    || await fs.realpath(privateKeyPath) !== privateKeyPath
  ) {
    throw new Error("private key path must be canonical and absolute");
  }
  const stat = await fs.lstat(privateKeyPath);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || (stat.mode & 0o077) !== 0
  ) {
    throw new Error("private key must be a private single-link regular file");
  }
  const privateKey = createPrivateKey(await fs.readFile(privateKeyPath));
  const publicKeyPem = createPublicKey(privateKey).export({
    type: "spki",
    format: "pem",
  });
  const authorityRoot = path.dirname(privateKeyPath);
  const namespacesRoot = path.join(authorityRoot, "namespaces");
  const namespaceRoot = path.join(namespacesRoot, namespaceId);
  for (const [directory, label] of [
    [authorityRoot, "authority root"],
    [namespacesRoot, "namespaces root"],
    [namespaceRoot, "authority namespace"],
  ]) {
    const directoryStat = await fs.lstat(directory);
    if (
      await fs.realpath(directory) !== directory
      || !directoryStat.isDirectory()
      || directoryStat.isSymbolicLink()
      || (directoryStat.mode & 0o077) !== 0
      || directoryStat.uid !== stat.uid
    ) {
      throw new Error(`${label} must be a preexisting owner-private physical directory`);
    }
  }
  return {
    authorityId,
    namespaceId,
    privateKey,
    publicKeySha256: sha256(publicKeyPem),
    namespaceRoot,
  };
}

function ledgerPathFor(authority, campaignId) {
  safeIdentity(campaignId, "campaignId");
  return path.join(authority.namespaceRoot, `${campaignId}.jsonl`);
}

async function withExclusiveLock(ledgerPath, callback) {
  const lockPath = `${ledgerPath}.lock`;
  const handle = await fs.open(lockPath, "wx", 0o600);
  try {
    return await callback();
  } finally {
    await handle.close();
    await fs.unlink(lockPath);
  }
}

async function existingLedgerBytes(ledgerPath) {
  const stat = await fs.lstat(ledgerPath);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || (stat.mode & 0o077) !== 0
    || await fs.realpath(ledgerPath) !== ledgerPath
  ) {
    throw new Error("authority ledger must be a private single-link regular file");
  }
  return fs.readFile(ledgerPath);
}

function signedEnvelope(authority, unsigned) {
  return {
    ...unsigned,
    signature_algorithm: "Ed25519",
    public_key_sha256: authority.publicKeySha256,
    signature_base64: sign(
      null,
      Buffer.from(canonicalJson(unsigned)),
      authority.privateKey,
    ).toString("base64"),
  };
}

export async function appendAnchoredReceipt({
  privateKeyPath,
  authorityId,
  namespaceId,
  recordText,
}) {
  if (!recordText.endsWith("\n") || recordText.trim().split(/\r?\n/).length !== 1) {
    throw new Error("anchor accepts exactly one newline-terminated JSON record");
  }
  const record = parseStrictJson(recordText, "anchored receipt");
  const authority = await loadAuthority({
    privateKeyPath,
    authorityId,
    namespaceId,
  });
  if (
    record.anchor_authority_id !== authorityId
    || record.anchor_namespace_id !== namespaceId
    || !Number.isInteger(record.receipt_ordinal)
    || record.receipt_ordinal < 1
    || !/^[a-f0-9]{64}$/.test(record.record_sha256 ?? "")
    || receiptHash(record) !== record.record_sha256
  ) {
    throw new Error("anchored receipt identity is invalid");
  }
  const ledgerPath = ledgerPathFor(authority, record.campaign_id);
  return withExclusiveLock(ledgerPath, async () => {
    let handle;
    let createdLedger = false;
    if (record.receipt_ordinal === 1) {
      if (
        record.type !== "campaign_header"
        || record.previous_record_sha256 !== null
      ) {
        throw new Error("first anchored receipt must be the campaign header");
      }
      handle = await fs.open(ledgerPath, "ax", 0o600);
      createdLedger = true;
    } else {
      const existing = await existingLedgerBytes(ledgerPath);
      const lines = existing.toString("utf8").trim().split(/\r?\n/);
      const previous = parseStrictJson(lines.at(-1), "previous anchored receipt");
      if (
        lines.length !== record.receipt_ordinal - 1
        || previous.record_sha256 !== record.previous_record_sha256
        || previous.campaign_id !== record.campaign_id
        || ["attempt_failed", "campaign_finished"].includes(previous.type)
      ) {
        throw new Error("anchored receipt chain is not append-only");
      }
      handle = await fs.open(ledgerPath, "a", 0o600);
    }
    try {
      await handle.write(recordText);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (createdLedger) {
      const namespaceHandle = await fs.open(authority.namespaceRoot, "r");
      try {
        await namespaceHandle.sync();
      } finally {
        await namespaceHandle.close();
      }
    }
    return signedEnvelope(authority, {
      schema_version: "pdf-tools.agent-workflow-anchor-ack.v2",
      authority_id: authorityId,
      namespace_id: namespaceId,
      campaign_id: record.campaign_id,
      receipt_ordinal: record.receipt_ordinal,
      record_sha256: record.record_sha256,
    });
  });
}

export async function exportAnchoredReceipts({
  privateKeyPath,
  authorityId,
  namespaceId,
  campaignId,
}) {
  const authority = await loadAuthority({
    privateKeyPath,
    authorityId,
    namespaceId,
  });
  const ledgerBytes = await existingLedgerBytes(
    ledgerPathFor(authority, campaignId),
  );
  const lines = ledgerBytes.toString("utf8").trim().split(/\r?\n/);
  let previous = null;
  for (const [index, line] of lines.entries()) {
    const record = parseStrictJson(line, `anchored receipt ${index + 1}`);
    if (
      record.anchor_authority_id !== authorityId
      || record.anchor_namespace_id !== namespaceId
      || record.campaign_id !== campaignId
      || record.receipt_ordinal !== index + 1
      || record.previous_record_sha256 !== previous
      || receiptHash(record) !== record.record_sha256
    ) {
      throw new Error("authority ledger chain is invalid");
    }
    previous = record.record_sha256;
  }
  return signedEnvelope(authority, {
    schema_version: "pdf-tools.agent-workflow-anchor-export.v2",
    authority_id: authorityId,
    namespace_id: namespaceId,
    campaign_id: campaignId,
    receipt_count: lines.length,
    ledger_sha256: sha256(ledgerBytes),
    ledger_tip_sha256: previous,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  const options = parseArgs(process.argv.slice(2));
  const result = options.command === "append"
    ? await appendAnchoredReceipt({
      ...options,
      recordText: await readStdin(),
    })
    : await exportAnchoredReceipts(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
