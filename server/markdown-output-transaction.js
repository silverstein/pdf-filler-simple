#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { readBoundedPdfFileSafely } from "./bounded-pdf-file.js";
import { writeOutputAtomic } from "./helpers.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_SOURCE_BYTES = 250 * 1024 * 1024;
const REQUEST_KEYS = [
  "allowed_directories",
  "markdown_base64",
  "overwrite",
  "parent_identity",
  "protocol_version",
  "source_canonical_path",
  "source_file_identity",
  "source_path",
  "source_sha256",
  "source_size_bytes",
  "target_name",
].sort();

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameIdentity(left, right) {
  return Boolean(
    left
    && right
    && left.device === right.device
    && left.inode === right.inode,
  );
}

function identityFromStats(stats) {
  return { device: String(stats.dev), inode: String(stats.ino) };
}

function isPathInsideDirectory(candidatePath, directoryPath) {
  const relative = path.relative(directoryPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validateRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Markdown output transaction request must be an object.");
  }
  if (Object.keys(request).sort().join(",") !== REQUEST_KEYS.join(",")) {
    throw new Error("Markdown output transaction request has unexpected properties.");
  }
  if (request.protocol_version !== 1 || typeof request.overwrite !== "boolean") {
    throw new Error("Markdown output transaction protocol or overwrite flag is invalid.");
  }
  if (
    typeof request.target_name !== "string"
    || !request.target_name
    || request.target_name !== path.basename(request.target_name)
    || path.extname(request.target_name).toLowerCase() !== ".md"
  ) {
    throw new Error("Markdown output transaction target_name must be a basename ending in .md.");
  }
  for (const key of ["source_path", "source_canonical_path"]) {
    if (typeof request[key] !== "string" || !path.isAbsolute(request[key])) {
      throw new Error(`Markdown output transaction ${key} must be an absolute path.`);
    }
  }
  if (!/^[a-f0-9]{64}$/.test(request.source_sha256 ?? "")) {
    throw new Error("Markdown output transaction source_sha256 is invalid.");
  }
  if (!Number.isSafeInteger(request.source_size_bytes) || request.source_size_bytes < 0) {
    throw new Error("Markdown output transaction source_size_bytes is invalid.");
  }
  for (const identity of [request.parent_identity, request.source_file_identity]) {
    if (
      !identity
      || typeof identity !== "object"
      || Array.isArray(identity)
      || Object.keys(identity).sort().join(",") !== "device,inode"
      || typeof identity.device !== "string"
      || typeof identity.inode !== "string"
    ) {
      throw new Error("Markdown output transaction filesystem identity is invalid.");
    }
  }
  if (
    !Array.isArray(request.allowed_directories)
    || request.allowed_directories.length === 0
    || request.allowed_directories.some(directory => typeof directory !== "string" || !path.isAbsolute(directory))
  ) {
    throw new Error("Markdown output transaction allowed_directories are invalid.");
  }
  if (
    typeof request.markdown_base64 !== "string"
    || request.markdown_base64.length > 400000
    || request.markdown_base64.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(request.markdown_base64)
  ) {
    throw new Error("Markdown output transaction markdown_base64 is invalid.");
  }
  const markdownBytes = Buffer.from(request.markdown_base64, "base64");
  if (markdownBytes.toString("base64") !== request.markdown_base64 || markdownBytes.length > 200000) {
    throw new Error("Markdown output transaction Markdown bytes are invalid or exceed 200,000 bytes.");
  }
  new TextDecoder("utf-8", { fatal: true }).decode(markdownBytes);
  return markdownBytes;
}

async function readRequest() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) throw new Error("Markdown output transaction request exceeds 1 MiB.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function main() {
  const request = await readRequest();
  const markdownBytes = validateRequest(request);
  const cwdStats = await fs.lstat(".", { bigint: true });
  if (!cwdStats.isDirectory() || !sameIdentity(identityFromStats(cwdStats), request.parent_identity)) {
    throw new Error("Markdown output transaction started in a different directory identity.");
  }

  const assertCurrentDirectoryAllowed = async () => {
    const currentStats = await fs.lstat(".", { bigint: true });
    if (!currentStats.isDirectory() || !sameIdentity(identityFromStats(currentStats), request.parent_identity)) {
      throw new Error("Markdown output transaction directory identity changed.");
    }
    const currentPath = await fs.realpath(".");
    if (!request.allowed_directories.some(directory => isPathInsideDirectory(currentPath, directory))) {
      throw new Error("Markdown output transaction directory moved outside the allowed directories.");
    }
    return currentPath;
  };

  const readSource = async () => {
    const source = await readBoundedPdfFileSafely(request.source_path, MAX_SOURCE_BYTES, {
      assertPathAllowed(canonicalPath) {
        if (
          canonicalPath !== request.source_canonical_path
          || !request.allowed_directories.some(directory => isPathInsideDirectory(canonicalPath, directory))
        ) {
          throw new Error("Source PDF canonical path changed or is outside the allowed directories.");
        }
      },
    });
    if (
      source.sizeBytes !== request.source_size_bytes
      || sha256(source.bytes) !== request.source_sha256
      || !sameIdentity(source.fileIdentity, request.source_file_identity)
    ) {
      throw new Error("The source PDF changed during the Markdown transaction.");
    }
    return source;
  };

  await assertCurrentDirectoryAllowed();
  await readSource();
  let verifiedOutput = null;
  const transaction = await writeOutputAtomic(request.target_name, markdownBytes, {
    anchoredDirectory: true,
    overwrite: request.overwrite,
    validateInitialTargets: async ([target]) => {
      await assertCurrentDirectoryAllowed();
      await readSource();
      if (target?.exists && sameIdentity(target.fileIdentity, request.source_file_identity)) {
        throw new Error("output_path resolves to the same file as the source PDF. Choose a different .md path.");
      }
    },
    verifyActivatedTargets: async ([target]) => {
      if (target?.targetPath !== request.target_name) {
        throw new Error("Markdown output transaction verified an unexpected target.");
      }
      await assertCurrentDirectoryAllowed();
      let handle = null;
      let reopened;
      try {
        handle = await fs.open(request.target_name, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        const stats = await handle.stat();
        if (!stats.isFile()) throw new Error("The committed Markdown output is not a regular file.");
        reopened = await handle.readFile();
      } finally {
        await handle?.close().catch(() => {});
      }
      new TextDecoder("utf-8", { fatal: true }).decode(reopened);
      if (!reopened.equals(markdownBytes)) {
        throw new Error("The saved Markdown did not reopen as the exact UTF-8 conversion bytes.");
      }
      await readSource();
      const outputPath = await fs.realpath(request.target_name);
      if (!request.allowed_directories.some(directory => isPathInsideDirectory(outputPath, directory))) {
        throw new Error("The committed Markdown output moved outside the allowed directories.");
      }
      verifiedOutput = {
        path: outputPath,
        encoding: "utf-8",
        bytes: reopened.length,
        sha256: sha256(reopened),
        commit_method: "same_directory_atomic",
        reopened_verified: true,
      };
    },
  });
  if (!verifiedOutput) throw new Error("Markdown output transaction committed without verified evidence.");
  return {
    ...verifiedOutput,
    overwritten: transaction.replacedExisting,
  };
}

try {
  const savedOutput = await main();
  process.stdout.write(`${JSON.stringify({ ok: true, saved_output: savedOutput })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: {
      code: typeof error?.code === "string" ? error.code : "MARKDOWN_OUTPUT_TRANSACTION_FAILED",
      message: error?.message ?? String(error),
    },
  })}\n`);
  process.exitCode = 1;
}
