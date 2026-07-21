#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { assertEvidenceOnlyDescendant, assertPrivacySafeProjection } from "./eval-comparison-evidence-integrity.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_DIRECTORY = path.resolve(
  process.argv[2] ?? path.join(REPO_ROOT, "docs", "evidence", "comparison-v1"),
);
const DECISION_SCHEMA_PATH = path.join(
  REPO_ROOT, "test", "fixtures", "eval", "comparison", "decision.schema.json",
);
const AGENT_EVIDENCE_SCHEMA_PATH = path.join(
  REPO_ROOT, "test", "fixtures", "eval", "comparison", "agent-evidence-summary.schema.json",
);
const GENERATED_EVIDENCE_PREFIX = `${path.relative(REPO_ROOT, EVIDENCE_DIRECTORY).replaceAll("\\", "/")}/`;

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readEvidenceJson(name) {
  return JSON.parse(await fs.readFile(path.join(EVIDENCE_DIRECTORY, name), "utf8"));
}

async function bindingForFile(filePath) {
  const bytes = await fs.readFile(filePath);
  return { path: path.relative(REPO_ROOT, filePath), sha256: digest(bytes), bytes: bytes.length };
}

async function sourceBinding(relativePath) {
  return bindingForFile(path.join(REPO_ROOT, relativePath));
}

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function dirtySourcePaths() {
  return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .map(line => line.slice(3).split(" -> ").at(-1).replaceAll("\\", "/"))
    .filter(file => file !== "node_modules" && !file.startsWith(GENERATED_EVIDENCE_PREFIX))
    .sort();
}

const headRevision = git(["rev-parse", "HEAD"]);
const sourceDirtyPaths = dirtySourcePaths();
if (sourceDirtyPaths.length > 0) {
  throw new Error(`Refusing to build a decision from dirty source paths:\n${sourceDirtyPaths.join("\n")}`);
}

const runIndex = await readEvidenceJson("run-index.v1.json");
const shared = await readEvidenceJson("shared-library-score.v1.json");
const product = await readEvidenceJson("current-product-score.v1.json");
const poppler = await readEvidenceJson("poppler-sensor.v1.json");
const agentSummary = await readEvidenceJson("codex-agent-evidence-summary.v1.json");
const agentReport = await readEvidenceJson("codex-trajectory-report.v1.json");
git(["merge-base", "--is-ancestor", runIndex.source_revision, headRevision]);
const descendantPaths = git(["diff", "--name-only", `${runIndex.source_revision}..${headRevision}`])
  .split("\n").filter(Boolean);
assertEvidenceOnlyDescendant({
  sourceRevision: runIndex.source_revision,
  headRevision,
  changedPaths: descendantPaths,
  evidenceDirectory: path.relative(REPO_ROOT, EVIDENCE_DIRECTORY),
});
git(["merge-base", "--is-ancestor", agentSummary.source_revision, runIndex.source_revision]);

const agentEvidenceSchema = JSON.parse(await fs.readFile(AGENT_EVIDENCE_SCHEMA_PATH, "utf8"));
const agentAjv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
agentAjv.addFormat("date-time", value => Number.isFinite(Date.parse(value)));
const validateAgentEvidence = agentAjv.compile(agentEvidenceSchema);
if (!validateAgentEvidence(agentSummary)) {
  throw new Error(`Agent evidence summary JSON Schema validation failed: ${JSON.stringify(validateAgentEvidence.errors)}`);
}
assertPrivacySafeProjection(agentSummary);
const agentReportBytes = await fs.readFile(path.join(EVIDENCE_DIRECTORY, "codex-trajectory-report.v1.json"));
if (agentSummary.source_digests.trajectory_report_sha256 !== digest(agentReportBytes)
  || agentSummary.trial_set_id !== agentReport.trial_set_id) {
  throw new Error("Codex evidence projection is not bound to the retained trajectory report");
}
if (agentReport.attempted_trials !== 3
  || agentReport.product_trials !== 3
  || agentReport.harness_failures !== 0
  || agentReport.passed_trials !== 3
  || agentReport.product_statistics?.pass_rate !== 1
  || agentReport.product_statistics?.sample_variance !== 0
  || agentReport.trust_ready !== false
  || agentReport.independence_ready !== false
  || agentReport.harness_ready !== false
  || agentReport.sample_size_ready !== false
  || agentReport.benchmark_claim_ready !== false) {
  throw new Error("Codex trajectory report exceeds or contradicts its descriptive three-run claim boundary");
}

