import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

export const FIDELITY_INTEGRITY_DOMAINS = Object.freeze([
  "manifest",
  "case",
  "tool-arguments",
  "cell",
  "report",
  "score",
  "run-index",
]);

const DOMAIN_SET = new Set(FIDELITY_INTEGRITY_DOMAINS);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function fail(location, reason) {
  throw new TypeError(`Cannot canonicalize ${location}: ${reason}`);
}

function assertDataProperty(descriptor, location) {
  if (!descriptor || !("value" in descriptor)) fail(location, "accessor properties are not supported");
  if (!descriptor.enumerable) fail(location, "non-enumerable properties are not supported");
}

function normalizeArray(value, ancestors, location) {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    fail(location, "arrays must use Array.prototype");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some(key => typeof key === "symbol")) fail(location, "symbol keys are not supported");
  const dataKeys = ownKeys.filter(key => key !== "length");
  if (dataKeys.some(key => !/^(?:0|[1-9][0-9]*)$/.test(key)
    || Number(key) >= value.length || String(Number(key)) !== key)) {
    fail(location, "arrays cannot have custom properties");
  }
  if (dataKeys.length !== value.length) fail(location, "sparse arrays are not supported");
  const normalized = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) fail(`${location}[${index}]`, "sparse arrays are not supported");
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    assertDataProperty(descriptor, `${location}[${index}]`);
    normalized.push(normalizeValue(descriptor.value, ancestors, `${location}[${index}]`));
  }
  return normalized;
}

function normalizeObject(value, ancestors, location) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(location, "objects must use Object.prototype or a null prototype");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some(key => typeof key === "symbol")) fail(location, "symbol keys are not supported");
  const normalized = Object.create(null);
  for (const key of ownKeys.sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assertDataProperty(descriptor, `${location}.${key}`);
    normalized[key] = normalizeValue(descriptor.value, ancestors, `${location}.${key}`);
  }
  return normalized;
}

function normalizeValue(value, ancestors, location) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(location, "numbers must be finite");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") fail(location, `unsupported ${typeof value} value`);
  if (ancestors.has(value)) fail(location, "cyclic references are not supported");
  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? normalizeArray(value, ancestors, location)
      : normalizeObject(value, ancestors, location);
  } finally {
    ancestors.delete(value);
  }
}

function normalizedJsonValue(value) {
  return normalizeValue(value, new WeakSet(), "$root");
}

export function prettyCanonicalJson(value) {
  return `${JSON.stringify(normalizedJsonValue(value), null, 2)}\n`;
}

function recordWithoutDigest(record, digestField, label) {
  const normalized = normalizedJsonValue(record);
  if (Array.isArray(normalized) || normalized === null || typeof normalized !== "object") {
    fail("$root", `${label} must be an object`);
  }
  const content = Object.create(null);
  for (const key of Object.keys(normalized)) {
    if (key !== digestField) content[key] = normalized[key];
  }
  return content;
}

export function canonicalJson(value) {
  return JSON.stringify(normalizedJsonValue(value));
}

export function digestCanonical(domain, value) {
  if (!DOMAIN_SET.has(domain)) throw new TypeError(`Unsupported fidelity integrity domain: ${domain}`);
  return createHash("sha256")
    .update(`pdf-tools-fidelity:${domain}:v1\0`, "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

export function digestCell(cell) {
  return digestCanonical("cell", recordWithoutDigest(cell, "cell_content_sha256", "cell"));
}

export function digestReport(report) {
  return digestCanonical("report", recordWithoutDigest(report, "report_content_sha256", "report"));
}

export function digestScore(score) {
  return digestCanonical("score", recordWithoutDigest(score, "score_content_sha256", "score"));
}

export function digestRunIndex(index) {
  return digestCanonical("run-index", recordWithoutDigest(index, "run_sha256", "run index"));
}

export function verifyCanonicalJsonBytes(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new TypeError("Canonical JSON input must be a Buffer or Uint8Array");
  }
  const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let text;
  try {
    text = UTF8_DECODER.decode(raw);
  } catch (error) {
    throw new TypeError(`Canonical JSON input is not valid UTF-8: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new TypeError(`Canonical JSON input is not valid JSON: ${error.message}`);
  }
  const expected = Buffer.from(prettyCanonicalJson(parsed), "utf8");
  if (!raw.equals(expected)) {
    throw new TypeError("Canonical JSON bytes must use sorted keys, two-space indentation, and one trailing newline");
  }
  return parsed;
}
