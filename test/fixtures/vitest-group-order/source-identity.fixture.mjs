import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { verifiedCleanSourceCommit } from "../../../scripts/source-worktree-state.mjs";

const stateRoot = process.env.PDF_TOOLS_VITEST_ORDER_STATE;
const repositoryRoot = process.env.PDF_TOOLS_VITEST_ORDER_REPOSITORY;
if (!stateRoot || !path.isAbsolute(stateRoot)) {
  throw new Error("PDF_TOOLS_VITEST_ORDER_STATE must be an absolute path");
}
if (!repositoryRoot || !path.isAbsolute(repositoryRoot)) {
  throw new Error("PDF_TOOLS_VITEST_ORDER_REPOSITORY must be an absolute path");
}
const control = process.env.PDF_TOOLS_VITEST_ORDER_CONTROL;
if (control === "overlap") {
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(path.join(
    stateRoot,
    "ordinary-git-interference-ready",
  ))) {
    if (Date.now() >= deadline) {
      throw new Error("ordinary Git interference did not become ready");
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (!fs.existsSync(path.join(repositoryRoot, "ordinary-untracked.txt"))) {
    throw new Error("ordinary Git interference marker preceded its artifact");
  }
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

let sourceVerificationError = null;
try {
  await verifiedCleanSourceCommit(repositoryRoot, {
    label: "overlap synthetic source worktree",
  });
} catch (error) {
  sourceVerificationError = error;
}
if (control === "overlap") {
  await fsPromises.writeFile(
    path.join(stateRoot, "source-check-complete"),
    "complete\n",
    { flag: "wx" },
  );
  if (!sourceVerificationError?.message.includes(
    "overlap synthetic source worktree must be clean at its exact HEAD",
  )) {
    throw new Error("VITEST_OVERLAP_CONTROL_DID_NOT_REPRODUCE");
  }
  throw new Error("EXPECTED_GIT_VISIBLE_INTERFERENCE");
}
if (sourceVerificationError) throw sourceVerificationError;

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
