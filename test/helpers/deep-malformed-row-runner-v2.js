#!/usr/bin/env node

/**
 * One exact, native-supervised product row for the frozen 33l v2 campaign.
 *
 * Fixture provisioning is a separate supervised phase. This process stable-
 * copies one hash-bound fixture into disjoint private roots, starts one fresh
 * MCP server, records baseline/product/post-call state, validates any successful
 * mutator output, gracefully closes the transport, and emits one canonical
 * byte-bounded record.
 */

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  PDFDocument,
  degrees,
} from "pdf-lib";
import { canonicalJson } from "../eval/docling-macos-supervisor.js";
import {
  DEEP_FIXTURE_CATALOG,
  DEEP_FULL_SCALE_BASE_FIXTURE_NAMES,
} from "./deep-malformed-fixtures.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REQUEST_PROTOCOL = "pdf-tools.deep-malformed-row-request.v2";
const RESULT_PROTOCOL = "pdf-tools.deep-malformed-row-result.v2";
const SCANNER_PROTOCOL = "pdf-tools.deep-malformed-response-leak-scan.v2";
const OUTPUT_FINGERPRINT_PROTOCOL =
  "pdf-tools.qpdf-semantic-object-graph-fingerprint.v1";
const QPDF_PROJECTION_PROTOCOL =
  "pdf-tools.qpdf-object-stream-disabled-projection.v1";
const NORMALIZED_STRING_PROTOCOL =
  "pdf-tools.planned-path-normalized-string.v1";
const MAX_REQUEST_BYTES = 256 * 1024;
const RAW_INTERNAL_PATTERN =
  /(?:node_modules[\\/]|node:internal[\\/]|(?:file|webpack):\/\/|\/Users\/|\/home\/|\/private\/var\/|[A-Za-z]:\\|at\s+\S+\s+\([^)]*:\d+:\d+\)|at\s+(?:processTicksAndRejections|runMicrotasks)\b|\b(?:TypeError|ReferenceError|SyntaxError|RangeError|EvalError|URIError|AggregateError|AssertionError):)/;
const SHA256 = /^[a-f0-9]{64}$/;
const CONTROL_PDF_BYTES = 728;
const CONTROL_PDF_SHA256 =
  "289a4cf752399fad51e42c1ba9c06dc1e6b8d471dfbc8403f2045b8ea2f8ecef";
const CONTROL_PDF_BASE64 =
  "JVBERi0xLjcKJYGBgYEKCjUgMCBvYmoKPDwKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL0xlbmd0aCAxMTUKPj4Kc3RyZWFtCnicHYpBCgIxEATv/Yo5C+Jk0tkkIIK6Kx68CPMBkXVR9KCI7zdKU1WXfmLjUPntNWGxH++f8X09n+ZZa2HRXKoEE7/AKH5A+F+DWJOq+APLpCQ7rlO0npE7DonJWrfWR4va6Jpza12J3+AzDI4jvtwpGwoKZW5kc3RyZWFtCmVuZG9iagoKNiAwIG9iago8PAovRmlsdGVyIC9GbGF0ZURlY29kZQovVHlwZSAvT2JqU3RtCi9OIDQKL0ZpcnN0IDIwCi9MZW5ndGggMjMzCj4+CnN0cmVhbQp4nFVQ0UoDMRB8z1fsD8gmenpXKIW2VAURpRUsiA/p3XJEykaaPal/bzY9lT4EsrOzs7PjwMIlVBVcQd1ABe7GwnRq8OX7kwCffU/J4EPoErzlroU1vBtcxoEFnJnNzD936cXvY29OQ+CUfM64jSwGN8NOSqmgM7jwibQDeE/7L5LQeoMrbmMXuAd8DTznFH6Bc0VdpQsPpH7KRlxTisOhzRaUV5T18yd+UdtJUzW2bib56NEkbp92H9QWqparo9xtxAuNgGKP1AW/iMechNXU7OnlPObMUTShkg1LdqPV9ZhXHv4BTndixgplbmRzdHJlYW0KZW5kb2JqCgo3IDAgb2JqCjw8Ci9TaXplIDgKL1Jvb3QgMiAwIFIKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL1R5cGUgL1hSZWYKL0xlbmd0aCAzOAovVyBbIDEgMiAyIF0KL0luZGV4IFsgMCA4IF0KPj4Kc3RyZWFtCnicFcSxDQAgCACwgomzu/9/w08oHYrutJliymmFQ6hfXh5UOgMhCmVuZHN0cmVhbQplbmRvYmoKCnN0YXJ0eHJlZgo1MzkKJSVFT0Y=";
const PDFJS_CANARY_TOOLS = new Set([
  "read_pdf_content",
  "get_page_analysis",
]);
const VOLATILE_PDF_METADATA_FIELDS = Object.freeze([
  "trailer.value./ID",
  "trailer.value./Info.value./CreationDate",
  "trailer.value./Info.value./ModDate",
]);
const QPDF_CLOCK_TOLERANCE_MS = 10 * 60 * 1000;

const TOOL_SPECS = Object.freeze({
  get_pdf_info: Object.freeze({
    output_kind: "none",
    arguments: inputPath => ({ pdf_path: inputPath }),
  }),
  read_pdf_fields: Object.freeze({
    output_kind: "none",
    arguments: inputPath => ({ pdf_path: inputPath }),
  }),
  read_pdf_content: Object.freeze({
    output_kind: "none",
    arguments: inputPath => ({ pdf_path: inputPath }),
  }),
  get_page_analysis: Object.freeze({
    output_kind: "none",
    arguments: inputPath => ({ pdf_path: inputPath }),
  }),
  rotate_pdf_pages: Object.freeze({
    output_kind: "rotate",
    arguments: (inputPath, targets) => ({
      input_path: inputPath,
      output_path: targets.rotate,
      degrees: 90,
    }),
  }),
  split_pdf: Object.freeze({
    output_kind: "split",
    arguments: (inputPath, targets) => ({
      input_path: inputPath,
      page_ranges: "1",
      output_directory: targets.split_directory,
    }),
  }),
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort());
}