const evidenceBindings = [];
for (const artifact of runIndex.artifacts) {
  const actual = await bindingForFile(path.resolve(REPO_ROOT, artifact.path));
  if (actual.sha256 !== artifact.sha256 || actual.bytes !== artifact.bytes) {
    throw new Error(`Run-index binding mismatch for ${artifact.path}`);
  }
  evidenceBindings.push(actual);
}
evidenceBindings.push(await bindingForFile(path.join(EVIDENCE_DIRECTORY, "run-index.v1.json")));
for (const name of [
  "codex-agent-evidence-summary.v1.json",
  "codex-trajectory-report.v1.json",
]) {
  evidenceBindings.push(await bindingForFile(path.join(EVIDENCE_DIRECTORY, name)));
}

const sourceBindingPaths = [
  "docs/COMPARISON_EVALUATION.md",
  "docs/evidence/comparison-v1/README.md",
  "scripts/eval-generate-comparison-fixtures.mjs",
  "scripts/eval-run-comparison-baselines.mjs",
  "scripts/eval-build-comparison-decision.mjs",
  "scripts/eval-comparison-evidence-integrity.mjs",
  "scripts/eval-summarize-codex-comparison.mjs",
  "scripts/eval-run-codex-comparison.mjs",
  "scripts/eval-ingest-codex-trajectory.mjs",
  "scripts/eval-run-trajectories.mjs",
  "server/index.js",
  "test/fixtures/eval/comparison/manifest.v1.json",
  "test/fixtures/eval/comparison/manifest.schema.json",
  "test/fixtures/eval/comparison/report.schema.json",
  "test/fixtures/eval/comparison/decision.schema.json",
  "test/fixtures/eval/comparison/agent-evidence-summary.schema.json",
  "test/eval/comparison-manifest.js",
  "test/eval/comparison-observations.js",
  "test/eval/comparison-schema-ajv.js",
  "test/eval/comparison-observation-registry.js",
  "test/eval/comparison-scorer.js",
  "test/eval/comparison-reference-baseline.js",
  "test/eval/comparison-product-baseline.js",
  "test/eval/comparison-poppler-baseline.js",
  "test/eval/comparison-agent-evidence.test.js",
  "test/eval/png-evidence.js",
  "test/eval/render-visual-oracle.js",
  "test/eval/trajectory-grader.js",
  "test/fixtures/eval/trajectories/jobs.v1.json",
  "test/fixtures/eval/trajectories/tool-contracts.v1.json",
  "test/fixtures/eval/trajectories/trust-registry.v1.json",
];

const channelDecision = channel => ({
  channel,
  shared_library: shared.aggregate.channel_metrics[channel],
  current_product: product.aggregate.channel_metrics[channel],
  recommendation: ({
    semantic: "Research deterministic typed change atoms first; evaluate a calibrated model only for relation, materiality, and explanation.",
    text: "Prototype localized text spans with bidirectional source regions; page-level text alone is insufficient evidence.",
    structure: "Evaluate the current page-marker/order primitive against ambiguous, inserted, deleted, and duplicate pages.",
    form_field: "Prototype field widget page, rectangle, flags, options, and appearance/value disagreement as a read-only observation.",
    annotation: "Prototype read-only annotation enumeration with subtype, content/action, flags, page, rectangle/quadpoints, and stable raw digest.",
    metadata: "Prototype actual Info/XMP values and disagreement reporting; the current summary is not metadata evidence.",
    visual: "Version generic retained render observations with exact image/result digest, source hash, page, box, rotation, region, renderer, dimensions, and scale.",
  })[channel],
});

