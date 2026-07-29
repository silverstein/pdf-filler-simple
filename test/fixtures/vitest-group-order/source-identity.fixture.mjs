import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const stateRoot = process.env.PDF_TOOLS_VITEST_ORDER_STATE;
if (!stateRoot || !path.isAbsolute(stateRoot)) {
  throw new Error("PDF_TOOLS_VITEST_ORDER_STATE must be an absolute path");
}

const observation = {
  completeAtStart: fs.existsSync(path.join(
    stateRoot,
    "ordinary-teardown-complete",
  )),
  activeAtStart: fs.existsSync(path.join(stateRoot, "ordinary-active")),
  teardownStartedAtStart: fs.existsSync(path.join(
    stateRoot,
    "ordinary-teardown-started",
  )),
};
fs.writeFileSync(
  path.join(stateRoot, "source-observation.json"),
  `${JSON.stringify(observation)}\n`,
  { flag: "wx" },
);

if (
  !observation.completeAtStart
  || observation.activeAtStart
  || !observation.teardownStartedAtStart
) {
  throw new Error("VITEST_GROUP_ORDER_BARRIER_VIOLATION");
}

it("starts source identity only after ordinary teardown", () => {
  expect(observation).toEqual({
    completeAtStart: true,
    activeAtStart: false,
    teardownStartedAtStart: true,
  });
});
