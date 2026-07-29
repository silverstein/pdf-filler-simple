export const DIRECT_CHECKOUT_LOCAL_SCRATCH_ALLOCATORS = Object.freeze([
  Object.freeze({
    file: "scripts/dev-ui-rotated-sign-smoke.mjs",
    prefix: ".test-tmp-rotated-ui-",
    reason: "The development smoke test needs a source-relative allowed output.",
  }),
  Object.freeze({
    file: "test/helpers/temp-directory.js",
    prefix: ".test-tmp-${label}-",
    reason: "Central allocator for unique, owned checkout-local integration roots.",
  }),
]);

export const REAL_CHECKOUT_SOURCE_IDENTITY_BINDERS = Object.freeze([
  Object.freeze({
    file: "scripts/eval-prepare-agent-workflow-campaign.mjs",
    reason: "Binds verifiedCleanSourceCommit to the PDF Tools repository root.",
  }),
  Object.freeze({
    file: "scripts/run-all-test-suites.mjs",
    reason: "Binds aggregate preflight and partition barriers to the PDF Tools root.",
  }),
]);

export const SYNTHETIC_SOURCE_IDENTITY_IMPORTERS = Object.freeze([
  Object.freeze({
    file: "test/source-worktree-state.test.js",
    reason: "Exercises the generic checker only against unique repositories under the OS temp root.",
  }),
  Object.freeze({
    file: "test/fixtures/vitest-group-order/source-identity.fixture.mjs",
    reason: "Reproduces Git-visible interference only in a unique synthetic repository under the OS temp root.",
  }),
]);

export const SOURCE_IDENTITY_TRANSITIVE_MODULES = Object.freeze([
  Object.freeze({
    file: "scripts/eval-prepare-agent-workflow-campaign-v3.mjs",
    reason: "Retired v3 preparation delegates source identity to the real-checkout campaign binder.",
  }),
  Object.freeze({
    file: "scripts/eval-run-agent-workflow-campaign-v3.mjs",
    reason: "Retired v3 execution verifies source identity through the campaign binder.",
  }),
  Object.freeze({
    file: "scripts/eval-score-agent-workflow-campaign-v3.mjs",
    reason: "Retired v3 scoring verifies source identity through the campaign binder.",
  }),
]);

export const NON_EXECUTABLE_SOURCE_IDENTITY_REFERENCES = Object.freeze([
  Object.freeze({
    file: "test/eval/agent-workflow-v3-retirement.test.js",
    target: "scripts/eval-prepare-agent-workflow-campaign-v3.mjs",
    reason: "Reads the retired controller as source text through new URL; it does not execute the module.",
  }),
]);

export const CHECKOUT_LOCAL_MUTATING_TEST_SUITES = Object.freeze([
  "test/allowed-directories.test.js",
  "test/apply-page-plan.test.js",
  "test/atomic-output-recovery.test.js",
  "test/atomic-output.test.js",
  "test/atomic-tool-output.test.js",
  "test/csv-roundtrip.test.js",
  "test/deep-malformed-campaign.test.js",
  "test/detect-signature-zones-tool.test.js",
  "test/eval/codex-comparison-controller.test.js",
  "test/fetch-pdf-from-url.test.js",
  "test/fuzz-malformed-pdfs.test.js",
  "test/get-page-analysis.test.js",
  "test/golden-set-placement.test.js",
  "test/integration.test.js",
  "test/metadata-provenance.test.js",
  "test/mutation-input-limits.test.js",
  "test/render-pdf-page.test.js",
  "test/signatures.test.js",
  "test/temp-directory.test.js",
  "test/validate-pdf.test.js",
  "test/xfa-guards.test.js",
]);

export const REVIEWED_COMPUTED_MODULE_LOADS = Object.freeze([
  Object.freeze({
    file: "scripts/eval-calibrate-docling-supervisor.mjs",
    count: 1,
    reason: "Loads a content-addressed generated controller outside the source checkout.",
  }),
  Object.freeze({
    file: "scripts/eval-capture-docling-bakeoff.mjs",
    count: 2,
    reason: "Loads content-addressed file URLs and data URLs generated for authority capture.",
  }),
  Object.freeze({
    file: "scripts/eval-docling-authority.mjs",
    count: 1,
    reason: "Loads controller bytes through a generated data URL.",
  }),
  Object.freeze({
    file: "scripts/eval-run-codex-agent-workflow-case.mjs",
    count: 1,
    reason: "Loads a verified external attester file URL.",
  }),
  Object.freeze({
    file: "scripts/eval-verify-docling-macos-handoff.mjs",
    count: 1,
    reason: "Loads the explicitly supplied verifier URL.",
  }),
  Object.freeze({
    file: "scripts/generate-layout-encrypted-oracle.mjs",
    count: 1,
    reason: "Loads the selected generated qpdf module URL.",
  }),
  Object.freeze({
    file: "scripts/macos-claude-installed-smoke.mjs",
    count: 2,
    reason: "Loads an installed SDK by validated absolute file URL.",
  }),
  Object.freeze({
    file: "scripts/test-share-contract.mjs",
    count: 1,
    reason: "Loads a packaged share artifact from an isolated build root.",
  }),
  Object.freeze({
    file: "test/eval/extraction-docling-handoff.js",
    count: 1,
    reason: "Loads a verified generated controller outside the checkout.",
  }),
  Object.freeze({
    file: "test/eval/extraction-phase1-generation-verifiers.test.js",
    count: 2,
    reason: "Embedded verifier source loads manifest-authorized generated modules.",
  }),
  Object.freeze({
    file: "test/render-pdf-page.test.js",
    count: 1,
    reason: "Embedded subprocess source loads a test-owned server URL.",
  }),
  Object.freeze({
    file: "test/test-runner-contract.test.js",
    count: 2,
    reason: "In-memory adversarial fixtures prove computed dynamic imports are never silently ignored.",
  }),
  Object.freeze({
    file: "vendor/qpdf-wasm/smoke.mjs",
    count: 1,
    reason: "Loads the selected qpdf artifact from the vendor smoke directory.",
  }),
]);

export const SOURCE_IDENTITY_TEST_SUITES = Object.freeze([
  Object.freeze({
    file: "test/eval/agent-workflow-campaign-preparation.test.js",
    reason: "Exercises the v2 campaign clean-source identity gate.",
  }),
  Object.freeze({
    file: "test/eval/agent-workflow-repeated-campaign.test.js",
    reason: "Exercises the retired v2 campaign clean-source identity gate.",
  }),
  Object.freeze({
    file: "test/eval/agent-workflow-run-binding.test.js",
    reason: "Prepares exact-source campaign runs before binding their artifacts.",
  }),
  Object.freeze({
    file: "test/eval/agent-workflow-v3-campaign.test.js",
    reason: "Retains the retired v3 preparation, execution, and scoring gates.",
  }),
  Object.freeze({
    file: "test/eval/agent-workflow-v3-preparation.test.js",
    reason: "Retains the retired v3 clean-source preparation gate.",
  }),
  Object.freeze({
    file: "test/test-runner-contract.test.js",
    reason: "Imports the aggregate module that binds source checks to the real checkout.",
  }),
]);

export const SOURCE_IDENTITY_TEST_FILES = Object.freeze(
  SOURCE_IDENTITY_TEST_SUITES.map(suite => suite.file),
);
