import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_TOOL_BYTES = 128 * 1024 * 1024;
const SELF = fileURLToPath(import.meta.url);

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

export function computeDoclingHandoffId(identity) {
  return sha256(Buffer.from(`pdf-tools.docling-macos-handoff.v1\0${canonicalJson(identity)}`));
}

function assertCleanNodeStartup() {
  const unexpectedArgs = [...process.execArgv];
  const nodeEnvironment = Object.keys(process.env).filter(name => name.startsWith("NODE_"));
  if (unexpectedArgs.length || nodeEnvironment.length) throw new Error(`Docling launcher requires clean Node startup without exec arguments or NODE_* state (args=${unexpectedArgs.join(",") || "none"}; env=${nodeEnvironment.join(",") || "none"})`);
}

async function assertNoLinkAncestors(filename) {
  if (path.resolve(filename) !== filename) throw new Error("Docling launcher paths must be canonical absolute paths");
  const parsed = path.parse(filename);
  let cursor = parsed.root;
  for (const part of filename.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const metadata = await fs.lstat(cursor);
    if (metadata.isSymbolicLink()) throw new Error(`Docling launcher path contains a symbolic link: ${cursor}`);
  }
  if (await fs.realpath(filename) !== filename) throw new Error("Docling launcher path differs from its real path");
}

async function readStable(filename, maxBytes, requiredMode = null) {
  await assertNoLinkAncestors(filename);
  const handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maxBytes)
      || (requiredMode !== null && Number(before.mode & 0o777n) !== requiredMode)) throw new Error(`Docling launcher input violates its file contract: ${filename}`);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (["dev", "ino", "nlink", "size", "mtimeNs", "ctimeNs"].some(property => String(before[property]) !== String(after[property]))
      || BigInt(bytes.length) !== before.size) throw new Error(`Docling launcher input changed while read: ${filename}`);
    return bytes;
  } finally { await handle.close(); }
}

async function readReceiptAnchor(receiptPath, expectedReceiptSha256) {
  if (!SHA256.test(expectedReceiptSha256 ?? "")) throw new Error("Out-of-band Docling receipt SHA-256 is required");
  const bytes = await readStable(receiptPath, MAX_RECEIPT_BYTES, 0o600);
  if (sha256(bytes) !== expectedReceiptSha256) throw new Error("Docling receipt differs from its out-of-band SHA-256");
  const receipt = JSON.parse(bytes);
  if (!bytes.equals(Buffer.from(`${canonicalJson(receipt)}\n`))) throw new Error("Docling receipt is not canonical");
  return receipt;
}

function recordByRole(receipt, role) {
  const record = receipt.inputs?.find(item => item.role === role);
  if (!record) throw new Error(`Docling receipt lacks retained ${role} identity`);
  return record;
}

async function verifyBoundFile(filename, record, label, requiredMode = null) {
  const bytes = await readStable(filename, MAX_TOOL_BYTES, requiredMode);
  if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) throw new Error(`${label} differs from the out-of-band receipt before execution`);
  return bytes;
}

async function verifyNode(receipt, environment) {
  const node = receipt.toolchain?.node;
  if (!node || !SHA256.test(node.sha256 ?? "") || !Number.isInteger(node.bytes)
    || !Number.isInteger(node.mode) || node.mode < 0 || node.mode > 0o777 || node.links !== 1) {
    throw new Error("Docling receipt lacks exact Node identity");
  }
  const bytes = await readStable(node.path, MAX_TOOL_BYTES, node.mode);
  if (bytes.length !== node.bytes || sha256(bytes) !== node.sha256) throw new Error("Node binary differs from the out-of-band receipt before execution");
  const version = spawnSync(node.path, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: environment });
  if (version.error || version.status !== 0 || version.stdout.trim() !== node.version) throw new Error("Node version differs from the out-of-band receipt before execution");
  const after = await readStable(node.path, MAX_TOOL_BYTES, node.mode);
  if (!after.equals(bytes)) throw new Error("Node binary changed across launcher verification");
  return node;
}

async function writeSealedAuthority(bytes, runRoot) {
  const directory = await fs.mkdtemp(path.join(runRoot, ".authority-seal-"));
  await fs.chmod(directory, 0o700);
  const filename = path.join(directory, "authority.mjs");
  const handle = await fs.open(filename, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o400);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  return { directory, filename };
}

export async function runDoclingAuthority({ receiptPath, expectedReceiptSha256, protectedRootsJson, action = "verify", additionalArgs = [], input = null, launcherPath = null }) {
  assertCleanNodeStartup();
  if (typeof protectedRootsJson !== "string" || !protectedRootsJson) throw new Error("Out-of-band protected roots JSON is required");
  if (!new Set(["verify", "setup"]).has(action) || !Array.isArray(additionalArgs)) throw new Error("Docling authority launcher action is invalid");
  const receipt = await readReceiptAnchor(receiptPath, expectedReceiptSha256);
  await verifyBoundFile(SELF, recordByRole(receipt, "handoff_verifier_source"), "Trusted Docling launcher module");
  if (launcherPath !== null) await verifyBoundFile(launcherPath, recordByRole(receipt, "handoff_verifier_cli"), "Trusted Docling launcher CLI");
  const authorityRecord = recordByRole(receipt, "handoff_authority");
  const authorityPath = path.join(receipt.roots.sidecar_snapshot, authorityRecord.filename);
  const authorityBytes = await verifyBoundFile(authorityPath, authorityRecord, "Retained Docling authority", 0o600);
  const cleanEnvironment = {
    HOME: receipt.roots.authority_home, TMPDIR: receipt.roots.authority_tmp, PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C",
  };
  const node = await verifyNode(receipt, cleanEnvironment);
  const sealed = await writeSealedAuthority(authorityBytes, path.dirname(receiptPath));
  try {
    const result = spawnSync(node.path, [sealed.filename, action, "--receipt", receiptPath,
      "--expected-receipt-sha256", expectedReceiptSha256, "--protected-roots-json", protectedRootsJson, ...additionalArgs], {
      input, encoding: null, stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"], env: cleanEnvironment,
      maxBuffer: 20 * 1024 * 1024,
    });
    await verifyBoundFile(authorityPath, authorityRecord, "Retained Docling authority", 0o600);
    await verifyNode(receipt, cleanEnvironment);
    if (result.error || result.status !== 0) throw new Error(`Retained Docling authority rejected the handoff: ${(result.stderr?.toString() || result.error?.message || "unknown error").trim()}`);
    return { receipt, receipt_sha256: expectedReceiptSha256, stdout: result.stdout, stderr: result.stderr };
  } finally { await fs.rm(sealed.directory, { recursive: true, force: true }); }
}

export async function verifyDoclingHandoff(options) {
  const result = await runDoclingAuthority({ ...options, action: "verify" });
  const evidence = JSON.parse(result.stdout);
  if (evidence.verified !== true || evidence.handoff_id !== result.receipt.handoff_id || evidence.receipt_sha256 !== result.receipt_sha256) {
    throw new Error("Retained Docling authority returned invalid verification evidence");
  }
  return { receipt: result.receipt, receipt_sha256: result.receipt_sha256, authority_evidence: evidence };
}
