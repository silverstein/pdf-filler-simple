import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PDF_RESOURCE_LIMIT_CODE,
  createPdfjsSubprocessRequest,
  runPdfjsSubprocess,
  terminateAllPdfjsSubprocesses,
} from "../server/pdfjs-subprocess.js";

const roots = [];

async function fixtureWorker(body) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pdfjs-boundary-test-")),
  );
  roots.push(root);
  const workerPath = path.join(root, "worker.mjs");
  await fs.writeFile(workerPath, body, { mode: 0o600 });
  return workerPath;
}

async function nestedSystemWorker() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pdfjs-nested-renderer-test-")),
  );
  roots.push(root);
  const rendererPath = path.join(root, "renderer.mjs");
  const rendererInfoPath = path.join(root, "renderer.json");
  await fs.writeFile(rendererPath, `
import fs from "node:fs";
fs.writeFileSync(process.argv[2], JSON.stringify({
  pid: process.pid,
  cwd: process.cwd(),
}));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`, { mode: 0o600 });
  const moduleUrl = pathToFileURL(
    path.resolve("server/pdfjs-worker.js"),
  ).href;
  const workerPath = await fixtureWorker(`
import {
  installSystemChildTerminationHandlers,
  runSystemCommand,
} from ${JSON.stringify(moduleUrl)};
installSystemChildTerminationHandlers();
await runSystemCommand(process.execPath, [
  ${JSON.stringify(rendererPath)},
  ${JSON.stringify(rendererInfoPath)},
], { timeoutMs: 30000 });
`);
  return { rendererInfoPath, workerPath };
}

async function waitForFile(filename, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fs.readFile(filename, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT" || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
}

function request(operation = "read_content", options = { max_pages: null }) {
  return createPdfjsSubprocessRequest({
    operation,
    source: {
      canonical_path: path.join(os.tmpdir(), "source.pdf"),
      file_identity: { device: "1", inode: "2" },
      sha256: "a".repeat(64),
      size_bytes: 1,
    },
    password: null,
    options,
    allowedDirectories: [os.tmpdir()],
  });
}

function success(result = { value: "ok" }, binary = null) {
  return JSON.stringify({
    status: "ok",
    protocol_version: 1,
    operation: "read_content",
    result,
    binary,
  });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(root => fs.rm(root, { force: true, recursive: true })),
  );
});

