/**
 * Retirement state for agent-workflow protocol v3.
 *
 * v3 is a sealed, completed campaign. It ran 96 model inferences on
 * `gpt-5.6-sol` at source commit 2ec186d, produced 387 receipt records and a
 * signed anchor export, and returned execution integrity GO with semantic
 * safety, semantic utility, exact conformance, and bounded prompt effect all
 * NO_GO. That evidence is retained privately outside this repository.
 *
 * The protocol states its own invalidation rule:
 *
 *   "After the first model inference, any policy, case, schema, oracle,
 *    scorer, skill, schedule, controller, or prompt correction invalidates v3
 *    and requires a new protocol version."
 *
 * On 2026-07-24, commit 94d1cb4 edited the pinned workflow SKILL.md as part of
 * an unrelated product fix, growing it from 15,571 to 18,898 bytes. That is a
 * skill correction after first inference, so v3 is invalidated by its own terms
 * and a successor protocol is required.
 *
 * The consequence for this test suite is deliberate and must not be papered
 * over. `prepareAgentWorkflowCampaignV3` fails closed on the frozen skill
 * digest, so the preparation and campaign tests cannot pass against the current
 * tree. Updating FROZEN_SKILL_SHA256 to the current body would make them pass
 * while silently re-labelling a campaign that measured the 15,571-byte skill as
 * though it had measured a body it never saw. That is exactly the false-pass
 * this project's evaluation contract exists to prevent, so the constant stays
 * where it is and the affected tests are retired instead.
 *
 * Retirement is verified rather than assumed: `v3RetirementState` reports
 * whether the pinned skill still differs from the freeze. If someone restores
 * the frozen body, the retirement becomes stale and the suite says so instead
 * of skipping silently forever.
 *
 * The successor is tracked in bead pdf-toolkit-mcp-igr.2. A v4 protocol was
 * designed extensively in private evidence (revisions r2 through r15, including
 * canaries, a seatbelt proof, and no-model rehearsals) but has never landed in
 * this repository, so there is currently no runnable successor here.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const V3_SKILL_PATH = path.join(
  REPO_ROOT,
  "plugins",
  "pdf-tools-workflow",
  "skills",
  "pdf-tools-workflow",
  "SKILL.md",
);

/** The body v3 sealed against, recorded here so the drift is legible. */
export const V3_FROZEN_SKILL_BYTES = 15571;
export const V3_FROZEN_SKILL_SHA256 =
  "c782f69b209bb78af0aca5cb4659d01e64a6d9dc9ae68328ef9e547be6c22f4f";

export const V3_RETIREMENT_REASON =
  "Protocol v3 was invalidated by its own freeze rule when the pinned workflow "
  + "SKILL.md changed after first model inference (commit 94d1cb4). Its sealed "
  + "campaign evidence remains valid for the body it measured. A successor "
  + "protocol has not landed in this repository. See bead pdf-toolkit-mcp-igr.2.";

/**
 * Current retirement state.
 *
 * `retired` is true while the pinned skill differs from the sealed body, which
 * is the condition that invalidated v3. `stale` is true if the frozen body has
 * been restored, meaning this retirement should be revisited rather than kept.
 */
export async function v3RetirementState() {
  const body = await fs.readFile(V3_SKILL_PATH);
  const digest = createHash("sha256").update(body).digest("hex");
  const matchesFreeze = body.length === V3_FROZEN_SKILL_BYTES && digest === V3_FROZEN_SKILL_SHA256;
  return {
    skill_bytes: body.length,
    skill_sha256: digest,
    frozen_bytes: V3_FROZEN_SKILL_BYTES,
    matches_freeze: matchesFreeze,
    retired: !matchesFreeze,
    stale_retirement: matchesFreeze,
    reason: V3_RETIREMENT_REASON,
  };
}
