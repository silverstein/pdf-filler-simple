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
