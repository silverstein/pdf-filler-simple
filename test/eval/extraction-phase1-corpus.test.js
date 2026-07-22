import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "./extraction-phase1-protocol.js";
import { PHASE1_CORPUS_LIMITS, buildRetainedPhase1Corpus, loadRetainedPhase1Corpus } from "./extraction-phase1-corpus.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXTRACTION_ROOT = path.join(REPO_ROOT, "test", "fixtures", "eval", "extraction");
const PHASE1_ROOT = path.join(EXTRACTION_ROOT, "phase1");

function documentBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function anchors(manifestBytes, manifestSchemaBytes) {
  return {
    expectedManifestRawSha256: sha256(manifestBytes),
    expectedManifestCanonicalSha256: sha256(Buffer.from(canonicalJson(JSON.parse(manifestBytes)))),
    expectedManifestSchemaRawSha256: sha256(manifestSchemaBytes),
    expectedManifestSchemaCanonicalSha256: sha256(Buffer.from(canonicalJson(JSON.parse(manifestSchemaBytes)))),
  };
}

async function corpusFixture() {
  const [manifestBytes, manifestSchemaBytes, corpusSchema] = await Promise.all([
    fs.readFile(path.join(EXTRACTION_ROOT, "manifest.v1.json")),
    fs.readFile(path.join(EXTRACTION_ROOT, "manifest.schema.json")),
    fs.readFile(path.join(PHASE1_ROOT, "corpus.schema.json"), "utf8").then(JSON.parse),
  ]);
  const manifest = JSON.parse(manifestBytes);
  const selectedCaseIds = manifest.fixtures.slice(0, 2).map(item => item.id);
  const fixtureBytesById = Object.fromEntries(await Promise.all(selectedCaseIds.map(async caseId => {
    const item = manifest.fixtures.find(candidate => candidate.id === caseId);
    return [caseId, await fs.readFile(path.join(EXTRACTION_ROOT, item.path))];
  })));
  const built = await buildRetainedPhase1Corpus({ manifestBytes, manifestSchemaBytes, selectedCaseIds, fixtureBytesById, trustedPrivacyClass: "public_synthetic", corpusSchema });
  return { ...built, corpusSchema, anchors: anchors(manifestBytes, manifestSchemaBytes) };
}

async function loadCorpus(built, descriptorBytes = built.artifacts.phase0_corpus.bytes, overrides = {}) {
  return loadRetainedPhase1Corpus({
    readArtifact: async role => {
      if (role !== "phase0_corpus") throw new Error(`unexpected role ${role}`);
      return descriptorBytes;
    },
    corpusSchema: built.corpusSchema,
    trustedPrivacyClass: "public_synthetic",
    ...built.anchors,
    ...overrides,
  });
}

describe("Phase 1 retained corpus trust boundary", () => {
  it("round-trips exact selected bytes and order through one bounded JSON envelope", async () => {
    const built = await corpusFixture();
    const retained = await loadCorpus(built);
    expect(retained.descriptor.selected_case_ids).toEqual(built.descriptor.selected_case_ids);
    for (const caseId of built.descriptor.selected_case_ids) expect(retained.fixtureBytesById[caseId]).toEqual(built.fixtureBytesById[caseId]);
  });

  it("rejects anchor, privacy, path, byte, page, and predecode-total tampering", async () => {
    const built = await corpusFixture();
    await expect(loadCorpus(built, undefined, { expectedManifestRawSha256: "0".repeat(64) })).rejects.toThrow(/anchors differ before embedded JSON compilation/);
    await expect(loadCorpus(built, undefined, { trustedPrivacyClass: "private_local" })).rejects.toThrow(/identity or claim boundary/);
    const mutants = [
      value => { value.fixtures[0].manifest_relative_path = "../secret.pdf"; },
      value => { value.fixtures[0].bytes_base64 = `${value.fixtures[0].bytes_base64.slice(0, -4)}AAAA`; },
      value => { value.fixtures[0].page_count += 1; },
      value => { value.total_fixture_bytes = 8 * 1024 * 1024; value.fixtures[0].bytes = 8 * 1024 * 1024; },
    ];
    for (const mutate of mutants) {
      const value = structuredClone(built.descriptor);
      mutate(value);
      await expect(loadCorpus(built, documentBytes(value))).rejects.toThrow();
    }
  });

  it("rejects an oversized whole envelope before JSON parsing", async () => {
    const built = await corpusFixture();
    await expect(loadCorpus(built, Buffer.alloc((16 * 1024 * 1024) + 1, 0x20))).rejects.toThrow(/independent byte ceiling/);
  });

  it("requires the exact corpus schema and enforces manifest ceilings before JSON parsing", async () => {
    const built = await corpusFixture();
    await expect(buildRetainedPhase1Corpus({
      manifestBytes: built.manifestBytes,
      manifestSchemaBytes: built.manifestSchemaBytes,
      selectedCaseIds: built.descriptor.selected_case_ids,
      fixtureBytesById: built.fixtureBytesById,
      trustedPrivacyClass: "public_synthetic",
    })).rejects.toThrow(/requires its exact descriptor schema/);
    await expect(buildRetainedPhase1Corpus({
      manifestBytes: Buffer.alloc(PHASE1_CORPUS_LIMITS.max_manifest_bytes + 1, 0x20),
      manifestSchemaBytes: built.manifestSchemaBytes,
      selectedCaseIds: built.descriptor.selected_case_ids,
      fixtureBytesById: built.fixtureBytesById,
      trustedPrivacyClass: "public_synthetic",
      corpusSchema: built.corpusSchema,
    })).rejects.toThrow(/byte ceiling/);
    expect(PHASE1_CORPUS_LIMITS.max_fixture_bytes).toBeLessThanOrEqual(PHASE1_CORPUS_LIMITS.max_total_fixture_bytes);
    expect(PHASE1_CORPUS_LIMITS.max_descriptor_bytes).toBe(16 * 1024 * 1024);
  });
});
