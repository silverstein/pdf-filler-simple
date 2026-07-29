import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBuildNodeVersion } from "./build-toolchain.mjs";
import { runNodeTestSuites } from "./run-node-test-suites.mjs";
import { verifiedCleanSourceCommit } from "./source-worktree-state.mjs";
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

async function defaultVerifySourceState(phase) {
  return verifiedCleanSourceCommit(repoRoot, {
    label: `test:all source worktree ${phase}`,
  });
}

export function controlledVitestEnvironment(environment = process.env) {
  const controlled = {
    ...environment,
    OFFLINE: environment.OFFLINE ?? "1",
  };
  delete controlled.VITEST_MAX_WORKERS;
  delete controlled.VITEST_POOL_ID;
  delete controlled.VITEST_WORKER_ID;
  return controlled;
}

async function defaultRunVitest() {
  return runControlledTestProcess({
    command: process.execPath,
    args: [vitestEntry, "run"],
    cwd: repoRoot,
    environment: controlledVitestEnvironment(),
    label: "test:all:vitest",
  });
}

export function validateAggregateExitCode(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
    throw new Error(`${label} returned an invalid exit code`);
  }
  return value;
}

function validateSourceCommit(value, phase) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw new Error(`test:all source verification ${phase} returned an invalid commit`);
  }
  return value;
}

function requireSameSourceCommit(expected, actual, phase) {
  if (actual !== expected) {
    throw new Error(
      `test:all source commit changed from ${expected} to ${actual} ${phase}`,
    );
  }
}

async function runPartitionWithPostCheck({
  label,
  run,
  verifySourceState,
  sourceCommit,
  phase,
}) {
  let runnerResult;
  let runnerError;
  try {
    runnerResult = validateAggregateExitCode(await run(), label);
  } catch (error) {
    runnerError = error;
  }

  let sourceError;
  try {
    const verifiedCommit = validateSourceCommit(
      await verifySourceState(phase),
      phase,
    );
    requireSameSourceCommit(sourceCommit, verifiedCommit, phase);
  } catch (error) {
    sourceError = error;
  }

  if (runnerError && sourceError) {
    throw new AggregateError(
      [runnerError, sourceError],
      `${label} and its post-run source verification both failed`,
    );
  }
  if (sourceError) throw sourceError;
  if (runnerError) throw runnerError;
  return runnerResult;
}

export async function runAllTestSuites(
  arguments_ = process.argv.slice(2),
  {
    verifyNodeVersion = verifyBuildNodeVersion,
    verifySourceState = defaultVerifySourceState,
    runVitest = defaultRunVitest,
    runNative = () => runNodeTestSuites({ arguments_: [] }),
  } = {},
) {
  validateAggregateArguments(arguments_);
  await verifyNodeVersion();
  const sourceCommit = validateSourceCommit(
    await verifySourceState("before Vitest"),
    "before Vitest",
  );
  const vitestExit = await runPartitionWithPostCheck({
    label: "test:all:vitest",
    run: runVitest,
    verifySourceState,
    sourceCommit,
    phase: "after Vitest",
  });
  if (vitestExit !== 0) return vitestExit;
  return runPartitionWithPostCheck({
    label: "test:all:native",
    run: runNative,
    verifySourceState,
    sourceCommit,
    phase: "after native tests",
  });
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
