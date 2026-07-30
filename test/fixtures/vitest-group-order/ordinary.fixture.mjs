import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, it } from "vitest";

const stateRoot = process.env.PDF_TOOLS_VITEST_ORDER_STATE;
const repositoryRoot = process.env.PDF_TOOLS_VITEST_ORDER_REPOSITORY;
if (!stateRoot || !path.isAbsolute(stateRoot)) {
  throw new Error("PDF_TOOLS_VITEST_ORDER_STATE must be an absolute path");
}
if (!repositoryRoot || !path.isAbsolute(repositoryRoot)) {
  throw new Error("PDF_TOOLS_VITEST_ORDER_REPOSITORY must be an absolute path");
}

const activeRoot = path.join(stateRoot, "ordinary-active");
const checkoutArtifact = path.join(repositoryRoot, "ordinary-untracked.txt");
await fs.mkdir(activeRoot, { recursive: true });
await fs.writeFile(
  path.join(activeRoot, "resource.txt"),
  "ordinary project is active\n",
  { flag: "wx" },
);
await fs.writeFile(checkoutArtifact, "Git-visible overlap artifact\n", {
  flag: "wx",
});
await fs.writeFile(
  path.join(stateRoot, "ordinary-git-interference-ready"),
  "ready\n",
  { flag: "wx" },
);

it("keeps its resource active through the ordinary test", async () => {
  await expect(fs.readFile(path.join(activeRoot, "resource.txt"), "utf8"))
    .resolves.toBe("ordinary project is active\n");
});

afterAll(async () => {
  if (process.env.PDF_TOOLS_VITEST_ORDER_CONTROL === "overlap") {
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        await fs.access(path.join(stateRoot, "source-check-complete"));
        break;
      } catch {
        if (Date.now() >= deadline) {
          throw new Error("overlap source check did not complete");
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  }
  await fs.writeFile(
    path.join(stateRoot, "ordinary-teardown-started"),
    "started\n",
    { flag: "wx" },
  );
  await fs.rm(checkoutArtifact);
  await fs.rm(activeRoot, { recursive: true });
  await fs.writeFile(
    path.join(stateRoot, "ordinary-teardown-complete"),
    "complete\n",
    { flag: "wx" },
  );
});