describe.sequential("PDF.js subprocess boundary", () => {
  it("accepts one strict response only after the worker exits and removes its private cwd", async () => {
    const workerPath = await fixtureWorker(`
await new Promise(resolve => process.stdin.on("end", resolve).resume());
process.stdout.write(JSON.stringify({
  status: "ok",
  protocol_version: 1,
  operation: "read_content",
  result: { cwd: process.cwd() },
  binary: null,
}));
`);
    const result = await runPdfjsSubprocess(request(), { workerPath });
    expect(path.basename(result.cwd)).toMatch(/^pdf-tools-pdfjs-/);
    await expect(fs.access(result.cwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("propagates a validated generic worker error rather than mistaking it for protocol corruption", async () => {
    const response = JSON.stringify({
      status: "error",
      protocol_version: 1,
      operation: "read_content",
      error: {
        name: "PdfParseError",
        code: null,
        message: "The parser rejected this fixture.",
      },
    });
    const workerPath = await fixtureWorker(`
await new Promise(resolve => process.stdin.on("end", resolve).resume());
process.stdout.write(${JSON.stringify(response)});
`);
    await expect(runPdfjsSubprocess(request(), { workerPath })).rejects.toMatchObject({
      name: "PdfParseError",
      message: "The parser rejected this fixture.",
    });
  });

  it.each([
    ["malformed JSON", "process.stdout.write('{');"],
    ["trailing bytes", `process.stdout.write(${JSON.stringify(success())} + "\\n");`],
    ["mismatched operation", `process.stdout.write(${JSON.stringify(JSON.stringify({
      status: "ok",
      protocol_version: 1,
      operation: "read_pages",
      result: { value: "wrong" },
      binary: null,
    }))});`],
  ])("rejects %s without accepting a partial result", async (_label, outputStatement) => {
    const workerPath = await fixtureWorker(`
await new Promise(resolve => process.stdin.on("end", resolve).resume());
${outputStatement}
`);
    await expect(runPdfjsSubprocess(request(), { workerPath })).rejects.toMatchObject({
      code: "PDFJS_SUBPROCESS_FAILED",
    });
  });

  it("classifies a wall timeout as a typed resource failure", async () => {
    const workerPath = await fixtureWorker(`
process.on("SIGTERM", () => {});
await new Promise(resolve => process.stdin.on("end", resolve).resume());
setInterval(() => {}, 1000);
`);
    await expect(runPdfjsSubprocess(request(), {
      timeoutMs: 150,
      workerPath,
    })).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "wall_timeout",
    });
  });

  it("caps stdout before parsing and returns no worker-controlled bytes", async () => {
    const workerPath = await fixtureWorker(`
await new Promise(resolve => process.stdin.on("end", resolve).resume());
process.stdout.write("x".repeat(4096));
setInterval(() => {}, 1000);
`);
    await expect(runPdfjsSubprocess(request(), {
      maxResultBytes: 1024,
      timeoutMs: 1000,
      workerPath,
    })).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "worker_output_limit",
    });
  });

  it("keeps the worker inside the enclosing host process session", async () => {
    let observedOptions = null;
    const workerPath = await fixtureWorker(`
await new Promise(resolve => process.stdin.on("end", resolve).resume());
process.stdout.write(${JSON.stringify(success())});
`);
    const result = await runPdfjsSubprocess(request(), {
      spawnProcess(executable, args, options) {
        observedOptions = options;
        return spawn(executable, args, options);
      },
      workerPath,
    });
    expect(result).toEqual({ value: "ok" });
    expect(observedOptions).toMatchObject({ detached: false, shell: false });
  });

  it("reaps a nested system renderer during parent deadline escalation", async () => {
    if (process.platform === "win32") return;
    const { rendererInfoPath, workerPath } = await nestedSystemWorker();
    await expect(runPdfjsSubprocess(request(), {
      timeoutMs: 500,
      workerPath,
    })).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "wall_timeout",
    });
    const renderer = JSON.parse(await fs.readFile(rendererInfoPath, "utf8"));
    expect(() => process.kill(renderer.pid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
    await expect(fs.access(renderer.cwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reaps a nested system renderer during graceful server shutdown", async () => {
    if (process.platform === "win32") return;
    const { rendererInfoPath, workerPath } = await nestedSystemWorker();
    const operation = expect(runPdfjsSubprocess(request(), {
      timeoutMs: 30_000,
      workerPath,
    })).rejects.toMatchObject({
      code: "PDFJS_SUBPROCESS_FAILED",
    });
    const renderer = JSON.parse(await waitForFile(rendererInfoPath));
    await terminateAllPdfjsSubprocesses();
    await operation;
    expect(() => process.kill(renderer.pid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
    await expect(fs.access(renderer.cwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not inherit Node injection flags or unrelated secrets", async () => {
    const workerPath = await fixtureWorker(`
await new Promise(resolve => process.stdin.on("end", resolve).resume());
process.stdout.write(JSON.stringify({
  status: "ok",
  protocol_version: 1,
  operation: "read_content",
  result: {
    node_options: process.env.NODE_OPTIONS ?? null,
    secret: process.env.PDF_TOOLS_TEST_SECRET ?? null,
  },
  binary: null,
}));
`);
    const result = await runPdfjsSubprocess(request(), {
      environment: {
        ...process.env,
        NODE_OPTIONS: "--inspect",
        PDF_TOOLS_TEST_SECRET: "must-not-cross",
      },
      workerPath,
    });
    expect(result).toEqual({ node_options: null, secret: null });
  });
});
