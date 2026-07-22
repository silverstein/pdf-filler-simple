import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const helperDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(helperDirectory, "../..");
const serverPath = path.join(repositoryRoot, "server/index.js");
const sentinel = process.env.PDF_TOOLS_TEST_STDERR_SENTINEL;

if (!sentinel || /[\r\n]/.test(sentinel)) {
  throw new Error("PDF_TOOLS_TEST_STDERR_SENTINEL must be a non-empty single line.");
}

const server = spawn(process.execPath, [serverPath], {
  cwd: repositoryRoot,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

process.stdin.pipe(server.stdin);
server.stdout.pipe(process.stdout, { end: false });
server.stderr.pipe(process.stderr, { end: false });

let spawnError = null;
server.on("error", error => {
  spawnError = error;
});
server.on("close", (code, signal) => {
  if (spawnError) process.stderr.write(`MCP sentinel helper child error: ${spawnError.message}\n`);
  if (signal) process.stderr.write(`MCP sentinel helper child signal: ${signal}\n`);
  process.stderr.write(`${sentinel}\n`, () => {
    process.exitCode = Number.isInteger(code) ? code : 1;
  });
});
