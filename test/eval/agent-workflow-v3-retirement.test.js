/**
 * Verifies the v3 retirement rather than assuming it.
 *
 * Two tests in the v3 preparation and campaign suites are skipped because the
 * protocol invalidated itself. A skip that nobody ever re-checks is how a
 * temporary state becomes permanent, so this asserts the condition that
 * justifies the skip and fails if that condition stops holding.
 */

import { describe, expect, it } from "vitest";
import {
  V3_FROZEN_SKILL_BYTES,
  V3_FROZEN_SKILL_SHA256,
  V3_RETIREMENT_REASON,
  v3RetirementState,
} from "./agent-workflow-v3-retirement.js";

describe("agent workflow v3 retirement", () => {
  it("still has a pinned skill body that differs from the v3 freeze", async () => {
    const state = await v3RetirementState();
    expect(state.retired).toBe(true);
    expect(state.matches_freeze).toBe(false);
    // The specific drift that invalidated v3, recorded so the skip is legible.
    expect(state.frozen_bytes).toBe(15571);
    expect(state.skill_bytes).not.toBe(V3_FROZEN_SKILL_BYTES);
    expect(state.skill_sha256).not.toBe(V3_FROZEN_SKILL_SHA256);
  });

  it("flags the retirement as stale if the frozen body is ever restored", async () => {
    const state = await v3RetirementState();
    // While the bodies differ this must stay false. If someone restores the
    // sealed SKILL.md, this flips and the retirement needs revisiting rather
    // than silently outliving its reason.
    expect(state.stale_retirement).toBe(false);
  });

  it("records why the protocol is retired instead of leaving a bare skip", async () => {
    const state = await v3RetirementState();
    expect(state.reason).toBe(V3_RETIREMENT_REASON);
    expect(state.reason).toMatch(/freeze rule/);
    expect(state.reason).toMatch(/pdf-toolkit-mcp-igr\.2/);
  });

  it("keeps the v3 freeze constant untouched", async () => {
    // Guards the tempting shortcut. Re-pointing the freeze at the current body
    // would make the skipped tests pass while presenting a sealed 96-run
    // campaign as evidence about a skill body it never saw.
    const { default: fs } = await import("node:fs/promises");
    const source = await fs.readFile(
      new URL("../../scripts/eval-prepare-agent-workflow-campaign-v3.mjs", import.meta.url),
      "utf8",
    );
    expect(source).toContain(`const FROZEN_SKILL_BYTES = ${V3_FROZEN_SKILL_BYTES};`);
    expect(source).toContain(V3_FROZEN_SKILL_SHA256);
  });
});