function integer(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
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

async function realDirectory(directory, expectedMode = 0o700) {
  if (path.resolve(directory) !== directory) {
    throw new Error("Directory path must be canonical and absolute");
  }
  await noLinkAncestors(directory);
  const metadata = await fs.lstat(directory, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || Number(metadata.mode & 0o777n) !== expectedMode
    || await fs.realpath(directory) !== directory) {
    throw new Error("Campaign directory violates its identity or mode contract");
  }
  return metadata;
}

async function stableFileIdentity(filename, {
  maximumBytes,
  expected = null,
} = {}) {
  if (path.resolve(filename) !== filename) throw new Error("File path must be canonical and absolute");
  await noLinkAncestors(filename);
  const before = await fs.lstat(filename, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || before.size < 1n || before.size > BigInt(maximumBytes)) {
    throw new Error("Campaign file violates its regular-file contract");
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
      throw new Error("Campaign file changed before hashing");
    }
    const buffer = Buffer.allocUnsafe(Math.min(maximumBytes, 1024 * 1024));
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      observedBytes += bytesRead;
      if (observedBytes > maximumBytes) throw new Error("Campaign file exceeded its byte ceiling");
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
      throw new Error("Campaign file changed while hashing");
    }
  } finally {
    await handle.close();
  }
  if (await fs.realpath(filename) !== filename) throw new Error("Campaign file is not canonical");
  const identity = {
    path: filename,
    bytes: observedBytes,
    sha256: digest.digest("hex"),
    mode: Number(before.mode & 0o777n),
    links: Number(before.nlink),
    device: before.dev.toString(),
    inode: before.ino.toString(),
  };
  if (expected !== null
    && (identity.bytes !== expected.bytes || identity.sha256 !== expected.sha256)) {
    throw new Error("Campaign file differs from its expected byte identity");
  }
  return identity;
}

async function stableCopy(source, destination, expected, maximumBytes) {
  if (path.resolve(source) !== source || path.resolve(destination) !== destination) {
    throw new Error("Copy paths must be canonical and absolute");
  }
  await noLinkAncestors(source);
  await noLinkAncestors(path.dirname(destination));
  const sourceBefore = await fs.lstat(source, { bigint: true });
  if (!sourceBefore.isFile() || sourceBefore.isSymbolicLink()
    || sourceBefore.nlink !== 1n || sourceBefore.size < 1n
    || sourceBefore.size > BigInt(maximumBytes)
    || Number(sourceBefore.size) !== expected.bytes) {
    throw new Error("Corpus input violates its stable-copy contract");
  }
  const input = await fs.open(
    source,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  const output = await fs.open(
    destination,
    fsConstants.O_WRONLY
      | fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  const digest = createHash("sha256");
  let observedBytes = 0;
  try {
    const descriptorBefore = await input.stat({ bigint: true });
    if (descriptorBefore.dev !== sourceBefore.dev
      || descriptorBefore.ino !== sourceBefore.ino
      || descriptorBefore.size !== sourceBefore.size
      || descriptorBefore.mode !== sourceBefore.mode
      || descriptorBefore.nlink !== sourceBefore.nlink) {
      throw new Error("Corpus input changed before copy");
    }
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      observedBytes += bytesRead;
      if (observedBytes > maximumBytes) throw new Error("Corpus input exceeds its byte ceiling");
      digest.update(buffer.subarray(0, bytesRead));
      let offset = 0;
      while (offset < bytesRead) {
        const { bytesWritten } = await output.write(
          buffer,
          offset,
          bytesRead - offset,
          null,
        );
        if (bytesWritten < 1) throw new Error("Unable to make progress copying corpus input");
        offset += bytesWritten;
      }
    }
    await output.sync();
    const descriptorAfter = await input.stat({ bigint: true });
    const pathnameAfter = await fs.lstat(source, { bigint: true });
    if (descriptorAfter.dev !== sourceBefore.dev
      || descriptorAfter.ino !== sourceBefore.ino
      || descriptorAfter.size !== sourceBefore.size
      || descriptorAfter.mode !== sourceBefore.mode
      || descriptorAfter.nlink !== sourceBefore.nlink
      || pathnameAfter.dev !== sourceBefore.dev
      || pathnameAfter.ino !== sourceBefore.ino
      || pathnameAfter.size !== sourceBefore.size
      || pathnameAfter.mode !== sourceBefore.mode
      || pathnameAfter.nlink !== sourceBefore.nlink
      || observedBytes !== Number(sourceBefore.size)
      || digest.digest("hex") !== expected.sha256) {
      throw new Error("Corpus input changed or differed during copy");
    }
  } finally {
    await Promise.allSettled([input.close(), output.close()]);
  }
  await fs.chmod(destination, 0o400);
  return stableFileIdentity(destination, { maximumBytes, expected });
}

function validateFileReference(value) {
  return exactKeys(value, ["bytes", "klass", "name", "note_sha256", "path", "sha256"])
    && DEEP_FULL_SCALE_BASE_FIXTURE_NAMES.includes(value.name)
    && DEEP_FIXTURE_CATALOG.find(entry => entry.name === value.name)?.klass === value.klass
    && typeof value.path === "string"
    && path.resolve(value.path) === value.path
    && integer(value.bytes, 1, 250 << 20)
    && SHA256.test(value.sha256)
    && SHA256.test(value.note_sha256);
}

function validateQpdf(value) {
  return exactKeys(value, [
    "bytes",
    "links",
    "mode",
    "path",
    "sha256",
    "version",
  ])
    && typeof value.path === "string"
    && path.resolve(value.path) === value.path
    && integer(value.bytes, 1, 64 << 20)
    && value.links === 1
    && integer(value.mode, 0, 0o777)
    && SHA256.test(value.sha256)
    && typeof value.version === "string"
    && value.version.length >= 1
    && value.version.length <= 200;
}

function validateEvidenceLimits(value) {
  return exactKeys(value, [
    "aggregate_inventory_bytes",
    "inventory_entries",
    "per_file_bytes",
    "qpdf_output_bytes",
    "qpdf_timeout_ms",
    "response_bytes",
    "response_nodes",
    "row_result_bytes",
    "scanner_string_bytes",
    "semantic_fingerprint_bytes",
  ])
    && integer(value.inventory_entries, 1, 4096)
    && integer(value.per_file_bytes, 1, 250 << 20)
    && integer(value.aggregate_inventory_bytes, 1, 500 << 20)
    && integer(value.response_bytes, 1, 4 << 20)
    && integer(value.response_nodes, 1, 100_000)
    && integer(value.scanner_string_bytes, 1, 4 << 20)
    && integer(value.qpdf_timeout_ms, 1000, 30_000)
    && integer(value.qpdf_output_bytes, 1, 4 << 20)
    && integer(value.row_result_bytes, 1024, 1 << 20)
    && integer(value.semantic_fingerprint_bytes, 1, 64 << 20);
}

async function readRequest() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("Campaign row request exceeds its byte ceiling");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  let request;
  try {
    request = JSON.parse(text);
  } catch {
    throw new Error("Campaign row request must be valid JSON");
  }
  if (canonicalJson(request) !== text
    || !exactKeys(request, [
      "call_timeout_ms",
      "canary_timeout_ms",
      "evidence_limits",
      "fixture",
      "protocol",
      "qpdf",
      "tool",
    ])
    || request.protocol !== REQUEST_PROTOCOL
    || !validateFileReference(request.fixture)
    || !Object.hasOwn(TOOL_SPECS, request.tool)
    || !integer(request.call_timeout_ms, 1000, 60_000)
    || !integer(request.canary_timeout_ms, 1000, 30_000)
    || !validateEvidenceLimits(request.evidence_limits)
    || !validateQpdf(request.qpdf)) {
    throw new Error("Campaign row request violates its exact schema");
  }
  return Object.freeze(request);
}

