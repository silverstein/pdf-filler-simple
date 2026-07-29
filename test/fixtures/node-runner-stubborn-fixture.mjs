import fs from "node:fs/promises";
import test from "node:test";

process.on("SIGTERM", () => {});

test("waits for aggregate-runner cancellation", async () => {
  const pidFile = process.env.PDF_TOOLS_NODE_RUNNER_FIXTURE_PID_FILE;
  if (!pidFile) throw new Error("fixture PID file is required");
  await fs.writeFile(pidFile, String(process.pid), {
    flag: "wx",
    mode: 0o600,
  });
  await new Promise(resolve => setTimeout(resolve, 30_000));
});
