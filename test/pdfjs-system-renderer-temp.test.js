import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPdfjsSubprocessRequest,
  runPdfjsSubprocess,
} from "../server/pdfjs-subprocess.js";
import { executePdfjsWorkerRequest } from "../server/pdfjs-worker.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES = [
  path.join(REPO_ROOT, "example-fw9.pdf"),
  path.join(REPO_ROOT, "test/fixtures/eval/extraction/type3-cm-reference.pdf"),
];
const SYSTEM_RENDER_PREFIX = "pdf-tools-system-render-";
const roots = [];
const hosts = new Set();

async function temporaryRoot() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pdfjs-system-render-temp-test-")),
  );
  roots.push(root);
  return root;
}

async function sourceBinding(sourcePath) {
  const bytes = await fs.readFile(sourcePath);
  const stats = await fs.stat(sourcePath, { bigint: true });
  return {
    bytes,
    source: {
      canonical_path: sourcePath,
      file_identity: {
        device: String(stats.dev),
        inode: String(stats.ino),
      },
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size_bytes: bytes.length,
    },
  };
}

async function renderRequest(sourcePath) {
  const { source } = await sourceBinding(sourcePath);
  return createPdfjsSubprocessRequest({
    operation: "render_page",
    source,
    password: null,
    options: {
      max_dimension_px: 512,
      page: 1,
      renderer_policy: "system",
      scale_override: null,
    },
    allowedDirectories: [path.dirname(sourcePath)],
  });
}

async function waitForFile(filename, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fs.access(filename);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT" || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}

function collectBounded(stream, child) {
  let output = "";
  stream.on("data", chunk => {
    output += chunk.toString("utf8");
    if (Buffer.byteLength(output) > 64 * 1024) child.kill("SIGKILL");
  });
  return () => output;
}

function spawnRenderHost(hostPath, id, sourcePath, triggerPath, readyDirectory) {
  const child = spawn(process.execPath, [
    hostPath,
    id,
    sourcePath,
    triggerPath,
    readyDirectory,
  ], {
    cwd: REPO_ROOT,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  hosts.add(child);
  const stdout = collectBounded(child.stdout, child);
  const stderr = collectBounded(child.stderr, child);
  const outcome = once(child, "close").then(([code, signal]) => {
    hosts.delete(child);
    const lines = stdout().trim().split("\n").filter(Boolean);
    return {
      code,
      signal,
      stderr: stderr(),
      value: lines.length === 0 ? null : JSON.parse(lines.at(-1)),
    };
  });
  return { child, outcome };
}

async function systemRenderDirectories() {
  return (await fs.readdir(os.tmpdir()))
    .filter(name => name.startsWith(SYSTEM_RENDER_PREFIX))
    .sort();
}

afterEach(async () => {
  await Promise.all([...hosts].map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, "close");
    child.kill("SIGKILL");
    await closed;
  }));
  hosts.clear();
  await Promise.all(
    roots.splice(0).map(root => fs.rm(root, { force: true, recursive: true })),
  );
});

describe.skipIf(process.platform !== "darwin")(
  "macOS system renderer temporary workspace",
  () => {
    it("isolates concurrent callers by source and removes every private workspace", async () => {
      const beforeDirectories = await systemRenderDirectories();
      const baselineEntries = [];
      for (const sourcePath of SOURCES) {
        const result = await runPdfjsSubprocess(await renderRequest(sourcePath), {
          isolationMode: "in_process",
          timeoutMs: 30_000,
        });
        baselineEntries.push([
          sourcePath,
          createHash("sha256").update(result.binary).digest("hex"),
        ]);
      }
      const baselineHashes = new Map(baselineEntries);
      expect(new Set(baselineHashes.values()).size).toBe(SOURCES.length);

      const root = await temporaryRoot();
      const readyDirectory = path.join(root, "ready");
      const triggerPath = path.join(root, "go");
      const hostPath = path.join(root, "host.mjs");
      await fs.mkdir(readyDirectory, { mode: 0o700 });
      const workerModule = pathToFileURL(
        path.join(REPO_ROOT, "server/pdfjs-worker.js"),
      ).href;
      const subprocessModule = pathToFileURL(
        path.join(REPO_ROOT, "server/pdfjs-subprocess.js"),
      ).href;
      await fs.writeFile(hostPath, `
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createPdfjsSubprocessRequest, runPdfjsSubprocess } from ${JSON.stringify(subprocessModule)};
import ${JSON.stringify(workerModule)};
const [id, sourcePath, triggerPath, readyDirectory] = process.argv.slice(2);
const bytes = await fs.readFile(sourcePath);
const stats = await fs.stat(sourcePath, { bigint: true });
await fs.writeFile(path.join(readyDirectory, id + ".ready"), "ready", { mode: 0o600 });
for (;;) {
  try { await fs.access(triggerPath); break; }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const result = await runPdfjsSubprocess(createPdfjsSubprocessRequest({
  operation: "render_page",
  source: {
    canonical_path: sourcePath,
    file_identity: { device: String(stats.dev), inode: String(stats.ino) },
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size_bytes: bytes.length,
  },
  password: null,
  options: {
    max_dimension_px: 512,
    page: 1,
    renderer_policy: "system",
    scale_override: null,
  },
  allowedDirectories: [path.dirname(sourcePath)],
}), { isolationMode: "in_process", timeoutMs: 30000 });
console.log(JSON.stringify({
  id,
  png_sha256: createHash("sha256").update(result.binary).digest("hex"),
}));
`, { mode: 0o600 });

      const calls = Array.from({ length: 6 }, (_, index) => {
        const id = String(index + 1);
        const sourcePath = SOURCES[index % SOURCES.length];
        return {
          id,
          sourcePath,
          ...spawnRenderHost(hostPath, id, sourcePath, triggerPath, readyDirectory),
        };
      });
      await Promise.all(calls.map(call => waitForFile(
        path.join(readyDirectory, `${call.id}.ready`),
      )));
      await fs.writeFile(triggerPath, "go", { mode: 0o600 });
      const outcomes = await Promise.all(calls.map(call => call.outcome));

      for (const [index, outcome] of outcomes.entries()) {
        expect(
          { code: outcome.code, signal: outcome.signal, stderr: outcome.stderr },
          `renderer host ${calls[index].id}`,
        ).toMatchObject({ code: 0, signal: null });
        expect(outcome.value).toEqual({
          id: calls[index].id,
          png_sha256: baselineHashes.get(calls[index].sourcePath),
        });
      }
      expect(await systemRenderDirectories()).toEqual(beforeDirectories);
    }, 60_000);

    it("does not disclose a private workspace path when workspace creation fails", async () => {
      const root = await temporaryRoot();
      const undisclosedPath = path.join(root, "private-render-root", "missing");
      const request = await renderRequest(SOURCES[0]);
      const priorTmpdir = process.env.TMPDIR;
      process.env.TMPDIR = undisclosedPath;
      let failure;
      try {
        await executePdfjsWorkerRequest(request);
      } catch (error) {
        failure = error;
      } finally {
        if (priorTmpdir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = priorTmpdir;
      }
      expect(failure).toMatchObject({
        message: "The macOS system PDF renderer could not render this page.",
      });
      expect(failure.message).not.toContain(root);
      expect(failure.message).not.toContain(SYSTEM_RENDER_PREFIX);
    });
  },
);
