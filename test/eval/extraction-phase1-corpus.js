import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { PDFDocument } from "pdf-lib";
import { canonicalJson, sha256 } from "./extraction-phase1-protocol.js";

export const PHASE1_CORPUS_ID = "pdf-tools.extraction-phase1-retained-corpus.v1";
export const PHASE1_CORPUS_LIMITS = Object.freeze({
  max_fixtures: 100,
  max_fixture_bytes: 8 * 1024 * 1024,
  max_total_fixture_bytes: 8 * 1024 * 1024,
  max_pages_per_fixture: 1000,
  max_manifest_bytes: 1024 * 1024,
  max_descriptor_bytes: 16 * 1024 * 1024,
});

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    throw new Error(`${label} has unexpected keys`);
  }
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function parseCanonicalJson(bytes, label) {
  if (!Buffer.isBuffer(bytes)) throw new Error(`${label} bytes are unavailable`);
  const value = JSON.parse(bytes);
  if (!bytes.equals(canonicalBytes(value))) throw new Error(`${label} bytes are not canonical`);
  return value;
}

function parseJson(bytes, label) {
  if (!Buffer.isBuffer(bytes)) throw new Error(`${label} bytes are unavailable`);
  try {
    return JSON.parse(bytes);
  } catch (error) {
    throw new Error(`${label} bytes are invalid JSON: ${error.message}`);
  }
}

function embeddedJsonBinding(bytes) {
  const value = JSON.parse(bytes);
  return {
    raw_base64: bytes.toString("base64"),
    bytes: bytes.length,
    raw_sha256: sha256(bytes),
    canonical_sha256: sha256(Buffer.from(canonicalJson(value))),
  };
}

