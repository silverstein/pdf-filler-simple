import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBuildNodeVersion } from "./build-toolchain.mjs";
import {
  NODE_TEST_FILES,
  nodeTestFilesForPlatform,
  nodeTestOmissionsForPlatform,
} from "./node-test-files.mjs";
import { runControlledTestProcess } from "./test-process-control.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const reporters = new Set(["dot", "junit", "spec", "tap"]);

export function parseNodeTestArguments(arguments_) {
  let reporter = "spec";
  let reporterSeen = false;
  for (const argument of arguments_) {
    if (!argument.startsWith("--reporter=")) {
      throw new Error(
        `Unsupported native-test argument ${JSON.stringify(argument)}. `
        + "Only --reporter=dot|junit|spec|tap is allowed; run a focused "
        + "node --test command directly for filtering or sharding.",
      );
    }
    if (reporterSeen) throw new Error("Native-test reporter may be specified only once.");
    reporter = argument.slice("--reporter=".length);
    if (!reporters.has(reporter)) {
      throw new Error(`Unsupported native-test reporter: ${reporter}`);
    }
    reporterSeen = true;
  }
  return { reporter };
}

export async function runNodeTestSuites({
  suiteFiles,
  arguments_ = process.argv.slice(2),
  platform = process.platform,
  environment = process.env,
  standardInputOutput = "inherit",
  escalationMs = 1_000,
} = {}) {
  verifyBuildNodeVersion();
  const { reporter } = parseNodeTestArguments(arguments_);
  const selectedSuiteFiles = suiteFiles ?? nodeTestFilesForPlatform(platform);
  const skippedFiles = NODE_TEST_FILES.filter(
    file => !selectedSuiteFiles.includes(file),
  );
  if (skippedFiles.length > 0) {
    const reasons = new Map(
      nodeTestOmissionsForPlatform(platform)
        .map(omission => [omission.file, omission.reason]),
    );
    console.error(
      `[test:node-native] ${platform} intentional omissions:\n`
      + skippedFiles.map(
        file => `- ${file}: ${reasons.get(file) ?? "focused injected suite selection"}`,
      ).join("\n"),
    );
  }

  return runControlledTestProcess({
    command: process.execPath,
    args: [
      "--test",
      `--test-reporter=${reporter}`,
      "--test-concurrency=1",
      ...selectedSuiteFiles,
    ],
    cwd: repoRoot,
    environment,
    escalationMs,
    label: "test:node-native",
    platform,
    standardInputOutput,
  });
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runNodeTestSuites();
  } catch (error) {
    console.error(`[test:node-native] ${error.message}`);
    process.exitCode = 2;
  }
}
