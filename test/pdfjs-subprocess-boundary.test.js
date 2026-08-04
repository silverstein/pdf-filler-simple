import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  PDF_RESOURCE_LIMIT_CODE,
  createPdfjsSubprocessRequest,
  runPdfjsSubprocess,
  selectPdfjsIsolationMode,
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

async function createThreadPdfRequest({
  operation = "read_content",
  options = { max_pages: null },
} = {}) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pdfjs-thread-test-")),
  );
  roots.push(root);
  const filename = path.join(root, "source.pdf");
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([300, 200]);
  page.drawText("Thread host conversion", { x: 24, y: 120, size: 14, font });
  const bytes = Buffer.from(await document.save({ useObjectStreams: false }));
  await fs.writeFile(filename, bytes, { mode: 0o600 });
  const stats = await fs.stat(filename, { bigint: true });
  return createPdfjsSubprocessRequest({
    operation,
    source: {
      canonical_path: filename,
      file_identity: {
        device: String(stats.dev),
        inode: String(stats.ino),
      },
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size_bytes: bytes.length,
    },
    password: null,
    options,
    allowedDirectories: [root],
  });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(root => fs.rm(root, { force: true, recursive: true })),
  );
});

describe.sequential("PDF.js subprocess boundary", () => {
  it("never relaunches an Electron host executable as Node", () => {
    expect(selectPdfjsIsolationMode({
      electronVersion: "39.0.0",
      processType: "utility",
      hasElectronParentPort: true,
      executable: "/Applications/Claude.app/Contents/MacOS/Claude",
    })).toBe("in_process");
    expect(selectPdfjsIsolationMode({
      electronVersion: "39.0.0",
      processType: "browser",
      hasElectronParentPort: false,
      executable: "/Applications/Claude.app/Contents/MacOS/Claude",
    })).toBe("in_process");
    expect(selectPdfjsIsolationMode({
      electronVersion: null,
      processType: null,
      hasElectronParentPort: true,
      executable: "/Applications/Claude.app/Contents/Frameworks/Claude Helper (Plugin)",
    })).toBe("in_process");
    expect(selectPdfjsIsolationMode({
      electronVersion: null,
      processType: null,
      hasElectronParentPort: false,
      executable: "/Applications/Claude.app/Contents/Frameworks/Claude Helper (Plugin)",
    })).toBe("in_process");
    expect(selectPdfjsIsolationMode({
      electronVersion: null,
      processType: null,
      hasElectronParentPort: false,
      executable: "/Applications/Claude.app/Contents/MacOS/Claude",
    })).toBe("in_process");
    expect(selectPdfjsIsolationMode({
      electronVersion: null,
      processType: null,
      hasElectronParentPort: false,
      executable: "/Applications/Example.app/Contents/Resources/node",
    })).toBe("subprocess");
    expect(selectPdfjsIsolationMode({
      electronVersion: null,
      processType: null,
      hasElectronParentPort: false,
      executable: process.execPath,
    })).toBe("subprocess");
  });

  it("keeps PDF.js in process while PDF-lib keeps a worker boundary on the same host", async () => {
    const { selectPdfLibIsolationMode } = await import("../server/pdf-lib-subprocess.js");
    // One embedded Electron host, described identically to both selectors.
    const embeddedHost = {
      electronVersion: "34.0.0",
      processType: "utility",
      hasElectronParentPort: true,
      executable: "/Applications/Claude.app/Contents/MacOS/Claude Helper (Plugin)",
    };
    // The asymmetry is deliberate and evidenced, not an oversight. PDF.js
    // crashed this host in both isolated modes, while PDF-lib has completed
    // live rotate, merge, and split mutations here through a worker thread.
    // Harmonizing these two would either crash the host or silently drop a
    // proven boundary, so both directions are pinned.
    expect(selectPdfjsIsolationMode(embeddedHost)).toBe("in_process");
    expect(selectPdfLibIsolationMode(embeddedHost)).toBe("worker_thread");

    const ordinaryNodeHost = {
      electronVersion: null,
      processType: null,
      hasElectronParentPort: false,
      executable: "/usr/local/bin/node",
    };
    expect(selectPdfjsIsolationMode(ordinaryNodeHost)).toBe("subprocess");
    expect(selectPdfLibIsolationMode(ordinaryNodeHost)).toBe("subprocess");
  });

  it("runs a source-bound request without spawning or threading in an embedded host", async () => {
    const failIfUsed = () => {
      throw new Error("The embedded host must not launch another executable.");
    };
    const priorElectron = Object.getOwnPropertyDescriptor(process.versions, "electron");
    const priorProcessType = Object.getOwnPropertyDescriptor(process, "type");
    const priorWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    let webWorkerConstructions = 0;
    Object.defineProperty(process.versions, "electron", {
      configurable: true,
      enumerable: true,
      value: "39.0.0",
    });
    Object.defineProperty(process, "type", {
      configurable: true,
      value: "utility",
    });
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: class {
        constructor() {
          webWorkerConstructions += 1;
          throw new Error("PDF.js must not create an Electron Web Worker.");
        }
      },
    });
    let result;
    try {
      result = await runPdfjsSubprocess(
        await createThreadPdfRequest(),
        {
          isolationMode: "in_process",
          spawnProcess: failIfUsed,
          workerClass: class {
            constructor() {
              failIfUsed();
            }
          },
        },
      );
    } finally {
      if (priorElectron) {
        Object.defineProperty(process.versions, "electron", priorElectron);
      } else {
        delete process.versions.electron;
      }
      if (priorProcessType) Object.defineProperty(process, "type", priorProcessType);
      else delete process.type;
      if (priorWorker) Object.defineProperty(globalThis, "Worker", priorWorker);
      else delete globalThis.Worker;
    }
    expect(webWorkerConstructions).toBe(0);
    expect(process.versions.electron).toBeUndefined();
    expect(process.type).toBeUndefined();
    expect(result).toMatchObject({
      pages_read: 1,
      text_found: true,
      total_pages: 1,
    });
    expect(result.output_text).toContain("Thread host conversion");
  });

  it("blocks embedded native canvas and renders through the tracked system child", async () => {
    if (process.platform !== "darwin") return;
    const result = await runPdfjsSubprocess(
      await createThreadPdfRequest({
        operation: "render_page",
        options: {
          max_dimension_px: 512,
          page: 1,
          renderer_policy: "native_with_system_fallback",
          scale_override: null,
        },
      }),
      { isolationMode: "in_process" },
    );
    expect(result).toMatchObject({ renderer: "macos-quicklook" });
    expect(result.binary.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it("runs a source-bound PDF.js request in the Electron-host worker-thread fallback", async () => {
    const result = await runPdfjsSubprocess(
      await createThreadPdfRequest(),
      { isolationMode: "worker_thread" },
    );
    expect(result).toMatchObject({
      pages_read: 1,
      text_found: true,
      total_pages: 1,
    });
    expect(result.output_text).toContain("Thread host conversion");
  });

  it("keeps native modules out of the Electron-host worker and renders through the controller", async () => {
    if (process.platform !== "darwin") return;
    const result = await runPdfjsSubprocess(
      await createThreadPdfRequest({
        operation: "render_page",
        options: {
          max_dimension_px: 512,
          page: 1,
          renderer_policy: "native_with_system_fallback",
          scale_override: null,
        },
      }),
      { isolationMode: "worker_thread" },
    );
    expect(result).toMatchObject({ renderer: "macos-quicklook" });
    expect(result.binary.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it("bounds a stalled Electron-host worker thread by the same wall deadline", async () => {
    const workerPath = await fixtureWorker(`
setInterval(() => {}, 1000);
`);
    await expect(runPdfjsSubprocess(request(), {
      isolationMode: "worker_thread",
      timeoutMs: 150,
      workerPath,
    })).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "wall_timeout",
    });
  });

  it("rejects a malformed Electron-host worker-thread response", async () => {
    const workerPath = await fixtureWorker(`
import { parentPort } from "node:worker_threads";
parentPort.postMessage({ frame: {}, binary: null, unexpected: true });
parentPort.close();
`);
    await expect(runPdfjsSubprocess(request(), {
      isolationMode: "worker_thread",
      workerPath,
    })).rejects.toMatchObject({
      code: "PDFJS_SUBPROCESS_FAILED",
    });
  });

  it("classifies an Electron-host worker-thread heap death as a resource failure", async () => {
    const workerPath = await fixtureWorker(`
const retained = [];
for (;;) retained.push(new Array(100000).fill("bounded-worker"));
`);
    await expect(runPdfjsSubprocess(request(), {
      isolationMode: "worker_thread",
      maxOldSpaceMb: 64,
      timeoutMs: 10_000,
      workerPath,
    })).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "worker_memory_or_signal_limit",
    });
  });

  it("does not orphan a system child when the Electron-host worker thread is terminated", async () => {
    if (process.platform === "win32") return;
    const rendererPath = await fixtureWorker(`
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`);
    const workerPath = await fixtureWorker(`
import { parentPort } from "node:worker_threads";
parentPort.postMessage({
  kind: "system_command",
  id: 1,
  command: "/usr/bin/sips",
  args: ["synthetic"],
  timeout_ms: 30000,
});
setInterval(() => {}, 1000);
`);
    let rendererPid = null;
    const operation = runPdfjsSubprocess(request(), {
      isolationMode: "worker_thread",
      // The production command allowlist is intentionally macOS-only. This
      // fixture substitutes the child executable, so pin the injected platform
      // to the boundary under test instead of inheriting the test host.
      platform: "darwin",
      spawnProcess(_command, _args, options) {
        const child = spawn(process.execPath, [rendererPath], options);
        rendererPid = child.pid;
        return child;
      },
      timeoutMs: 500,
      workerPath,
    });
    // Observe the rejection immediately while delaying the assertion until the
    // fixture has captured the nested child PID.
    void operation.catch(() => {});
    const deadline = Date.now() + 2000;
    while (rendererPid === null && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(rendererPid).not.toBeNull();
    await expect(operation).rejects.toMatchObject({
      code: PDF_RESOURCE_LIMIT_CODE,
      reason: "wall_timeout",
    });
    expect(() => process.kill(rendererPid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
  });

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
