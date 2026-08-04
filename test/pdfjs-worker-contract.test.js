import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  hashBoundedPdfFileSafely,
} from "../server/bounded-pdf-file.js";
import {
  createPdfjsSubprocessRequest,
  runPdfjsSubprocess,
} from "../server/pdfjs-subprocess.js";
import {
  readContentFromDocument,
  runRendererPolicy,
  runSystemCommand,
} from "../server/pdfjs-worker.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");
const TYPE3_REFERENCE_PDF = path.join(
  REPO_ROOT,
  "test/fixtures/eval/extraction/type3-cm-reference.pdf",
);
const roots = [];
const hosts = new Set();

async function fixtureScript(body) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pdfjs-system-child-test-")),
  );
  roots.push(root);
  const filename = path.join(root, "fixture.mjs");
  await fs.writeFile(filename, body, { mode: 0o600 });
  return { root, filename };
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

async function stubbornSystemRenderer() {
  const { root, filename } = await fixtureScript(`
import fs from "node:fs";
fs.writeFileSync(process.argv[2], String(process.pid));
setTimeout(() => fs.writeFileSync(process.argv[3], "escaped"), 500);
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`);
  const pidPath = path.join(root, "renderer.pid");
  const sentinelPath = path.join(root, "renderer-escaped.txt");
  let calls = 0;
  return {
    pidPath,
    sentinelPath,
    calls: () => calls,
    renderer: async () => {
      calls += 1;
      return await runSystemCommand(
        process.execPath,
        [filename, pidPath, sentinelPath],
        { timeoutMs: 150 },
      );
    },
  };
}

afterEach(async () => {
  await Promise.all([...hosts].map(async host => {
    if (host.exitCode !== null || host.signalCode !== null) return;
    const closed = once(host, "close");
    host.kill("SIGKILL");
    await closed;
  }));
  hosts.clear();
  await Promise.all(
    roots.splice(0).map(root => fs.rm(root, { force: true, recursive: true })),
  );
});

async function sourceBinding(pdfPath = EXAMPLE_PDF) {
  const source = await hashBoundedPdfFileSafely(pdfPath, 250 * 1024 * 1024, {
    assertPathAllowed: candidate => candidate,
  });
  return {
    canonical_path: source.canonicalPath,
    file_identity: source.fileIdentity,
    sha256: source.sha256,
    size_bytes: source.sizeBytes,
  };
}

async function run(operation, options, password = null, source = null) {
  return await runPdfjsSubprocess(createPdfjsSubprocessRequest({
    operation,
    source: source || await sourceBinding(),
    options,
    password,
    allowedDirectories: [REPO_ROOT],
  }), { timeoutMs: 30_000 });
}

