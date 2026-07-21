import path from "node:path";

const REVISION_PATTERN = /^[a-f0-9]{40}$/;

export function assertPrivacySafeProjection(value) {
  const serialized = JSON.stringify(value);
  const forbidden = [
    /\/(?:home|Users)\//,
    /(?:^|[^a-z])silvercloud(?:[^a-z]|$)/i,
    /(?:HOME|LOGNAME|PATH|USER|OPENAI_API_KEY)/,
    /Documents\//,
    /codex\.jsonl/,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(serialized)) {
      throw new Error(`Public projection contains forbidden host detail: ${pattern}`);
    }
  }
}

export function assertEvidenceOnlyDescendant({
  sourceRevision,
  headRevision,
  changedPaths,
  evidenceDirectory = "docs/evidence/comparison-v1",
}) {
  if (!REVISION_PATTERN.test(sourceRevision) || !REVISION_PATTERN.test(headRevision)) {
    throw new Error("Evidence source and HEAD revisions must be full lowercase Git object IDs");
  }
  const prefix = `${evidenceDirectory.replaceAll("\\", "/").replace(/\/$/, "")}/`;
  const normalized = changedPaths.map(value => value.replaceAll("\\", "/"));
  const outsideEvidence = normalized.filter(value => !value.startsWith(prefix));
  if (outsideEvidence.length > 0) {
    throw new Error(`Evidence source has non-evidence descendants:\n${outsideEvidence.join("\n")}`);
  }
  if (normalized.some(value => path.posix.normalize(value) !== value || value.includes("../"))) {
    throw new Error("Evidence descendant path is not normalized");
  }
}