async function privateWorkRoot() {
  const workRoot = process.env.PDF_TOOLS_CAMPAIGN_WORK_ROOT;
  if (typeof workRoot !== "string"
    || path.resolve(workRoot) !== workRoot
    || path.dirname(workRoot) !== process.cwd()) {
    throw new Error("Campaign work root must be a direct canonical child of cwd");
  }
  await realDirectory(workRoot);
  return workRoot;
}

async function inventoryOneRoot(label, root, limits) {
  await realDirectory(root);
  const entries = [];
  let aggregateBytes = 0;
  async function visit(directory, relativeDirectory) {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const child of children) {
      if (entries.length >= limits.inventory_entries) {
        throw new Error("Campaign inventory exceeds its entry ceiling");
      }
      const relativePath = path.posix.join(relativeDirectory, child.name);
      const filename = path.join(directory, child.name);
      const metadata = await fs.lstat(filename, { bigint: true });
      if (metadata.isSymbolicLink()) throw new Error("Campaign inventory contains a symbolic link");
      if (metadata.isDirectory()) {
        entries.push({
          path: `${relativePath}/`,
          kind: "directory",
          mode: Number(metadata.mode & 0o777n),
        });
        await visit(filename, relativePath);
      } else if (metadata.isFile() && metadata.nlink === 1n) {
        const identity = await stableFileIdentity(filename, {
          maximumBytes: limits.per_file_bytes,
        });
        aggregateBytes += identity.bytes;
        if (aggregateBytes > limits.aggregate_inventory_bytes) {
          throw new Error("Campaign inventory exceeds its aggregate byte ceiling");
        }
        entries.push({
          path: relativePath,
          kind: "file",
          mode: identity.mode,
          bytes: identity.bytes,
          sha256: identity.sha256,
          links: identity.links,
        });
      } else {
        throw new Error("Campaign inventory contains a hardlink or non-regular entry");
      }
    }
  }
  await visit(root, "");
  entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return {
    label,
    mode: 0o700,
    entries,
    aggregate_bytes: aggregateBytes,
  };
}

async function inventoryRoots(roots, limits) {
  const rows = [];
  let totalEntries = 0;
  let totalBytes = 0;
  for (const [label, root] of Object.entries(roots)) {
    const row = await inventoryOneRoot(label, root, limits);
    totalEntries += row.entries.length;
    totalBytes += row.aggregate_bytes;
    if (totalEntries > limits.inventory_entries
      || totalBytes > limits.aggregate_inventory_bytes) {
      throw new Error("Combined campaign inventory exceeds its ceiling");
    }
    rows.push(row);
  }
  return {
    roots: rows,
    total_entries: totalEntries,
    aggregate_bytes: totalBytes,
  };
}

function plannedPathNormalizedString(
  value,
  substitutions,
  substitutionUses,
) {
  // Encode every source string structurally. Generated tag strings are never
  // copied as bare source strings, so literal text cannot impersonate a path
  // token or collide with the normalized representation.
  const boundarySafeOccurrence = (substitution, index) => {
    const end = index + substitution.path.length;
    const before = index === 0 ? null : value[index - 1];
    const after = end === value.length ? null : value[end];
    const afterNext = end + 1 >= value.length
      ? null
      : value[end + 1];
    const beforeBoundary = before === null
      || /[\s"'`([{<:=,]/.test(before);
    const afterBoundary = after === null
      || /[\s"'`)\]}>]/.test(after)
      || (/[.,;!?]/.test(after) && (
        afterNext === null || /[\s"'`)\]}>]/.test(afterNext)
      ));
    return beforeBoundary && afterBoundary;
  };
  const nextOccurrence = (substitution, cursor) => {
    let index = value.indexOf(substitution.path, cursor);
    while (index !== -1 && !boundarySafeOccurrence(substitution, index)) {
      index = value.indexOf(substitution.path, index + 1);
    }
    return index;
  };

  const segments = [];
  let cursor = 0;
  while (cursor < value.length) {
    let selected = null;
    for (const substitution of substitutions) {
      const index = nextOccurrence(substitution, cursor);
      if (index !== -1 && (
        selected === null || index < selected.index
      )) {
        selected = { index, substitution };
      }
    }
    if (selected === null) {
      segments.push({
        kind: "literal",
        value: value.slice(cursor),
      });
      cursor = value.length;
      break;
    }
    if (selected.index > cursor) {
      segments.push({
        kind: "literal",
        value: value.slice(cursor, selected.index),
      });
    }
    segments.push({
      kind: "planned_path",
      label: selected.substitution.label,
    });
    substitutionUses.set(
      selected.substitution.label,
      substitutionUses.get(selected.substitution.label) + 1,
    );
    cursor = selected.index + selected.substitution.path.length;
  }
  if (segments.length === 0) {
    segments.push({ kind: "literal", value: "" });
  }
  return {
    protocol: NORMALIZED_STRING_PROTOCOL,
    segments,
  };
}

function scanStringLeaves(value, allowedPaths, limits) {
  const substitutions = [...allowedPaths]
    .sort((left, right) => right.path.length - left.path.length);
  const substitutionUses = new Map(substitutions.map(row => [row.label, 0]));
  const normalizedHolder = { value: null };
  const stack = [{
    value,
    parent: normalizedHolder,
    key: "value",
  }];
  const seen = new WeakSet();
  let scannedNodes = 0;
  let scannedStrings = 0;
  let scannedBytes = 0;
  let normalizedScannedBytes = 0;
  let rawInternalMatches = 0;
  const observeString = (current, { permitPathSubstitution }) => {
    scannedStrings += 1;
    scannedBytes += Buffer.byteLength(current);
    if (scannedBytes > limits.scanner_string_bytes) {
      throw new Error("Response scanner exceeds its string-byte ceiling");
    }
    const normalized = permitPathSubstitution
      ? plannedPathNormalizedString(
          current,
          substitutions,
          substitutionUses,
        )
      : current;
    const normalizedBytes = permitPathSubstitution
      ? Buffer.byteLength(canonicalJson(normalized))
      : Buffer.byteLength(normalized);
    normalizedScannedBytes += normalizedBytes;
    if (normalizedScannedBytes > limits.scanner_string_bytes) {
      throw new Error(
        "Normalized response scanner exceeds its string-byte ceiling",
      );
    }
    if (permitPathSubstitution) {
      rawInternalMatches += normalized.segments
        .filter(segment => segment.kind === "literal")
        .filter(segment => RAW_INTERNAL_PATTERN.test(segment.value))
        .length;
    } else if (RAW_INTERNAL_PATTERN.test(normalized)) {
      rawInternalMatches += 1;
    }
    return normalized;
  };
  while (stack.length > 0) {
    const { value: current, parent, key } = stack.pop();
    scannedNodes += 1;
    if (scannedNodes > limits.response_nodes) {
      throw new Error("Response scanner exceeds its node ceiling");
    }
    if (typeof current === "string") {
      parent[key] = observeString(current, {
        permitPathSubstitution: true,
      });
    } else if (Array.isArray(current)) {
      if (seen.has(current)) throw new Error("Response scanner found a cycle");
      seen.add(current);
      const normalized = new Array(current.length);
      parent[key] = normalized;
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: current[index],
          parent: normalized,
          key: index,
        });
      }
    } else if (current && typeof current === "object") {
      if (seen.has(current)) throw new Error("Response scanner found a cycle");
      seen.add(current);
      // A normal `{}` would route an own JSON `__proto__` key through
      // Object.prototype's legacy setter and silently omit that evidence.
      const normalized = Object.create(null);
      parent[key] = normalized;
      const keys = Object.keys(current).sort().reverse();
      for (const childKey of keys) {
        scannedNodes += 1;
        if (scannedNodes > limits.response_nodes) {
          throw new Error("Response scanner exceeds its node ceiling");
        }
        // Response schemas use stable property names. Scan names as evidence
        // but never path-normalize them: a dynamic path-bearing key is a leak,
        // and rejecting it avoids normalized sibling-key collisions.
        observeString(childKey, { permitPathSubstitution: false });
        stack.push({
          value: current[childKey],
          parent: normalized,
          key: childKey,
        });
      }
    } else {
      parent[key] = current;
    }
  }
  const normalizedBytes = Buffer.from(
    canonicalJson(normalizedHolder.value),
    "utf8",
  );
  if (normalizedBytes.length > limits.response_bytes) {
    throw new Error("Normalized response exceeds its evidence byte ceiling");
  }
  return {
    protocol: SCANNER_PROTOCOL,
    scanned_nodes: scannedNodes,
    scanned_strings: scannedStrings,
    scanned_bytes: scannedBytes,
    normalized_scanned_bytes: normalizedScannedBytes,
    allowed_path_substitutions: substitutions
      .map(row => ({
        label: row.label,
        path: row.path,
        uses: substitutionUses.get(row.label),
      }))
      .sort((left, right) => left.label.localeCompare(right.label)),
    raw_internal_matches: rawInternalMatches,
    normalized_response: {
      canonical_bytes: normalizedBytes.length,
      sha256: sha256(normalizedBytes),
    },
    pass: rawInternalMatches === 0,
  };
}

