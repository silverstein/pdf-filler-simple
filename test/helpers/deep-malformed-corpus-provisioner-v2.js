#!/usr/bin/env node

/**
 * Generate exactly one frozen full-scale malformed-PDF fixture under the
 * native macOS supervisor.
 *
 * One fixture per process prevents previous or later fixture allocations from
 * contaminating the sampled resource footprint. The provisioner writes one
 * mode-0600 regular file and emits one canonical, byte-bounded identity record.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEEP_FULL_SCALE_BASE_FIXTURE_NAMES,
  makeDeepMalformedFixture,
} from "./deep-malformed-fixtures.js";
import { canonicalJson } from "../eval/docling-macos-supervisor.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REQUEST_PROTOCOL = "pdf-tools.deep-malformed-corpus-provision-request.v2";
const RESULT_PROTOCOL = "pdf-tools.deep-malformed-corpus-provision-result.v2";
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 250 << 20;
const SHA256 = /^[a-f0-9]{64}$/;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort());
}

async function noLinkAncestors(filename) {
  let cursor = path.resolve(filename);
  for (;;) {
    const metadata = await fs.lstat(cursor);
    if (metadata.isSymbolicLink()) throw new Error(`Path contains a symbolic link: ${cursor}`);
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

async function streamingRegularFileIdentity(filename, maximumBytes) {
  if (path.resolve(filename) !== filename) throw new Error("File path must be canonical and absolute");
  await noLinkAncestors(filename);
  const before = await fs.lstat(filename, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || before.size < 1n || before.size > BigInt(maximumBytes)) {
    throw new Error("Provisioned fixture violates its regular-file contract");
  }
  const handle = await fs.open(
    filename,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  const digest = createHash("sha256");
  let observedBytes = 0;
  try {
    const descriptorBefore = await handle.stat({ bigint: true });
    if (descriptorBefore.dev !== before.dev || descriptorBefore.ino !== before.ino
      || descriptorBefore.size !== before.size || descriptorBefore.mode !== before.mode
      || descriptorBefore.nlink !== before.nlink) {
      throw new Error("Provisioned fixture changed before hashing");
    }
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      observedBytes += bytesRead;
      if (observedBytes > maximumBytes) throw new Error("Provisioned fixture exceeds its byte ceiling");
      digest.update(buffer.subarray(0, bytesRead));
    }
    const descriptorAfter = await handle.stat({ bigint: true });
    const pathnameAfter = await fs.lstat(filename, { bigint: true });
    if (descriptorAfter.dev !== before.dev || descriptorAfter.ino !== before.ino
      || descriptorAfter.size !== before.size || descriptorAfter.mode !== before.mode
      || descriptorAfter.nlink !== before.nlink
      || pathnameAfter.dev !== before.dev || pathnameAfter.ino !== before.ino
      || pathnameAfter.size !== before.size || pathnameAfter.mode !== before.mode
      || pathnameAfter.nlink !== before.nlink
      || observedBytes !== Number(before.size)) {
      throw new Error("Provisioned fixture changed while hashing");
    }
  } finally {
    await handle.close();
  }
  if (await fs.realpath(filename) !== filename) {
    throw new Error("Provisioned fixture path is not canonical");
  }
  return {
    path: filename,
    bytes: observedBytes,
    sha256: digest.digest("hex"),
    mode: Number(before.mode & 0o777n),
    links: Number(before.nlink),
  };
}

async function readRequest() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("Provision request exceeds its byte ceiling");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  let request;
  try {
    request = JSON.parse(text);
  } catch {
    throw new Error("Provision request must be valid JSON");
  }
  if (canonicalJson(request) !== text
    || !exactKeys(request, [
      "candidate_tree",
      "fixture",
      "generator_sha256",
      "output_path",
      "protocol",
      "scale",
    ])
    || request.protocol !== REQUEST_PROTOCOL
    || request.scale !== "full"
    || !DEEP_FULL_SCALE_BASE_FIXTURE_NAMES.includes(request.fixture)
    || !/^[a-f0-9]{40}$/.test(request.candidate_tree)
    || !SHA256.test(request.generator_sha256)
    || typeof request.output_path !== "string"
    || path.resolve(request.output_path) !== request.output_path) {
    throw new Error("Provision request violates its exact schema");
  }
  return Object.freeze(request);
}

async function main() {
  const request = await readRequest();
  const outputRoot = process.env.PDF_TOOLS_CORPUS_OUTPUT_ROOT;
  if (typeof outputRoot !== "string"
    || path.resolve(outputRoot) !== outputRoot
    || path.dirname(request.output_path) !== outputRoot
    || path.basename(request.output_path) !== `${request.fixture}.pdf`) {
    throw new Error("Provision output must be the exact requested child");
  }
  await noLinkAncestors(outputRoot);
  const rootMetadata = await fs.lstat(outputRoot, { bigint: true });
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()
    || Number(rootMetadata.mode & 0o777n) !== 0o700
    || await fs.realpath(outputRoot) !== outputRoot) {
    throw new Error("Provision output root must be a real mode-0700 directory");
  }
  const generatorPath = path.join(
    REPO_ROOT,
    "test/helpers/deep-malformed-fixtures.js",
  );
  const generator = await streamingRegularFileIdentity(generatorPath, 4 << 20);
  if (generator.sha256 !== request.generator_sha256) {
    throw new Error("Fixture generator differs from the provision request");
  }

  const started = process.hrtime.bigint();
  const fixture = makeDeepMalformedFixture({
    scale: "full",
    name: request.fixture,
  });
  const generatedSha256 = sha256(fixture.bytes);
  const handle = await fs.open(
    request.output_path,
    fsConstants.O_WRONLY
      | fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(fixture.bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(request.output_path, 0o400);
  const output = await streamingRegularFileIdentity(
    request.output_path,
    MAX_FILE_BYTES,
  );
  if (output.sha256 !== generatedSha256 || output.bytes !== fixture.bytes.length) {
    throw new Error("Provisioned bytes differ from generated fixture bytes");
  }
  const result = {
    protocol: RESULT_PROTOCOL,
    request,
    fixture: {
      name: fixture.name,
      klass: fixture.klass,
      note_sha256: sha256(Buffer.from(fixture.note, "utf8")),
      input: output,
    },
    generator,
    environment: {
      node_version: process.version,
      node_executable: await streamingRegularFileIdentity(process.execPath, 256 << 20),
      zlib_version: process.versions.zlib,
    },
    execution: {
      pid: process.pid,
      elapsed_ns: Number(process.hrtime.bigint() - started),
    },
  };
  const bytes = Buffer.from(`${canonicalJson(result)}\n`, "utf8");
  if (bytes.length > 64 * 1024) throw new Error("Provision result exceeds its byte ceiling");
  process.stdout.write(bytes);
}

main().catch(error => {
  process.stderr.write(`Fixture provisioning failed: ${error.message}\n`);
  process.exitCode = 1;
});
