import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repoRoot = process.cwd();
const viteBin = path.join(repoRoot, "node_modules", "vite", "bin", "vite.js");

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

export async function waitForServer(url, timeoutMs = 20_000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }

  throw new Error(`Dev server did not become ready at ${url}: ${lastError?.message || "unknown error"}`);
}

export function startDevUiServer(port) {
  const child = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", String(port)], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
  });

  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  return child;
}

export async function stopDevUiServer(child) {
  if (!child) return;
  child.kill("SIGINT");
  const exited = await Promise.race([
    waitForExit(child),
    delay(5_000).then(() => null),
  ]);
  if (!exited) {
    child.kill("SIGKILL");
    await waitForExit(child);
  }
}

export async function withDevUiServer(port, work) {
  const child = startDevUiServer(port);
  try {
    await waitForServer(`http://127.0.0.1:${port}/`);
    return await work();
  } finally {
    await stopDevUiServer(child);
  }
}

export function createAgentBrowserSessionRunner(session) {
  return async function runAgentBrowser(args) {
    const child = spawn("agent-browser", ["--session", session, ...args], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    const [code] = await once(child, "exit");
    if (code !== 0) {
      throw new Error(`agent-browser ${args.join(" ")} failed with code ${code}\n${stderr || stdout}`);
    }
    return stdout;
  };
}