const decision = {
  schema_version: 1,
  decision_id: "pdf-tools.comparison-decision.v1",
  benchmark_id: shared.benchmark_id,
  benchmark_version: shared.benchmark_version,
  generated_at: runIndex.generated_at,
  source_revision: runIndex.source_revision,
  source_state: {
    clean_except_generated_evidence: true,
    excluded_paths: [path.relative(REPO_ROOT, EVIDENCE_DIRECTORY), "node_modules"],
    dirty_source_paths: [],
  },
  status: "measurement_blocked",
  benchmark_claim_ready: false,
  claim_boundary: "Provisional measurements on seven public synthetic pairs on Linux plus three unsigned descriptive headless Codex repetitions of one compare-and-explain fixture. Neither baseline lane enforced truth, shell, or network isolation, and the controller registry is unsigned. The shared-library result is not independent confirmation; the product and agent lanes are not the packed MCPB or native Claude Desktop; Poppler is an unscored external sensor; the three agent repetitions share one fixture and are not independent benchmark evidence. No product architecture or release is approved by this artifact.",
  frozen_release_candidate: {
    mcpb_sha256: "b586221595cc3095d43f73daf3b66c6cc9695bddcd98365f46c445a597d9a1b4",
    bytes: 72456666,
    modified_by_this_benchmark: false,
  },
  source_bindings: await Promise.all(sourceBindingPaths.map(sourceBinding)),
  evidence_bindings: evidenceBindings,
  measured_results: {
    shared_library_reference: {
      passed: shared.passed,
      isolation_passed: shared.aggregate.isolation_passed,
      pairs: `${shared.aggregate.pairs_passed}/${shared.aggregate.pairs_total}`,
      event_f1: shared.aggregate.event_metrics.f1,
      evidence_completeness: shared.aggregate.evidence_metrics.completeness,
      independence: false,
    },
    current_published_primitives: {
      passed: product.passed,
      isolation_passed: product.aggregate.isolation_passed,
      pairs: `${product.aggregate.pairs_passed}/${product.aggregate.pairs_total}`,
      event_f1: product.aggregate.event_metrics.f1,
      evidence_completeness: product.aggregate.evidence_metrics.completeness,
      material_event_recall: product.aggregate.material_event_recall,
      model_cost_usd: product.aggregate.model_cost_usd,
      network_requests: product.aggregate.network_requests,
    },
    poppler_external_sensor: {
      engine_status: poppler.engine_status,
      pairs_observed: poppler.pairs.length,
      event_level_scored: false,
      bundled: poppler.engine?.bundled ?? false,
    },
    agent_trials: {
      status: "descriptive_three_run_comparison_complete",
      job_id: "pdf-tools.trajectory.v1.compare-and-explain",
      model: agentSummary.model,
      source_revision: agentSummary.source_revision,
      attempted_trials: agentReport.attempted_trials,
      product_trials: agentReport.product_trials,
      harness_failures: agentReport.harness_failures,
      passed_trials: agentReport.passed_trials,
      pass_rate: agentReport.product_statistics.pass_rate,
      variance: agentReport.product_statistics.sample_variance,
      native_host: false,
      packed_mcpb: false,
      trust_ready: agentReport.trust_ready,
      independence_ready: agentReport.independence_ready,
      full_suite_harness_ready: agentReport.harness_ready,
      sample_size_ready: agentReport.sample_size_ready,
      benchmark_claim_ready: agentReport.benchmark_claim_ready,
    },
  },
  provisional_research_directions: {
    channels: [
      "semantic", "text", "structure", "form_field", "annotation", "metadata", "visual",
    ].map(channelDecision),
    tool_primitives: "Evaluate a local deterministic compare_pdfs prototype over versioned observation interfaces. It should return raw typed changes, coverage, uncertainty, detector versions, reversible suppression, and evidence on both documents. Do not put a model inside the MCPB without separate evidence.",
    agent_explanation: "Evaluate whether the host agent can rank and explain deterministic change atoms while preserving uncertainty and unavailable channels and citing evidence IDs. Model prose cannot repair deterministic misses.",
    viewer_ux: "Research a side-by-side review surface with synchronized pages, overlays, filters, raw-versus-normalized views, and evidence navigation before claiming end-user comparison quality.",
  },
  prioritized_actions: [
    {
      priority: 0,
      action: "build_and_measure",
      item: "generic_render_observation",
      rationale: `The current product detected raster differences but scored ${product.aggregate.channel_metrics.visual.tp} TP / ${product.aggregate.channel_metrics.visual.fn} FN because encoded PNG outputs are not retained canonical region evidence.`,
    },
    {
      priority: 0,
      action: "build_and_measure",
      item: "metadata_annotation_and_field_geometry_observations",
      rationale: "Current product misses are structurally unavoidable without these read-only interfaces.",
    },
    {
      priority: 1,
      action: "prototype_and_benchmark",
      item: "deterministic_compare_pdfs",
      rationale: `The provisional shared-library composition detected ${shared.aggregate.event_metrics.tp} events while published primitives detected ${product.aggregate.event_metrics.tp}; this small unisolated slice motivates measurement, not a shipping decision.`,
    },
    {
      priority: 1,
      action: "research_and_test",
      item: "side_by_side_evidence_viewer",
      rationale: "Human verification requires source-linked before/after overlays and reversible noise filters.",
    },
    {
      priority: 1,
      action: "measure",
      item: "expand_agent_jobs_then_twenty_release_trials",
      rationale: "The compare-and-explain job passed three predeclared descriptive repetitions, but the other five jobs, independent fixtures, native hosts, and release-scale trials remain unmeasured.",
    },
    {
      priority: 2,
      action: "research",
      item: "PDFBox_qpdf_and_64_pair_expansion",
      rationale: "Poppler confirms independent sensor availability but is not an event oracle; broader independent and adversarial coverage is required.",
    },
    {
      priority: 3,
      action: "defer",
      item: "pdfjs_upgrade_or_bundled_external_engine",
      rationale: "The protected PDF.js 5.4.624 pin remains necessary for Claude Desktop, and Poppler must not enter the MIT MCPB without separate compatibility and license review.",
    },
  ],
  blockers: [
    "truth, shell, and network isolation are not OS-enforced for either scored lane",
    "the controller observation registry has no independent signature or attestation",
    "only one agent job has three shared-fixture repetitions; the other five jobs and independent samples remain unmeasured",
    "native Claude Desktop and Windows evidence are absent",
    "the corpus is a seven-pair public synthetic slice, not a release corpus",
  ],
  release_gates: {
    product_code_changed: false,
    rebuild_required: false,
    native_claude_desktop_required_before_release: true,
    windows_required_before_release: true,
    human_approval_required: true,
  },
};