export async function buildRetainedPhase1Corpus({
  manifestBytes,
  manifestSchemaBytes,
  selectedCaseIds,
  fixtureBytesById,
  trustedPrivacyClass,
  corpusSchema,
} = {}) {
  if (!Buffer.isBuffer(manifestBytes) || !Buffer.isBuffer(manifestSchemaBytes)
    || manifestBytes.length < 1 || manifestSchemaBytes.length < 1
    || manifestBytes.length > PHASE1_CORPUS_LIMITS.max_manifest_bytes
    || manifestSchemaBytes.length > PHASE1_CORPUS_LIMITS.max_manifest_bytes) {
    throw new Error("Retained Phase 0 manifest or schema exceeds its byte ceiling");
  }
  if (!corpusSchema || typeof corpusSchema !== "object" || Array.isArray(corpusSchema)) {
    throw new Error("Retained corpus builder requires its exact descriptor schema");
  }
  const manifest = parseJson(manifestBytes, "Phase 0 manifest");
  const manifestSchema = parseJson(manifestSchemaBytes, "Phase 0 manifest schema");
  const manifestValidation = new AjvJsonSchemaValidator().getValidator(manifestSchema)(manifest);
  if (!manifestValidation.valid) throw new Error(`Retained Phase 0 manifest is invalid: ${manifestValidation.errorMessage}`);
  if (!Array.isArray(selectedCaseIds) || selectedCaseIds.length === 0 || selectedCaseIds.length > PHASE1_CORPUS_LIMITS.max_fixtures
    || new Set(selectedCaseIds).size !== selectedCaseIds.length) throw new Error("Retained corpus selected-case denominator is invalid");
  if (trustedPrivacyClass === "private_local_minimized") throw new Error("Full fixture PDFs are forbidden by private_local_minimized policy");
  if (!["public_synthetic", "private_local"].includes(trustedPrivacyClass)) throw new Error("Retained corpus privacy policy is invalid");
  const manifestById = new Map(manifest.fixtures.map(item => [item.id, item]));
  const expectedIds = [...selectedCaseIds];
  if (canonicalJson(Object.keys(fixtureBytesById ?? {}).sort()) !== canonicalJson([...expectedIds].sort())) {
    throw new Error("Retained corpus fixture coverage is missing, extra, or null");
  }
  let totalFixtureBytes = 0;
  const fixtures = [];
  for (let index = 0; index < selectedCaseIds.length; index += 1) {
    const ordinal = index + 1;
    const caseId = selectedCaseIds[index];
    const fixture = manifestById.get(caseId);
    const bytes = fixtureBytesById[caseId];
    if (!fixture || !Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > PHASE1_CORPUS_LIMITS.max_fixture_bytes
      || sha256(bytes) !== fixture.sha256) throw new Error(`Retained corpus fixture bytes are invalid for ${caseId}`);
    const pageCount = (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount();
    if (pageCount < 1 || pageCount > PHASE1_CORPUS_LIMITS.max_pages_per_fixture
      || pageCount !== fixture.expected.page_geometry.length) throw new Error(`Retained corpus page count is invalid for ${caseId}`);
    if (trustedPrivacyClass === "public_synthetic"
      && (fixture.privacy.class !== "synthetic" || fixture.privacy.contains_personal_data !== false)) {
      throw new Error(`Public retained corpus contains a non-synthetic or personal-data fixture: ${caseId}`);
    }
    totalFixtureBytes += bytes.length;
    if (totalFixtureBytes > PHASE1_CORPUS_LIMITS.max_total_fixture_bytes) throw new Error("Retained corpus exceeds its total byte limit");
    fixtures.push({
      ordinal,
      case_id: caseId,
      manifest_relative_path: fixture.path,
      media_type: "application/pdf",
      bytes: bytes.length,
      sha256: fixture.sha256,
      bytes_base64: bytes.toString("base64"),
      page_count: pageCount,
      privacy_class: fixture.privacy.class,
      contains_personal_data: fixture.privacy.contains_personal_data,
    });
  }
  const fixtureMetadata = fixtures.map(({ bytes_base64: ignored, ...metadata }) => metadata);
  const fixtureSetSha256 = sha256(Buffer.from(`pdf-tools.extraction-phase1-fixture-set.v1\0${canonicalJson(fixtureMetadata)}`));
  const descriptor = {
    corpus_id: PHASE1_CORPUS_ID,
    corpus_version: 1,
    privacy_policy: trustedPrivacyClass,
    publication_authorized: false,
    manifest: embeddedJsonBinding(manifestBytes),
    manifest_schema: embeddedJsonBinding(manifestSchemaBytes),
    selected_case_ids: expectedIds,
    fixtures,
    fixture_set_sha256: fixtureSetSha256,
    total_fixture_bytes: totalFixtureBytes,
  };
  const validation = new AjvJsonSchemaValidator().getValidator(corpusSchema)(descriptor);
  if (!validation.valid) throw new Error(`Retained corpus descriptor schema failed: ${validation.errorMessage}`);
  const artifacts = { phase0_corpus: { filename: "phase0-corpus.v1.json", bytes: canonicalBytes(descriptor) } };
  if (artifacts.phase0_corpus.bytes.length > PHASE1_CORPUS_LIMITS.max_descriptor_bytes) {
    throw new Error("Retained corpus descriptor exceeds its whole-artifact byte ceiling");
  }
  return { descriptor, artifacts, manifest, manifestSchema, manifestBytes, manifestSchemaBytes, fixtureBytesById };
}

function decodeBoundBytes(base64, expectedBytes, label, maxBytes) {
  if (typeof base64 !== "string" || base64.length > Math.ceil(maxBytes / 3) * 4 + 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new Error(`${label} base64 is invalid or exceeds its encoded ceiling`);
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length !== expectedBytes || bytes.length > maxBytes || bytes.toString("base64") !== base64) {
    throw new Error(`${label} decoded byte binding is invalid`);
  }
  return bytes;
}

function validateEmbeddedJsonBinding(binding, label, maxBytes) {
  exactKeys(binding, ["bytes", "canonical_sha256", "raw_base64", "raw_sha256"], label);
  const bytes = decodeBoundBytes(binding.raw_base64, binding.bytes, label, maxBytes);
  const value = parseJson(bytes, label);
  if (binding.raw_sha256 !== sha256(bytes) || binding.canonical_sha256 !== sha256(Buffer.from(canonicalJson(value)))) {
    throw new Error(`${label} byte binding is invalid`);
  }
  return value;
}

export async function loadRetainedPhase1Corpus({
  readArtifact,
  corpusSchema,
  trustedPrivacyClass,
  expectedManifestRawSha256,
  expectedManifestCanonicalSha256,
  expectedManifestSchemaRawSha256,
  expectedManifestSchemaCanonicalSha256,
} = {}) {
  if (typeof readArtifact !== "function" || !corpusSchema || !["public_synthetic", "private_local"].includes(trustedPrivacyClass)) {
    throw new Error("Retained corpus loader requires an artifact reader, schema, and trusted privacy class");
  }
  const descriptorBytes = await readArtifact("phase0_corpus");
  if (!Buffer.isBuffer(descriptorBytes) || descriptorBytes.length > PHASE1_CORPUS_LIMITS.max_descriptor_bytes) {
    throw new Error("Retained corpus descriptor exceeds its independent byte ceiling");
  }
  const descriptor = parseCanonicalJson(descriptorBytes, "Retained Phase 0 corpus descriptor");
  const validation = new AjvJsonSchemaValidator().getValidator(corpusSchema)(descriptor);
  if (!validation.valid) throw new Error(`Retained corpus descriptor is invalid: ${validation.errorMessage}`);
  if (descriptor.corpus_id !== PHASE1_CORPUS_ID || descriptor.corpus_version !== 1 || descriptor.publication_authorized !== false
    || descriptor.privacy_policy !== trustedPrivacyClass) {
    throw new Error("Retained corpus identity or claim boundary is invalid");
  }
  const expectedAnchors = [expectedManifestRawSha256, expectedManifestCanonicalSha256, expectedManifestSchemaRawSha256, expectedManifestSchemaCanonicalSha256];
  if (expectedAnchors.some(value => !/^[a-f0-9]{64}$/.test(value ?? ""))
    || descriptor.manifest.raw_sha256 !== expectedManifestRawSha256
    || descriptor.manifest.canonical_sha256 !== expectedManifestCanonicalSha256
    || descriptor.manifest_schema.raw_sha256 !== expectedManifestSchemaRawSha256
    || descriptor.manifest_schema.canonical_sha256 !== expectedManifestSchemaCanonicalSha256
    || descriptor.manifest.bytes > PHASE1_CORPUS_LIMITS.max_manifest_bytes
    || descriptor.manifest_schema.bytes > PHASE1_CORPUS_LIMITS.max_manifest_bytes) {
    throw new Error("Retained corpus manifest anchors differ before embedded JSON compilation");
  }
  const manifest = validateEmbeddedJsonBinding(descriptor.manifest, "Retained Phase 0 manifest", PHASE1_CORPUS_LIMITS.max_manifest_bytes);
  const manifestSchema = validateEmbeddedJsonBinding(descriptor.manifest_schema, "Retained Phase 0 manifest schema", PHASE1_CORPUS_LIMITS.max_manifest_bytes);
  const manifestBytes = decodeBoundBytes(descriptor.manifest.raw_base64, descriptor.manifest.bytes, "Retained Phase 0 manifest", PHASE1_CORPUS_LIMITS.max_manifest_bytes);
  const manifestSchemaBytes = decodeBoundBytes(descriptor.manifest_schema.raw_base64, descriptor.manifest_schema.bytes, "Retained Phase 0 manifest schema", PHASE1_CORPUS_LIMITS.max_manifest_bytes);
  const manifestValidation = new AjvJsonSchemaValidator().getValidator(manifestSchema)(manifest);
  if (!manifestValidation.valid) throw new Error(`Retained Phase 0 manifest is invalid: ${manifestValidation.errorMessage}`);
  if (canonicalJson(descriptor.fixtures.map(item => item.case_id)) !== canonicalJson(descriptor.selected_case_ids)
    || descriptor.fixtures.length > PHASE1_CORPUS_LIMITS.max_fixtures) throw new Error("Retained corpus selected-case order drifted");
  const declaredTotal = descriptor.fixtures.reduce((sum, item) => {
    if (!Number.isInteger(item.bytes) || item.bytes < 1 || item.bytes > PHASE1_CORPUS_LIMITS.max_fixture_bytes) {
      throw new Error(`Retained corpus declares an invalid fixture size for ${item.case_id}`);
    }
    return sum + item.bytes;
  }, 0);
  if (declaredTotal !== descriptor.total_fixture_bytes || declaredTotal > PHASE1_CORPUS_LIMITS.max_total_fixture_bytes) {
    throw new Error("Retained corpus declared total exceeds its predecode allocation ceiling");
  }
  const manifestById = new Map(manifest.fixtures.map(item => [item.id, item]));
  const fixtureBytesById = {};
  let totalFixtureBytes = 0;
  for (let index = 0; index < descriptor.fixtures.length; index += 1) {
    const binding = descriptor.fixtures[index];
    const ordinal = index + 1;
    const fixture = manifestById.get(binding.case_id);
    if (!fixture || binding.ordinal !== ordinal || binding.manifest_relative_path !== fixture.path || binding.sha256 !== fixture.sha256
      || binding.media_type !== "application/pdf" || binding.privacy_class !== fixture.privacy.class
      || binding.contains_personal_data !== fixture.privacy.contains_personal_data) {
      throw new Error(`Retained corpus fixture binding drifted at ordinal ${ordinal}`);
    }
    if (binding.manifest_relative_path.startsWith("/") || binding.manifest_relative_path.split("/").includes("..")) {
      throw new Error(`Retained corpus fixture path is absolute or traversing for ${binding.case_id}`);
    }
    if (trustedPrivacyClass === "public_synthetic"
      && (binding.privacy_class !== "synthetic" || binding.contains_personal_data !== false)) {
      throw new Error(`Public retained corpus has an invalid privacy classification for ${binding.case_id}`);
    }
    const bytes = decodeBoundBytes(binding.bytes_base64, binding.bytes, `Retained fixture ${binding.case_id}`, PHASE1_CORPUS_LIMITS.max_fixture_bytes);
    if (sha256(bytes) !== binding.sha256) throw new Error(`Retained corpus fixture bytes are invalid for ${binding.case_id}`);
    const pageCount = (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount();
    if (pageCount !== binding.page_count || pageCount !== fixture.expected.page_geometry.length
      || pageCount > PHASE1_CORPUS_LIMITS.max_pages_per_fixture) {
      throw new Error(`Retained corpus page-count binding is invalid for ${binding.case_id}`);
    }
    totalFixtureBytes += bytes.length;
    fixtureBytesById[binding.case_id] = bytes;
  }
  if (totalFixtureBytes !== descriptor.total_fixture_bytes || totalFixtureBytes > PHASE1_CORPUS_LIMITS.max_total_fixture_bytes
    || descriptor.fixture_set_sha256 !== sha256(Buffer.from(`pdf-tools.extraction-phase1-fixture-set.v1\0${canonicalJson(descriptor.fixtures.map(({ bytes_base64: ignored, ...metadata }) => metadata))}`))) {
    throw new Error("Retained corpus total or fixture-set binding is invalid");
  }
  return { descriptor, descriptorBytes, manifest, manifestSchema, manifestBytes, manifestSchemaBytes, fixtureBytesById };
}