function responseSummary(response, allowedPaths, limits) {
  const serialized = Buffer.from(canonicalJson(response), "utf8");
  if (serialized.length > limits.response_bytes) {
    throw new Error("Product response exceeds its evidence byte ceiling");
  }
  const keys = Object.keys(response ?? {});
  const knownKeys = new Set(["_meta", "content", "isError", "structuredContent"]);
  const validResult = response
    && typeof response === "object"
    && !Array.isArray(response)
    && keys.every(key => knownKeys.has(key))
    && Array.isArray(response.content)
    && response.content.length >= 1
    && response.content.every(item =>
      item && typeof item === "object" && !Array.isArray(item)
        && typeof item.type === "string");
  const structuredError = response?.structuredContent;
  const structuredErrorSummary = structuredError
    && typeof structuredError === "object"
    && !Array.isArray(structuredError)
    && exactKeys(structuredError, ["error", "status"])
    && structuredError.status === "failed"
    && structuredError.error
    && typeof structuredError.error === "object"
    && !Array.isArray(structuredError.error)
    && exactKeys(structuredError.error, ["code", "error_schema_version"])
    ? {
        status: structuredError.status,
        error_schema_version: Number.isSafeInteger(
          structuredError.error.error_schema_version,
        )
          ? structuredError.error.error_schema_version
          : null,
        code: typeof structuredError.error.code === "string"
          ? structuredError.error.code
          : null,
      }
    : null;
  const scanner = scanStringLeaves(response, allowedPaths, limits);
  return {
    canonical_bytes: serialized.length,
    sha256: sha256(serialized),
    valid_call_tool_result: validResult,
    is_error: response?.isError === true,
    structured_error: structuredErrorSummary,
    content_items: Array.isArray(response?.content) ? response.content.length : 0,
    scanner,
  };
}

function errorSummary(error) {
  const message = String(error?.message ?? error);
  return {
    name: typeof error?.name === "string" ? error.name : null,
    code: typeof error?.code === "string" || typeof error?.code === "number"
      ? String(error.code)
      : null,
    message_bytes: Buffer.byteLength(message),
    message_sha256: sha256(Buffer.from(message, "utf8")),
    timeout: /timed out|timeout/i.test(message),
    raw_internal_leak: RAW_INTERNAL_PATTERN.test(message),
  };
}

async function callTool(client, name, args, timeout, allowedPaths, limits) {
  try {
    const response = await client.callTool(
      { name, arguments: args },
      undefined,
      { timeout, maxTotalTimeout: timeout },
    );
    return {
      outcome: "response",
      response: responseSummary(response, allowedPaths, limits),
    };
  } catch (error) {
    return {
      outcome: "transport_error",
      error: errorSummary(error),
    };
  }
}