const decisionSchema = JSON.parse(await fs.readFile(DECISION_SCHEMA_PATH, "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
const validateDecision = ajv.compile(decisionSchema);
if (!validateDecision(decision)) {
  throw new Error(`Decision JSON Schema validation failed: ${JSON.stringify(validateDecision.errors)}`);
}

await fs.mkdir(EVIDENCE_DIRECTORY, { recursive: true });
const decisionPath = path.join(EVIDENCE_DIRECTORY, "comparison-decision.v1.json");
await fs.writeFile(decisionPath, `${JSON.stringify(decision, null, 2)}\n`);

const markdown = `# PDF comparison v1 measurement decision\n\n` +
  `Status: **measurement blocked**. Benchmark/public claim readiness is **false**. No product architecture or release is approved.\n\n` +
  `The provisional shared-library reference passed ${decision.measured_results.shared_library_reference.pairs} pair-level gates, ` +
  `while current published MCP primitives passed ${decision.measured_results.current_published_primitives.pairs}. ` +
  `Neither report passed the global isolation gate. Current event F1 is ${decision.measured_results.current_published_primitives.event_f1.toFixed(3)} and evidence completeness is ` +
  `${(decision.measured_results.current_published_primitives.evidence_completeness * 100).toFixed(1)}%. ` +
  `The shared result is an implementation reference, not independent confirmation. Poppler status is ` +
  `\`${decision.measured_results.poppler_external_sensor.engine_status}\` and remains an unscored external sensor.\n\n` +
  `## Provisional direction\n\n` +
  `First version the generic render observation and add read-only metadata, annotation, and field-geometry observations. Then measure a deterministic local \`compare_pdfs\` prototype, host-agent explanations, and a source-linked side-by-side viewer. Do not upgrade the protected PDF.js pin or bundle Poppler in this tranche.\n\n` +
  `## Measured gaps\n\n` +
  `- Current visual facets: ${product.aggregate.channel_metrics.visual.tp} TP / ${product.aggregate.channel_metrics.visual.fn} FN. Encoded PNGs are useful to a model but are not canonical retained region evidence.\n` +
  `- Current metadata: ${product.aggregate.channel_metrics.metadata.fn} FN; actual Info/XMP values are not exposed.\n` +
  `- Current annotations: ${product.aggregate.channel_metrics.annotation.fn} FN; annotation enumeration is absent.\n` +
  `- Current form fields: ${product.aggregate.channel_metrics.form_field.fn} FN; values lack widget page/geometry evidence.\n` +
  `- Agent comparison repetitions: ${agentReport.passed_trials}/${agentReport.product_trials} product trials passed, with variance ${agentReport.product_statistics.sample_variance} and ${agentReport.harness_failures} harness failures. These shared-fixture headless repetitions are descriptive, unsigned, and not independent benchmark or native-host evidence.\n\n` +
  `## Evidence boundary\n\n` +
  `The source tree was clean at revision \`${runIndex.source_revision}\` except generated evidence and the shared dependency symlink. Evidence files are hash-bound, but the raw Codex evidence is retained privately and the controller registry is unsigned. Truth, shell, and network isolation were not OS-enforced, so the reports are descriptive and cannot support a benchmark claim.\n\n` +
  `## Release boundary\n\n` +
  `This benchmark changed no runtime, package, manifest, UI, or MCPB bytes. The frozen candidate remains \`${decision.frozen_release_candidate.mcpb_sha256}\`. Native Claude Desktop, Windows, and human approval remain release gates.\n`;
await fs.writeFile(path.join(EVIDENCE_DIRECTORY, "comparison-decision.v1.md"), markdown);
process.stdout.write(`${JSON.stringify({
  decision: path.relative(REPO_ROOT, decisionPath),
  sha256: digest(await fs.readFile(decisionPath)),
  status: decision.status,
  benchmark_claim_ready: decision.benchmark_claim_ready,
}, null, 2)}\n`);
