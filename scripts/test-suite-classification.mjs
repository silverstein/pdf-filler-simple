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
]);

export const SOURCE_IDENTITY_TEST_FILES = Object.freeze(
  SOURCE_IDENTITY_TEST_SUITES.map(suite => suite.file),
);