function processStartIdentity(pid) {
  const result = spawnSync(
    "/bin/ps",
    ["-o", "lstart=,pid=", "-p", String(pid)],
    {
      encoding: "utf8",
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error || result.status !== 0 || result.signal !== null) {
    throw new Error("Unable to capture MCP server process-start identity");
  }
  const value = result.stdout.trim();
  if (!value.endsWith(String(pid)) || value.length > 200) {
    throw new Error("MCP server process-start identity is malformed");
  }
  return {
    pid,
    value,
    sha256: sha256(Buffer.from(value, "utf8")),
  };
}

function inventoryByLabel(inventory) {
  return new Map(inventory.roots.map(root => [root.label, root]));
}

function unchangedRoot(beforeByLabel, afterByLabel, label) {
  return canonicalJson(beforeByLabel.get(label)) === canonicalJson(afterByLabel.get(label));
}

function inventoryPolicy({
  request,
  baseline,
  immediate,
  final,
  product,
}) {
  const baselineByLabel = inventoryByLabel(baseline);
  const immediateByLabel = inventoryByLabel(immediate);
  const finalByLabel = inventoryByLabel(final);
  const labels = [...baselineByLabel.keys()];
  const finalMatchesImmediate = labels.every(label =>
    unchangedRoot(immediateByLabel, finalByLabel, label));
  const productSucceeded = product?.outcome === "response"
    && product.response?.is_error === false;
  const outputKind = TOOL_SPECS[request.tool].output_kind;
  const nonOutputLabels = labels.filter(label =>
    !["rotate_output", "split_output"].includes(label));
  const nonOutputsUnchanged = nonOutputLabels.every(label =>
    unchangedRoot(baselineByLabel, immediateByLabel, label));
  const rotateEntries = immediateByLabel.get("rotate_output")?.entries ?? null;
  const splitEntries = immediateByLabel.get("split_output")?.entries ?? null;
  let expectedOutputDelta = false;
  if (!productSucceeded || outputKind === "none") {
    expectedOutputDelta = unchangedRoot(
      baselineByLabel,
      immediateByLabel,
      "rotate_output",
    ) && unchangedRoot(
      baselineByLabel,
      immediateByLabel,
      "split_output",
    );
  } else if (outputKind === "rotate") {
    expectedOutputDelta =
      canonicalJson(rotateEntries?.map(row => ({
        path: row.path,
        kind: row.kind,
      }))) === canonicalJson([{ path: "rotated.pdf", kind: "file" }])
      && unchangedRoot(baselineByLabel, immediateByLabel, "split_output");
  } else if (outputKind === "split") {
    expectedOutputDelta =
      canonicalJson(splitEntries?.map(row => ({
        path: row.path,
        kind: row.kind,
      }))) === canonicalJson([{
        path: "candidate_pages_1-1.pdf",
        kind: "file",
      }])
      && unchangedRoot(baselineByLabel, immediateByLabel, "rotate_output");
  }
  return {
    output_kind: outputKind,
    product_succeeded: productSucceeded,
    non_outputs_unchanged: nonOutputsUnchanged,
    expected_output_delta: expectedOutputDelta,
    final_matches_immediate: finalMatchesImmediate,
    pass: nonOutputsUnchanged && expectedOutputDelta && finalMatchesImmediate,
  };
}

async function runBoundedCommand(executable, args, {
  timeoutMs,
  outputMaxBytes,
}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(executable, args, {
        env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ outcome: "spawn_error", error: errorSummary(error) });
      return;
    }
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > outputMaxBytes) {
        overflow = true;
        child.kill("SIGKILL");
      } else {
        stdout.push(chunk);
      }
    });
    child.stderr.on("data", chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > outputMaxBytes) {
        overflow = true;
        child.kill("SIGKILL");
      } else {
        stderr.push(chunk);
      }
    });
    child.once("error", error => {
      clearTimeout(timer);
      resolve({ outcome: "spawn_error", error: errorSummary(error) });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat(stderr);
      resolve({
        outcome: "close",
        code,
        signal,
        timed_out: timedOut,
        output_overflow: overflow,
        stdout: {
          bytes: stdoutBytes,
          sha256: sha256(stdoutBuffer),
          text: stdoutBuffer.toString("utf8"),
        },
        stderr: {
          bytes: stderrBytes,
          sha256: sha256(stderrBuffer),
        },
      });
    });
  });
}

function boundedCommandEvidence(observation) {
  if (observation.outcome !== "close") return observation;
  return {
    outcome: observation.outcome,
    code: observation.code,
    signal: observation.signal,
    timed_out: observation.timed_out,
    output_overflow: observation.output_overflow,
    stdout: {
      bytes: observation.stdout.bytes,
      sha256: observation.stdout.sha256,
    },
    stderr: observation.stderr,
  };
}

function normalizeQpdfSemanticJson(
  value,
  { referenceTimeMs = Date.now() } = {},
) {
  if (!exactKeys(value, ["qpdf"])
    || !Array.isArray(value.qpdf)
    || value.qpdf.length !== 2
    || !value.qpdf[0]
    || typeof value.qpdf[0] !== "object"
    || Array.isArray(value.qpdf[0])
    || value.qpdf[0].jsonversion !== 2
    || !value.qpdf[1]
    || typeof value.qpdf[1] !== "object"
    || Array.isArray(value.qpdf[1])
    || !value.qpdf[1].trailer
    || typeof value.qpdf[1].trailer !== "object"
    || Array.isArray(value.qpdf[1].trailer)
    || !value.qpdf[1].trailer.value
    || typeof value.qpdf[1].trailer.value !== "object"
    || Array.isArray(value.qpdf[1].trailer.value)) {
    throw new Error("QPDF semantic JSON violates its v2 object-graph schema");
  }
  const excludedOccurrences = Object.fromEntries(
    VOLATILE_PDF_METADATA_FIELDS.map(field => [field, 0]),
  );
  const retainedNonvolatileOccurrences = Object.fromEntries(
    VOLATILE_PDF_METADATA_FIELDS.map(field => [field, 0]),
  );
  const excludedValueClasses = Object.fromEntries(
    VOLATILE_PDF_METADATA_FIELDS.map(field => [field, null]),
  );
  const body = value.qpdf[1];
  const trailer = body.trailer.value;
  const excludeIf = (dictionary, key, field, predicate, valueClass) => {
    if (!dictionary
      || typeof dictionary !== "object"
      || Array.isArray(dictionary)
      || !Object.hasOwn(dictionary, key)) {
      return;
    }
    if (predicate(dictionary[key])) {
      delete dictionary[key];
      excludedOccurrences[field] += 1;
      excludedValueClasses[field] = valueClass;
    } else {
      retainedNonvolatileOccurrences[field] += 1;
    }
  };
  excludeIf(
    trailer,
    "/ID",
    "trailer.value./ID",
    candidate => Array.isArray(candidate)
      && candidate.length === 2
      && candidate.every(item =>
        typeof item === "string" && /^b:[a-f0-9]{32}$/.test(item)),
    "binary-id-array:2x128-bit",
  );

  const info = trailer["/Info"];
  let infoDictionary = null;
  if (typeof info === "string") {
    const referenced = body[`obj:${info}`];
    if (referenced
      && typeof referenced === "object"
      && !Array.isArray(referenced)
      && referenced.value
      && typeof referenced.value === "object"
      && !Array.isArray(referenced.value)) {
      infoDictionary = referenced.value;
    }
  } else if (info && typeof info === "object" && !Array.isArray(info)) {
    infoDictionary = info.value
      && typeof info.value === "object"
      && !Array.isArray(info.value)
      ? info.value
      : info;
  }
  const currentPdfLibUtcDate = candidate => {
    if (typeof candidate !== "string") return false;
    const match =
      /^u:D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/
        .exec(candidate);
    if (match === null) return false;
    const components = match.slice(1).map(Number);
    const [year, month, day, hour, minute, second] = components;
    const parsed = Date.UTC(year, month - 1, day, hour, minute, second);
    const date = new Date(parsed);
    const roundTrips = date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day
      && date.getUTCHours() === hour
      && date.getUTCMinutes() === minute
      && date.getUTCSeconds() === second;
    return Number.isFinite(referenceTimeMs)
      && roundTrips
      && Math.abs(referenceTimeMs - parsed) <= QPDF_CLOCK_TOLERANCE_MS;
  };
  excludeIf(
    infoDictionary,
    "/CreationDate",
    "trailer.value./Info.value./CreationDate",
    currentPdfLibUtcDate,
    "unicode-pdf-date:utc-second:near-fingerprint",
  );
  excludeIf(
    infoDictionary,
    "/ModDate",
    "trailer.value./Info.value./ModDate",
    currentPdfLibUtcDate,
    "unicode-pdf-date:utc-second:near-fingerprint",
  );

  const stack = [value];
  const seen = new WeakSet();
  let observedNodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (seen.has(current)) throw new Error("QPDF semantic JSON contains a cycle");
    seen.add(current);
    observedNodes += 1;
    if (observedNodes > 1_000_000) {
      throw new Error("QPDF semantic JSON exceeds its node ceiling");
    }
    if (Array.isArray(current)) {
      for (const child of current) stack.push(child);
      continue;
    }
    for (const child of Object.values(current)) stack.push(child);
  }
  return {
    clock_tolerance_ms: QPDF_CLOCK_TOLERANCE_MS,
    excluded_fields: VOLATILE_PDF_METADATA_FIELDS,
    excluded_occurrences: excludedOccurrences,
    excluded_value_classes: excludedValueClasses,
    observed_nodes: observedNodes,
    retained_nonvolatile_occurrences: retainedNonvolatileOccurrences,
  };
}

