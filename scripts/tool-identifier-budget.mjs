/**
 * Tool-identifier budget for Claude Desktop host limits.
 *
 * Claude generates a namespaced identifier per tool from the extension's
 * human-facing `display_name`, not from the machine `name`:
 *
 *     mcp__<display_name with spaces underscored and non [A-Za-z0-9_-] stripped>__<tool_name>
 *
 * Identifiers longer than 64 characters fail in the host. That is not a
 * cosmetic limit: it shipped as a real defect (issue #44), where the original
 * benefit-led directory title pushed 13 of the current 40 tool identifiers past
 * the ceiling and broke tool exposure.
 *
 * The fix was a short packaged runtime brand, but the discovery value of a
 * descriptive title is real, so the naming strategy is dual:
 *
 *   - Packaged runtime `display_name`: the short brand `PDF Tools`.
 *   - Public directory card: the benefit-led title, kept as a separate value
 *     where the submission platform supports one.
 *   - If the platform ever forces a single shared value, the documented
 *     fallback is a compact benefit-led title that still fits the budget.
 *
 * The recurrence risk this module exists to catch is subtle: the shipped short
 * brand has generous headroom, so a newly added long tool name can silently
 * consume the *fallback* title's much smaller margin while every current test
 * stays green. Budgets are therefore evaluated for every candidate name, not
 * only the one currently shipped.
 */

/** Host ceiling for a generated tool identifier. */
export const MAX_TOOL_IDENTIFIER_LENGTH = 64;

/** Fixed overhead in `mcp__<name>__<tool>`. */
const IDENTIFIER_PREFIX = "mcp__";
const IDENTIFIER_SEPARATOR = "__";

/**
 * Reproduces the host's namespace normalization of `display_name`.
 * Spaces become underscores; everything outside [A-Za-z0-9_-] is dropped.
 */
export function normalizeDisplayName(displayName) {
  return String(displayName)
    .replaceAll(" ", "_")
    .replace(/[^a-zA-Z0-9_-]/g, "");
}

/** The exact identifier the host will generate for one tool. */
export function generateToolIdentifier(displayName, toolName) {
  return `${IDENTIFIER_PREFIX}${normalizeDisplayName(displayName)}${IDENTIFIER_SEPARATOR}${toolName}`;
}

/**
 * Budget report for one candidate display name against a tool-name set.
 * `headroom` is how many characters the longest tool name may still grow by
 * before this candidate breaks the host limit.
 */
export function computeToolIdentifierBudget(displayName, toolNames) {
  const identifiers = toolNames.map(toolName => ({
    toolName,
    identifier: generateToolIdentifier(displayName, toolName),
  }));
  const overLimit = identifiers.filter(
    entry => entry.identifier.length > MAX_TOOL_IDENTIFIER_LENGTH,
  );
  const longest = identifiers.reduce(
    (worst, entry) => (entry.identifier.length > worst.identifier.length ? entry : worst),
    identifiers[0],
  );
  return {
    displayName,
    normalized: normalizeDisplayName(displayName),
    longestToolName: longest.toolName,
    longestIdentifier: longest.identifier,
    longestIdentifierLength: longest.identifier.length,
    headroom: MAX_TOOL_IDENTIFIER_LENGTH - longest.identifier.length,
    overLimit: overLimit.map(entry => entry.toolName),
    fits: overLimit.length === 0,
  };
}

/**
 * Naming candidates under active governance.
 *
 * `shipped` is the packaged runtime value and must always fit. `fallback` is
 * the documented single-field directory title and must also always fit, so the
 * option stays available without a further host experiment. `rejected` is kept
 * deliberately: it is the original title whose breakage is the regression this
 * module pins, and asserting that it still fails proves the budget math is
 * actually measuring something.
 */
export const DISPLAY_NAME_CANDIDATES = Object.freeze({
  shipped: "PDF Tools",
  fallback: "PDF Tools: Fill, Sign & Edit",
  rejected: "PDF Tools - Fill, Sign, Merge, Split, Extract",
});

/**
 * Minimum characters of growth the single-field fallback must preserve.
 * Guards the realistic failure mode: a new tool name longer than today's
 * `convert_pdf_to_markdown` quietly eating the fallback's margin.
 */
export const MIN_FALLBACK_HEADROOM = 5;
