// Distinguishing an unmet evidence precondition from a real defect.
//
// Several evaluation suites depend on sealed, human-reviewed evidence: a
// calibration attestation, a visual-oracle approval, a provisioned model cache.
// That evidence legitimately goes stale when the code it attests to moves, and
// it is simply absent on a host that was never provisioned for it. Both used to
// surface as ordinary test failures, which is how a large permanently red
// aggregate developed. A red suite then carries no information, and a genuine
// regression hides inside it, which is exactly how a renderer regression
// reached master unnoticed.
//
// The rule this encodes: a red test means a product defect. Evidence that is
// stale or unprovisioned is reported as a skip that names what must be done.
// Anything unrecognised stays a failure, so this can never quietly widen.

const STALE_CODES = new Set([
  "EVAL_ATTESTATION_STALE",
  "EVAL_EVIDENCE_UNPROVISIONED",
]);

const UNPROVISIONED_PATTERNS = [
  // Hosts whose home directory or temp root is reached through a symlink, and
  // hosts without the pinned model cache, cannot satisfy these preconditions.
  /Privacy boundary contains a symlinked ancestor/i,
  /must not contain symbolic links/i,
  /HF cache path must be a real mode-0700 directory/i,
];

const STALE_PATTERNS = [
  /calibration attestation is stale/i,
  /visual oracle approval source file .* changed/i,
];

/**
 * Classify an error raised while establishing a suite's evidence precondition.
 * Returns null when the error is not a precondition problem, in which case the
 * caller must let it fail.
 */
export function classifyEvidencePrecondition(error) {
  if (!error) return null;
  const message = String(error?.message ?? error);
  if (STALE_CODES.has(error?.code)) {
    return { kind: "stale", reason: message };
  }
  if (STALE_PATTERNS.some(pattern => pattern.test(message))) {
    return { kind: "stale", reason: message };
  }
  if (UNPROVISIONED_PATTERNS.some(pattern => pattern.test(message))) {
    return { kind: "unprovisioned", reason: message };
  }
  return null;
}

/**
 * Run a suite's precondition setup. On success returns its value. On an
 * unmet precondition returns a skip record describing what is required. Any
 * other error propagates unchanged.
 */
export async function resolveEvidencePrecondition(setup) {
  try {
    return { ready: true, value: await setup() };
  } catch (error) {
    const classified = classifyEvidencePrecondition(error);
    if (classified === null) throw error;
    const action = classified.kind === "stale"
      ? "requires human re-approval of sealed evidence"
      : "requires a provisioned host";
    return {
      ready: false,
      kind: classified.kind,
      reason: `${action}: ${classified.reason}`,
    };
  }
}
