import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vitestEntry = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
const extraArguments = process.argv.slice(2);

async function listScratchDirectories() {
  return new Set((await fs.readdir(repoRoot)).filter(entry => entry.startsWith(".test-tmp-")));
}

function testSummary(output) {
  return output
    .split("\n")
    .filter(line => /Test Files|Tests\s+\d/.test(line))
    .slice(-2)
    .map(line => line.trim())
    .join("; ");
}

function runSuite(label) {
  const child = spawn(process.execPath, [vitestEntry, "run", ...extraArguments], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OFFLINE: process.env.OFFLINE ?? "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", chunk => output.push(chunk));
  child.stderr.on("data", chunk => output.push(chunk));
  return {
    label,
    pid: child.pid,
    completion: new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({
        code,
        signal,
        output: Buffer.concat(output).toString("utf8"),
      }));
    }),
  };
}

const scratchDirectoriesBefore = await listScratchDirectories();
const startedAt = Date.now();
const suites = [runSuite("A"), runSuite("B")];
console.log(`[test:concurrent] started suites A (${suites[0].pid}) and B (${suites[1].pid})`);

const results = await Promise.all(suites.map(async suite => ({
  label: suite.label,
  ...await suite.completion,
})));

const failed = results.filter(result => result.code !== 0);
const scratchDirectoriesAfter = await listScratchDirectories();
const leakedScratchDirectories = [...scratchDirectoriesAfter]
  .filter(entry => !scratchDirectoriesBefore.has(entry));

if (failed.length > 0 || leakedScratchDirectories.length > 0) {
  for (const result of results) {
    console.error(`\n[test:concurrent] suite ${result.label} exit=${result.code} signal=${result.signal ?? "none"}`);
    console.error(result.output);
  }
  if (leakedScratchDirectories.length > 0) {
    console.error(`[test:concurrent] leaked scratch directories: ${leakedScratchDirectories.join(", ")}`);
    await Promise.all(leakedScratchDirectories.map(entry =>
      fs.rm(path.join(repoRoot, entry), { recursive: true, force: true })
    ));
  }
  process.exitCode = 1;
} else {
  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  for (const result of results) {
    console.log(`[test:concurrent] suite ${result.label}: ${testSummary(result.output)}`);
  }
  console.log(`[test:concurrent] both full suites passed in ${elapsedSeconds}s`);
}