describe.sequential("one-shot PDF.js worker contracts", () => {
  it("preserves textless pages when a later page read fails", async () => {
    const pageOne = {
      async getTextContent() {
        return { items: [{ str: " \n\t " }] };
      },
      cleanup() {},
    };
    const document = {
      numPages: 2,
      async getPage(pageNumber) {
        if (pageNumber === 1) return pageOne;
        throw new Error("forced page load failure");
      },
    };
    await expect(readContentFromDocument(document, { max_pages: null })).resolves.toMatchObject({
      pages_without_text: [1],
      pages_read: 1,
      page_read_error: {
        page: 2,
        code: "PDFJS_PAGE_READ_FAILED",
      },
      page_previews: [{ page: 1, char_count: 0, text: "" }],
    });
  });

  it("projects text extraction without returning an unbounded page-text graph", async () => {
    const content = await run("read_content", { max_pages: 1 });
    expect(content).toMatchObject({
      total_pages: expect.any(Number),
      pages_read: 1,
      source_length: expect.any(Number),
      output_text: expect.any(String),
      page_previews: expect.any(Array),
    });
    expect(content.output_text.length).toBeLessThanOrEqual(50_000);
    expect(content.page_previews[0].text.length).toBeLessThanOrEqual(2000);

    const pages = await run("read_pages", {
      start_page: 1,
      end_page: 1,
      max_chars_per_page: 1000,
    });
    expect(pages.pages).toHaveLength(1);
    expect(pages.pages[0].text.length).toBeLessThanOrEqual(1000);

    const search = await run("search_text", {
      query: "a",
      max_results: 3,
      context_chars: 40,
    });
    expect(search.matches.length).toBeLessThanOrEqual(3);
    expect(search).toMatchObject({
      query: "a",
      match_count: search.matches.length,
      total_pages: expect.any(Number),
    });
  });

  it("keeps complete layout replay inside one worker operation", async () => {
    const common = {
      source_path: EXAMPLE_PDF,
      source_file_name: path.basename(EXAMPLE_PDF),
      start_page: 1,
      end_page: 1,
      max_items: 200,
      max_characters: 20_000,
      max_output_characters: 50_000,
    };
    const layout = await run("extract_layout", common);
    expect(layout.layout).toMatchObject({
      ir: { name: "pdf-tools.extraction-ir", version: "1.4.0" },
      parser: { name: "pdfjs-dist", version: "5.4.624" },
      pages: expect.any(Array),
    });
    const markdownLayout = await run("extract_layout_for_markdown", common);
    expect(markdownLayout.layout.parser.version).toBe("5.4.624");
    expect(markdownLayout.layout.page_range.start_page).toBe(1);
  });

  it("preserves exact Type-3 glyph evidence inside the isolated worker", async () => {
    const result = await run("extract_layout_for_markdown", {
      source_path: TYPE3_REFERENCE_PDF,
      source_file_name: path.basename(TYPE3_REFERENCE_PDF),
      start_page: 1,
      end_page: 1,
      max_items: 5000,
      max_characters: 100_000,
      max_output_characters: 200_000,
    }, null, await sourceBinding(TYPE3_REFERENCE_PDF));
    const recoveredItems = result.layout.pages[0].raw_items
      .filter(item => Array.isArray(item.glyph_recoveries));
    expect(recoveredItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source_text: "\u0000\u0015p",
        text: "−\u0015p",
        glyph_recoveries: [expect.objectContaining({
          registry_id: "cmsy-ctan-type3-minus-v1",
          target_unicode: "−",
        })],
      }),
    ]));
  });

  it("returns PNG bytes only on the separately bounded binary channel", async () => {
    const page = await run("render_page", {
      page: 1,
      max_dimension_px: 256,
      renderer_policy: "native",
      scale_override: null,
    });
    expect(Buffer.isBuffer(page.binary)).toBe(true);
    expect(page.binary.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(page).toMatchObject({
      renderer: "native-canvas",
      width: expect.any(Number),
      height: expect.any(Number),
      width_points: expect.any(Number),
      height_points: expect.any(Number),
      scale: expect.any(Number),
    });

    const region = await run("render_region", {
      page: 1,
      x: 0,
      y: 0,
      width: 72,
      height: 72,
      max_dimension_px: 144,
      renderer_policy: "native",
    });
    expect(Buffer.isBuffer(region.binary)).toBe(true);
    expect(region.width).toBeLessThanOrEqual(144);
    expect(region.height).toBeLessThanOrEqual(144);

    if (process.platform === "darwin") {
      const systemPage = await run("render_page", {
        page: 1,
        max_dimension_px: 256,
        renderer_policy: "system",
        scale_override: null,
      });
      expect(Buffer.isBuffer(systemPage.binary)).toBe(true);
      expect(systemPage.renderer).toBe("macos-quicklook");
    }
  });

  it("runs page operators and signature text heuristics inside the worker", async () => {
    const analysis = await run("analyze_pages", { max_pages: 200 });
    expect(analysis.analysis).toMatchObject({
      total_pages: expect.any(Number),
      pages: expect.any(Array),
      content_analysis_status: expect.stringMatching(/complete|partial|degraded/),
    });
    const zones = await run("detect_signature_zones", {});
    expect(zones).toMatchObject({
      zones: expect.any(Array),
      warning_counts: expect.any(Array),
      page_geometry: expect.any(Array),
    });
  });

  it("kills and reaps a timed-out system renderer child before rejecting", async () => {
    const { filename } = await fixtureScript(`
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`);
    let rendererPid = null;
    const spawnFixture = (command, args, options) => {
      const child = spawn(command, args, options);
      rendererPid = child.pid;
      return child;
    };
    await expect(runSystemCommand(process.execPath, [filename], {
      spawnProcess: spawnFixture,
      timeoutMs: 150,
    })).rejects.toMatchObject({
      code: "PDF_RESOURCE_LIMIT_EXCEEDED",
      reason: "system_renderer_timeout",
    });
    expect(Number.isSafeInteger(rendererPid)).toBe(true);
    expect(() => process.kill(rendererPid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
  });

  it("kills and reaps an active system renderer before the worker exits on SIGTERM", async () => {
    if (process.platform === "win32") return;
    const { root, filename: rendererPath } = await fixtureScript(`
import fs from "node:fs";
fs.writeFileSync(process.argv[2], String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`);
    const pidPath = path.join(root, "renderer.pid");
    const hostPath = path.join(root, "host.mjs");
    const workerModule = pathToFileURL(
      path.join(REPO_ROOT, "server", "pdfjs-worker.js"),
    ).href;
    await fs.writeFile(hostPath, `
import {
  installSystemChildTerminationHandlers,
  runSystemCommand,
} from ${JSON.stringify(workerModule)};
installSystemChildTerminationHandlers();
await runSystemCommand(process.execPath, [
  ${JSON.stringify(rendererPath)},
  ${JSON.stringify(pidPath)},
], { timeoutMs: 30000 });
`, { mode: 0o600 });
    const host = spawn(process.execPath, [hostPath], {
      cwd: root,
      env: { HOME: root, LANG: "C", PATH: process.env.PATH ?? "" },
      stdio: "ignore",
    });
    hosts.add(host);
    const rendererPid = Number((await waitForFile(pidPath)).trim());
    const closed = once(host, "close");
    expect(host.kill("SIGTERM")).toBe(true);
    const [exitCode, exitSignal] = await closed;
    hosts.delete(host);
    expect({ exitCode, exitSignal }).toEqual({ exitCode: 143, exitSignal: null });
    expect(() => process.kill(rendererPid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
  });

  it.each([
    ["forced system", "system", 0],
    ["native-to-system fallback", "native_with_system_fallback", 1],
  ])("reaps a stubborn child reached through the %s route", async (
    _label,
    policy,
    expectedNativeCalls,
  ) => {
    const system = await stubbornSystemRenderer();
    let nativeCalls = 0;
    await expect(runRendererPolicy(policy, {
      nativeRenderer: async () => {
        nativeCalls += 1;
        throw new Error("Canvas dependency: Cannot find native binding");
      },
      systemRenderer: system.renderer,
    })).rejects.toMatchObject({
      code: "PDF_RESOURCE_LIMIT_EXCEEDED",
      reason: "system_renderer_timeout",
    });
    expect(nativeCalls).toBe(expectedNativeCalls);
    expect(system.calls()).toBe(1);
    const pid = Number(await fs.readFile(system.pidPath, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    await new Promise(resolve => setTimeout(resolve, 500));
    await expect(fs.access(system.sentinelPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a mismatched byte binding before semantic evaluation", async () => {
    const source = await sourceBinding();
    source.sha256 = "0".repeat(64);
    await expect(run("read_content", { max_pages: 1 }, null, source)).rejects.toMatchObject({
      code: "PDF_CHANGED_DURING_READ",
    });
  });

  it("keeps both committed runtimes free of direct PDF.js semantic evaluation", async () => {
    const forbidden = [
      /pdfjs-dist/,
      /\.getDocument\s*\(/,
      /\.getTextContent\s*\(/,
      /\.getOperatorList\s*\(/,
      /\.render\s*\(/,
    ];
    for (const relativePath of [
      "server/index.js",
      "pdf-toolkit-mcp-share/server/index.js",
    ]) {
      const source = await fs.readFile(path.join(REPO_ROOT, relativePath), "utf8");
      for (const pattern of forbidden) expect(source, `${relativePath}: ${pattern}`).not.toMatch(pattern);
    }
  });
});