function boundedCanonicalJsonBytes(value, maximumBytes) {
  const chunks = [];
  let observedBytes = 0;
  const append = chunk => {
    observedBytes += Buffer.byteLength(chunk);
    if (observedBytes > maximumBytes) {
      throw new Error("Canonical semantic JSON exceeds its byte ceiling");
    }
    chunks.push(chunk);
  };
  const stack = [{ kind: "value", value }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame.kind === "token") {
      append(frame.value);
      continue;
    }
    const current = frame.value;
    if (Array.isArray(current)) {
      append("[");
      stack.push({ kind: "token", value: "]" });
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push({ kind: "value", value: current[index] });
        if (index > 0) stack.push({ kind: "token", value: "," });
      }
    } else if (current && typeof current === "object") {
      append("{");
      const keys = Object.keys(current).sort();
      stack.push({ kind: "token", value: "}" });
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index];
        stack.push({ kind: "value", value: current[key] });
        stack.push({ kind: "token", value: ":" });
        stack.push({ kind: "token", value: JSON.stringify(key) });
        if (index > 0) stack.push({ kind: "token", value: "," });
      }
    } else {
      const serialized = JSON.stringify(current);
      if (serialized === undefined) {
        throw new Error("Semantic JSON contains a non-JSON value");
      }
      append(serialized);
    }
  }
  return Buffer.from(chunks.join(""), "utf8");
}

