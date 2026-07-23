import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareAgentWorkflowCampaign,
} from "../../scripts/eval-prepare-agent-workflow-campaign.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })));
});

describe("repeated agent workflow campaign", () => {
  it("keeps the historical v2 repeated campaign frozen instead of reinterpreting it", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "pdf-workflow-repeated-")),
    );
    roots.push(root);

    await expect(prepareAgentWorkflowCampaign({
      participantsDestination: path.join(root, "participants"),
      oracleDestination: path.join(root, "oracle"),
      protocolId: "inline-full-body-heldout-v2",
    })).rejects.toThrow(
      /inline-full-body-heldout-v2 requires its exact frozen PDF workflow skill body/,
    );
  });
});
