import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, it } from "vitest";

const stateRoot = process.env.PDF_TOOLS_VITEST_ORDER_STATE;
if (!stateRoot || !path.isAbsolute(stateRoot)) {
  throw new Error("PDF_TOOLS_VITEST_ORDER_STATE must be an absolute path");
}

const activeRoot = path.join(stateRoot, "ordinary-active");
await fs.mkdir(activeRoot, { recursive: true });
await fs.writeFile(
  path.join(activeRoot, "resource.txt"),
  "ordinary project is active\n",
  { flag: "wx" },
);

it("keeps its resource active through the ordinary test", async () => {
  await expect(fs.readFile(path.join(activeRoot, "resource.txt"), "utf8"))
    .resolves.toBe("ordinary project is active\n");
});

afterAll(async () => {
  await fs.writeFile(
    path.join(stateRoot, "ordinary-teardown-started"),
    "started\n",
    { flag: "wx" },
  );
  await fs.rm(activeRoot, { recursive: true });
  await fs.writeFile(
    path.join(stateRoot, "ordinary-teardown-complete"),
    "complete\n",
    { flag: "wx" },
  );
});