async function semanticFingerprintPdf(
  qpdfPath,
  outputPath,
  {
    canonicalPdfMaxBytes,
    timeoutMs,
    outputMaxBytes,
  },
) {
  let temporaryRoot = null;
  let canonicalization = null;
  let command = null;
  try {
    temporaryRoot = await fs.mkdtemp(path.join(
      path.dirname(outputPath),
      ".qpdf-semantic-projection-",
    ));
    await fs.chmod(temporaryRoot, 0o700);
    const canonicalPath = path.join(temporaryRoot, "projection.pdf");
    const projected = await runBoundedCommand(
      qpdfPath,
      [
        "--object-streams=disable",
        "--deterministic-id",
        outputPath,
        canonicalPath,
      ],
      { timeoutMs, outputMaxBytes },
    );
    const projectedCommand = boundedCommandEvidence(projected);
    const projectedCommandPass = projected.outcome === "close"
      && projected.code === 0
      && projected.signal === null
      && projected.timed_out === false
      && projected.output_overflow === false
      && projected.stdout.bytes === 0
      && projected.stderr.bytes === 0;
    if (!projectedCommandPass) {
      return {
        protocol: OUTPUT_FINGERPRINT_PROTOCOL,
        canonicalization: {
          protocol: QPDF_PROJECTION_PROTOCOL,
          command: projectedCommand,
          output: null,
          pass: false,
        },
        command: null,
        normalization: null,
        normalized: null,
        pass: false,
      };
    }
    await fs.chmod(canonicalPath, 0o600);
    const projectedIdentity = await stableFileIdentity(canonicalPath, {
      maximumBytes: canonicalPdfMaxBytes,
    });
    canonicalization = {
      protocol: QPDF_PROJECTION_PROTOCOL,
      command: projectedCommand,
      output: {
        bytes: projectedIdentity.bytes,
        sha256: projectedIdentity.sha256,
        mode: projectedIdentity.mode,
        links: projectedIdentity.links,
      },
      pass: true,
    };

    const observed = await runBoundedCommand(
      qpdfPath,
      ["--json-output=2", canonicalPath],
      { timeoutMs, outputMaxBytes },
    );
    command = boundedCommandEvidence(observed);
    const commandPass = observed.outcome === "close"
      && observed.code === 0
      && observed.signal === null
      && observed.timed_out === false
      && observed.output_overflow === false
      && observed.stderr.bytes === 0;
    if (!commandPass) {
      return {
        protocol: OUTPUT_FINGERPRINT_PROTOCOL,
        canonicalization,
        command,
        normalization: null,
        normalized: null,
        pass: false,
      };
    }
    const value = JSON.parse(observed.stdout.text);
    const normalization = normalizeQpdfSemanticJson(value, {
      referenceTimeMs: Date.now(),
    });
    const normalizedBytes = boundedCanonicalJsonBytes(
      value,
      outputMaxBytes,
    );
    return {
      protocol: OUTPUT_FINGERPRINT_PROTOCOL,
      canonicalization,
      command,
      normalization,
      normalized: {
        canonical_bytes: normalizedBytes.length,
        sha256: sha256(normalizedBytes),
      },
      pass: true,
    };
  } catch (error) {
    return {
      protocol: OUTPUT_FINGERPRINT_PROTOCOL,
      canonicalization,
      command,
      normalization: null,
      normalized: null,
      pass: false,
      error: errorSummary(error),
    };
  } finally {
    if (temporaryRoot !== null) {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

async function validateSuccessfulOutput({
  request,
  targets,
  inputIdentity,
}) {
  const outputKind = TOOL_SPECS[request.tool].output_kind;
  if (outputKind === "none") {
    return { required: false, pass: true, outputs: [] };
  }
  const outputPath = outputKind === "rotate"
    ? targets.rotate
    : targets.split;
  let outputIdentity;
  try {
    outputIdentity = await stableFileIdentity(outputPath, {
      maximumBytes: request.evidence_limits.per_file_bytes,
    });
  } catch (error) {
    return {
      required: true,
      pass: false,
      outputs: [],
      error: errorSummary(error),
    };
  }
  const nonalias = outputIdentity.device !== inputIdentity.device
    || outputIdentity.inode !== inputIdentity.inode;
  const qpdfBefore = await stableFileIdentity(request.qpdf.path, {
    maximumBytes: 64 << 20,
    expected: request.qpdf,
  });
  const checked = await runBoundedCommand(
    request.qpdf.path,
    ["--check", outputPath],
    {
      timeoutMs: request.evidence_limits.qpdf_timeout_ms,
      outputMaxBytes: request.evidence_limits.qpdf_output_bytes,
    },
  );
  const pages = await runBoundedCommand(
    request.qpdf.path,
    ["--show-npages", outputPath],
    {
      timeoutMs: request.evidence_limits.qpdf_timeout_ms,
      outputMaxBytes: request.evidence_limits.qpdf_output_bytes,
    },
  );
  const semanticFingerprint = await semanticFingerprintPdf(
    request.qpdf.path,
    outputPath,
    {
      canonicalPdfMaxBytes: request.evidence_limits.per_file_bytes,
      timeoutMs: request.evidence_limits.qpdf_timeout_ms,
      outputMaxBytes:
        request.evidence_limits.semantic_fingerprint_bytes,
    },
  );
  const qpdfAfter = await stableFileIdentity(request.qpdf.path, {
    maximumBytes: 64 << 20,
    expected: request.qpdf,
  });
  const qpdfStable = qpdfBefore.sha256 === qpdfAfter.sha256
    && qpdfBefore.device === qpdfAfter.device
    && qpdfBefore.inode === qpdfAfter.inode;
  let semantic = {
    loadable: false,
    pages: null,
    finite_geometry: false,
    first_page_rotation: null,
  };
  try {
    const bytes = await fs.readFile(outputPath);
    const document = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pageRows = document.getPages();
    semantic = {
      loadable: true,
      pages: pageRows.length,
      finite_geometry: pageRows.every(page => {
        const { width, height } = page.getSize();
        return Number.isFinite(width) && width > 0
          && Number.isFinite(height) && height > 0;
      }),
      first_page_rotation: pageRows[0]?.getRotation()?.angle ?? null,
    };
  } catch {}
  const qpdfCheckPass = checked.outcome === "close"
    && checked.code === 0
    && checked.signal === null
    && !checked.timed_out
    && !checked.output_overflow;
  const qpdfPagesPass = pages.outcome === "close"
    && pages.code === 0
    && pages.signal === null
    && !pages.timed_out
    && !pages.output_overflow
    && pages.stdout.text.trim() === "1";
  const semanticPass = semantic.loadable
    && semantic.pages === 1
    && semantic.finite_geometry
    && (outputKind !== "rotate"
      || semantic.first_page_rotation === degrees(90).angle);
  return {
    required: true,
    pass: nonalias
      && qpdfStable
      && qpdfCheckPass
      && qpdfPagesPass
      && semanticPass
      && semanticFingerprint.pass,
    outputs: [{
      identity: outputIdentity,
      nonalias,
      qpdf_stable: qpdfStable,
      qpdf_check: checked,
      qpdf_pages: pages,
      semantic,
      semantic_fingerprint: semanticFingerprint,
    }],
  };
}

async function writeControlPdf(filename) {
  const bytes = Buffer.from(CONTROL_PDF_BASE64, "base64");
  if (bytes.length !== CONTROL_PDF_BYTES
    || sha256(bytes) !== CONTROL_PDF_SHA256) {
    throw new Error("Frozen control PDF bytes violate their source contract");
  }
  const handle = await fs.open(
    filename,
    fsConstants.O_WRONLY
      | fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(filename, 0o400);
}

async function main() {
  const request = await readRequest();
  const workRoot = await privateWorkRoot();
  const corpusRoot = process.env.PDF_TOOLS_CORPUS_INPUT_ROOT;
  if (typeof corpusRoot !== "string"
    || path.resolve(corpusRoot) !== corpusRoot
    || path.dirname(request.fixture.path) !== corpusRoot
    || path.basename(request.fixture.path) !== `${request.fixture.name}.pdf`) {
    throw new Error("Corpus input is not the exact planned fixture child");
  }
  await realDirectory(corpusRoot);

  const roots = Object.freeze({
    input: path.join(workRoot, "input"),
    rotate_output: path.join(workRoot, "outputs", "rotate"),
    split_output: path.join(workRoot, "outputs", "split"),
    profiles: path.join(workRoot, "profiles"),
    downloads: path.join(workRoot, "downloads"),
    home: path.join(workRoot, "home"),
    tmp: path.join(workRoot, "tmp"),
  });
  await fs.mkdir(path.join(workRoot, "outputs"), { mode: 0o700 });
  for (const root of Object.values(roots)) {
    await fs.mkdir(root, { mode: 0o700 });
  }
  const sourceIdentity = await stableFileIdentity(request.fixture.path, {
    maximumBytes: request.evidence_limits.per_file_bytes,
    expected: request.fixture,
  });
  const inputPath = path.join(roots.input, "candidate.pdf");
  const inputIdentity = await stableCopy(
    request.fixture.path,
    inputPath,
    request.fixture,
    request.evidence_limits.per_file_bytes,
  );
  const controlPath = path.join(roots.input, "control.pdf");
  await writeControlPdf(controlPath);
  const controlIdentity = await stableFileIdentity(controlPath, {
    maximumBytes: request.evidence_limits.per_file_bytes,
  });
  const targets = Object.freeze({
    rotate: path.join(roots.rotate_output, "rotated.pdf"),
    split_directory: roots.split_output,
    split: path.join(roots.split_output, "candidate_pages_1-1.pdf"),
  });
  const allowedPaths = Object.freeze([
    { label: "input-argument", path: inputPath },
    { label: "control-argument", path: controlPath },
    { label: "rotate-output-argument", path: targets.rotate },
    { label: "split-output-argument", path: targets.split_directory },
    { label: "split-output-child", path: targets.split },
  ]);
  const serverAllowedDirectories = canonicalJson([
    roots.input,
    roots.rotate_output,
    roots.split_output,
    roots.downloads,
  ]);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(REPO_ROOT, "server", "index.js")],
    cwd: REPO_ROOT,
    env: {
      ALLOWED_DIRECTORIES: serverAllowedDirectories,
      DEFAULT_PDF_DIR: roots.input,
      DEFAULT_DOWNLOAD_DIR: roots.downloads,
      DEFAULT_PROFILES_DIR: roots.profiles,
      HOME: roots.home,
      TMPDIR: roots.tmp,
      LANG: "C",
      LC_ALL: "C",
      PATH: process.env.PATH ?? "/usr/bin:/bin",
    },
    stderr: "inherit",
  });
  const client = new Client({
    name: "pdf-tools-deep-malformed-row-v2",
    version: "2.0.0",
  });
  let serverClosedUnexpectedly = false;
  let closingTransport = false;
  transport.onclose = () => {
    if (!closingTransport) serverClosedUnexpectedly = true;
  };
  let serverIdentity = null;
  let postServerIdentity = null;
  let baselineCanary = null;
  let baselinePdfjsCanary = null;
  let product = null;
  let postCanary = null;
  let postPdfjsCanary = null;
  let baselineInventory = null;
  let immediateInventory = null;
  let finalInventory = null;
  let productElapsedNs = null;
  const started = process.hrtime.bigint();
  try {
    await client.connect(transport);
    if (!integer(transport.pid, 1, Number.MAX_SAFE_INTEGER)) {
      throw new Error("Transport did not expose one MCP server PID");
    }
    serverIdentity = processStartIdentity(transport.pid);
    baselineCanary = await callTool(
      client,
      "get_pdf_info",
      { pdf_path: controlPath },
      request.canary_timeout_ms,
      allowedPaths,
      request.evidence_limits,
    );
    if (PDFJS_CANARY_TOOLS.has(request.tool)) {
      baselinePdfjsCanary = await callTool(
        client,
        "read_pdf_content",
        { pdf_path: controlPath },
        request.canary_timeout_ms,
        allowedPaths,
        request.evidence_limits,
      );
    }
    baselineInventory = await inventoryRoots(roots, request.evidence_limits);
    const productStarted = process.hrtime.bigint();
    product = await callTool(
      client,
      request.tool,
      TOOL_SPECS[request.tool].arguments(inputPath, targets),
      request.call_timeout_ms,
      allowedPaths,
      request.evidence_limits,
    );
    productElapsedNs = Number(process.hrtime.bigint() - productStarted);
    immediateInventory = await inventoryRoots(roots, request.evidence_limits);
    postCanary = await callTool(
      client,
      "get_pdf_info",
      { pdf_path: controlPath },
      request.canary_timeout_ms,
      allowedPaths,
      request.evidence_limits,
    );
    if (PDFJS_CANARY_TOOLS.has(request.tool)) {
      postPdfjsCanary = await callTool(
        client,
        "read_pdf_content",
        { pdf_path: controlPath },
        request.canary_timeout_ms,
        allowedPaths,
        request.evidence_limits,
      );
    }
    postServerIdentity = processStartIdentity(transport.pid);
  } finally {
    closingTransport = true;
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
  finalInventory = await inventoryRoots(roots, request.evidence_limits);
  const inventory = inventoryPolicy({
    request,
    baseline: baselineInventory,
    immediate: immediateInventory,
    final: finalInventory,
    product,
  });
  const productSucceeded = product?.outcome === "response"
    && product.response?.is_error === false;
  const outputValidation = productSucceeded
    ? await validateSuccessfulOutput({
        request,
        targets,
        inputIdentity,
      })
    : { required: false, pass: true, outputs: [] };
  const finalIdentities = {
    source: await stableFileIdentity(request.fixture.path, {
      maximumBytes: request.evidence_limits.per_file_bytes,
      expected: request.fixture,
    }),
    input: await stableFileIdentity(inputPath, {
      maximumBytes: request.evidence_limits.per_file_bytes,
      expected: request.fixture,
    }),
    control: await stableFileIdentity(controlPath, {
      maximumBytes: request.evidence_limits.per_file_bytes,
      expected: {
        bytes: CONTROL_PDF_BYTES,
        sha256: CONTROL_PDF_SHA256,
      },
    }),
  };
  const baselineIdentities = {
    source: sourceIdentity,
    input: inputIdentity,
    control: controlIdentity,
  };
  const result = {
    protocol: RESULT_PROTOCOL,
    request,
    fixture: baselineIdentities,
    identity_observations: {
      baseline: baselineIdentities,
      final: finalIdentities,
      unchanged:
        canonicalJson(baselineIdentities) === canonicalJson(finalIdentities),
    },
    execution: {
      runner_pid: process.pid,
      server: serverIdentity,
      post_server: postServerIdentity,
      server_closed_unexpectedly: serverClosedUnexpectedly,
      total_elapsed_ns: Number(process.hrtime.bigint() - started),
      product_elapsed_ns: productElapsedNs,
    },
    baseline_canary: baselineCanary,
    baseline_pdfjs_canary: baselinePdfjsCanary,
    baseline_inventory: baselineInventory,
    product,
    immediate_inventory: immediateInventory,
    same_server_canary: postCanary,
    same_server_pdfjs_canary: postPdfjsCanary,
    final_inventory: finalInventory,
    inventory_policy: inventory,
    output_validation: outputValidation,
  };
  const output = Buffer.from(`${canonicalJson(result)}\n`, "utf8");
  if (output.length > request.evidence_limits.row_result_bytes) {
    throw new Error("Campaign row result exceeds its byte ceiling");
  }
  process.stdout.write(output);
}

export const rowRunnerV2Internals = Object.freeze({
  boundedCanonicalJsonBytes,
  inventoryOneRoot,
  inventoryPolicy,
  inventoryRoots,
  normalizeQpdfSemanticJson,
  responseSummary,
  scanStringLeaves,
  semanticFingerprintPdf,
  stableFileIdentity,
  writeControlPdf,
});

if (process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    const failure = {
      protocol: "pdf-tools.deep-malformed-row-harness-error.v2",
      harness_error: errorSummary(error),
    };
    process.stdout.write(`${canonicalJson(failure)}\n`);
    process.exitCode = 1;
  });
}
