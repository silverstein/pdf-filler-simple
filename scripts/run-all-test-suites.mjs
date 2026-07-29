import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBuildNodeVersion } from "./build-toolchain.mjs";
import { runNodeTestSuites } from "./run-node-test-suites.mjs";
import { runControlledTestProcess } from "./test-process-control.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vitestEntry = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");

export function validateAggregateArguments(arguments_) {
  if (arguments_.length > 0) {
    throw new Error(
      "test:all does not accept filtering, sharding, concurrency, or reporter arguments. "
      + "Run npm test or npm run test:node-native separately for runner-specific output.",
    );
  }
}

export async function runAllTestSuites(arguments_ = process.argv.slice(2)) {
  validateAggregateArguments(arguments_);
  verifyBuildNodeVersion();
  const vitestExit = await runControlledTestProcess({
    command: process.execPath,
    args: [vitestEntry, "run"],
    cwd: repoRoot,
    environment: {
      ...process.env,
      OFFLINE: process.env.OFFLINE ?? "1",
    },
    label: "test:all:vitest",
  });
  if (vitestExit !== 0) return vitestExit;
  return runNodeTestSuites({ arguments_: [] });
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runAllTestSuites();
  } catch (error) {
    console.error(`[test:all] ${error.message}`);
    process.exitCode = 2;
  }
}
