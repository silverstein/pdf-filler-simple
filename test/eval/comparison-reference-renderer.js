import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rendererFingerprint } from "./comparison-observations.js";

const SHA256 = /^[a-f0-9]{64}$/;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const COMPARISON_REFERENCE_RENDERER_PATH = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "comparison",
  "reference-renderer.v1.json",
);

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    throw new Error(`${label} keys must be exactly ${required.join(", ")}`);
  }
}

export async function loadComparisonReferenceRenderer(
  filePath = COMPARISON_REFERENCE_RENDERER_PATH,
) {
  const bytes = await fs.readFile(filePath);
  const profile = JSON.parse(bytes);
  exactKeys(profile, [
    "benchmark_id",
    "benchmark_version",
    "claim_boundary",
    "corpus_manifest_sha256",
    "historical_report_hosts",
    "installed",
    "platform",
    "provenance",
    "renderer_fingerprint_sha256",
    "schema_version",
  ], "Comparison reference renderer");
  exactKeys(profile.platform, ["arch", "napi", "node", "os"], "Reference platform");
  exactKeys(profile.installed, ["canvas", "pdfjs_dist"], "Reference installed packages");
  exactKeys(profile.historical_report_hosts, ["current_product", "shared_library"], "Historical report hosts");
  exactKeys(profile.provenance, [
    "limitation",
    "native_canvas_binary_sha256",
    "run_index",
    "shared_library_report",
    "source_revision",
    "standard_font_tree_sha256",
  ], "Reference provenance");
  if (profile.schema_version !== 1
    || typeof profile.benchmark_version !== "string"
    || !profile.benchmark_version) {
    throw new Error("Comparison reference renderer version is unsupported");
  }
  if (typeof profile.benchmark_id !== "string" || !profile.benchmark_id
    || typeof profile.claim_boundary !== "string" || !profile.claim_boundary) {
    throw new Error("Comparison reference renderer benchmark identity is invalid");
  }
  if (!SHA256.test(profile.renderer_fingerprint_sha256)
    || !SHA256.test(profile.corpus_manifest_sha256)) {
    throw new Error("Comparison reference renderer digests must be SHA-256");
  }
  if (!/^[a-f0-9]{40}$/.test(profile.provenance.source_revision)) {
    throw new Error("Comparison reference renderer source revision must be a full Git SHA");
  }
  if (profile.provenance.native_canvas_binary_sha256 !== null
    || profile.provenance.standard_font_tree_sha256 !== null
    || typeof profile.provenance.limitation !== "string"
    || !profile.provenance.limitation) {
    throw new Error("Comparison reference renderer must preserve the explicit v1 artifact-digest limitation");
  }
  for (const field of ["run_index", "shared_library_report"]) {
    const value = profile.provenance[field];
    if (typeof value !== "string" || value.length > 256 || path.isAbsolute(value)
      || value !== value.normalize("NFC") || value.split("/").some(part => !part || part === "." || part === "..")
      || !value.startsWith("docs/evidence/comparison-v1/")) {
      throw new Error(`Reference provenance path ${field} is invalid`);
    }
  }
  for (const [name, value] of Object.entries(profile.historical_report_hosts)) {
    if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(value)) {
      throw new Error(`Historical report host ${name} is invalid`);
    }
  }
  return profile;
}

export function assertComparisonBenchmarkBinding(manifest, reference) {
  if (manifest.benchmark_id !== reference.benchmark_id
    || manifest.benchmark_version !== reference.benchmark_version) {
    throw new Error("Comparison reference renderer does not bind the loaded benchmark");
  }
}

export function requireComparisonReportHostLabel(environment = process.env) {
  const label = environment.PDF_TOOLS_COMPARISON_HOST_LABEL;
  if (typeof label !== "string" || label.length > 80
    || !/^[a-z0-9][a-z0-9-]*$/.test(label)) {
    throw new Error("PDF_TOOLS_COMPARISON_HOST_LABEL must be an explicit public-safe host label");
  }
  return label;
}

export function comparisonRendererIdentity(renderer) {
  return {
    renderer_fingerprint_sha256: rendererFingerprint(renderer),
    platform: {
      os: process.platform,
      arch: process.arch,
      node: process.version,
      napi: process.versions.napi ?? null,
    },
    installed: {
      pdfjs_dist: renderer.pdfjs_dist,
      canvas: renderer.canvas,
    },
  };
}

export function classifyComparisonRenderer(renderer, reference) {
  const actual = comparisonRendererIdentity(renderer);
  const mismatches = [];
  if (actual.renderer_fingerprint_sha256 !== reference.renderer_fingerprint_sha256) {
    mismatches.push("renderer_fingerprint_sha256");
  }
  for (const field of ["os", "arch", "node", "napi"]) {
    if (actual.platform[field] !== reference.platform[field]) mismatches.push(`platform.${field}`);
  }
  for (const field of ["pdfjs_dist", "canvas"]) {
    if (actual.installed[field] !== reference.installed[field]) mismatches.push(`installed.${field}`);
  }
  return {
    exact_reference: mismatches.length === 0,
    mismatches,
    actual,
  };
}

export function assertExactComparisonReferenceRenderer(renderer, reference) {
  const classification = classifyComparisonRenderer(renderer, reference);
  if (!classification.exact_reference) {
    throw new Error(
      `Canonical comparison evidence requires the frozen reference renderer; mismatches: ${classification.mismatches.join(", ")}`,
    );
  }
  return classification.actual;
}

export function assertFrozenComparisonReferenceScore(scored) {
  const aggregate = scored?.aggregate;
  const exact = scored?.valid === true
    && aggregate?.event_metrics?.tp === 9
    && aggregate.event_metrics.fp === 0
    && aggregate.event_metrics.fn === 0
    && aggregate.evidence_metrics?.expected_anchors === 27
    && aggregate.evidence_metrics.matched_anchors === 27
    && aggregate.evidence_metrics.two_sided_facets === 13
    && aggregate.evidence_metrics.two_sided_complete === 13
    && aggregate.pairs_passed === 7
    && aggregate.pairs_total === 7;
  if (!exact) {
    throw new Error("Shared report did not reproduce the complete frozen v1 reference score");
  }
}

export async function assertComparisonManifestBinding(manifestPath, reference) {
  const bytes = await fs.readFile(manifestPath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== reference.corpus_manifest_sha256) {
    throw new Error(
      `Comparison manifest digest ${digest} does not match frozen reference ${reference.corpus_manifest_sha256}`,
    );
  }
  return digest;
}
