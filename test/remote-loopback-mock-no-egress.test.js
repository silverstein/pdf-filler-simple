import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { isForbiddenArchivePath } from "../scripts/mcpb-packaging-policy.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const PRELOAD = path.join(
  REPO_ROOT,
  "test/fixtures/remote-loopback/no-egress-preload.mjs",
);
const CHILD = path.join(
  REPO_ROOT,
  "test/fixtures/remote-loopback/no-egress-child.mjs",
);
const STATIC_IMPORT_PARSER = path.join(
  REPO_ROOT,
  "test/fixtures/remote-loopback/static-import-parser.mjs",
);
const REVIEWED_CLOSURE = Object.freeze([
  "test/helpers/remote-loopback-state.mjs",
  "test/helpers/remote-loopback-http.mjs",
  "test/helpers/remote-loopback-mcp-mock.mjs",
]);

async function runGuardedChild(mode) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import",
      PRELOAD,
      CHILD,
      mode,
    ], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let forced = false;
    const deadline = setTimeout(() => {
      forced = true;
      child.kill("SIGKILL");
    }, 5_000);
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      clearTimeout(deadline);
      resolve({
        exitCode,
        signal,
        forced,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
  expect(result.forced, "child required a forced kill").toBe(false);
  expect(result.signal).toBeNull();
  expect(result.exitCode, result.stderr).toBe(0);
  const lines = result.stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]);
}

async function parseModuleLoads(filename) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--no-warnings",
      "--experimental-vm-modules",
      STATIC_IMPORT_PARSER,
      filename,
    ], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", exitCode => resolve({
      exitCode,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
  expect(result.exitCode, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe("remote loopback MCP mock no-egress evidence", () => {
  it("calibrates every runtime guard before accepting zero product attempts", async () => {
    const calibration = await runGuardedChild("calibration");
    expect(calibration.mode).toBe("calibration");
    expect(calibration.denials).toHaveLength(9);
    expect(calibration.denials.every(row => row.denied)).toBe(true);
    expect(calibration.telemetry).toEqual({
      allowed_loopback_socket_attempts: 0,
      external_socket_attempts: 1,
      dns_attempts: 2,
      literal_loopback_lookup_shortcuts: 0,
      fetch_attempts: 1,
      tls_attempts: 1,
      datagram_attempts: 1,
      bare_package_import_attempts: 1,
      unreviewed_module_import_attempts: 1,
      builtin_module_retrieval_attempts: 1,
      subprocess_escape_attempts: 1,
      process_binding_attempts: 1,
    });

    const product = await runGuardedChild("product");
    expect(product).toEqual({
      mode: "product",
      statuses: [200, 200, 200, 200, 200, 200, 200, 200, 200],
      telemetry: {
        allowed_loopback_socket_attempts: 9,
        external_socket_attempts: 0,
        dns_attempts: 0,
        literal_loopback_lookup_shortcuts: 1,
        fetch_attempts: 0,
        tls_attempts: 0,
        datagram_attempts: 0,
        bare_package_import_attempts: 0,
        unreviewed_module_import_attempts: 0,
        builtin_module_retrieval_attempts: 0,
        subprocess_escape_attempts: 0,
        process_binding_attempts: 0,
      },
    });
  });

  it("calibrates the exact socket host and port predicates independently", async () => {
    const calibration = await runGuardedChild(
      "socket_allowlist_calibration",
    );
    expect(calibration).toEqual({
      mode: "socket_allowlist_calibration",
      denials: [
        {
          name: "wrong_host_exact_port",
          denied: true,
          code: "PDF_LOOPBACK_GUARD_DENIED_SOCKET",
        },
        {
          name: "exact_host_wrong_port",
          denied: true,
          code: "PDF_LOOPBACK_GUARD_DENIED_SOCKET",
        },
      ],
      exact_tuple_allowed: true,
      telemetry: {
        allowed_loopback_socket_attempts: 1,
        external_socket_attempts: 2,
        dns_attempts: 0,
        literal_loopback_lookup_shortcuts: 1,
        fetch_attempts: 0,
        tls_attempts: 0,
        datagram_attempts: 0,
        bare_package_import_attempts: 0,
        unreviewed_module_import_attempts: 0,
        builtin_module_retrieval_attempts: 0,
        subprocess_escape_attempts: 0,
        process_binding_attempts: 0,
      },
    });
  });

  it("denies concealed builtin and file imports at the runtime loader", async () => {
    const calibration = await runGuardedChild(
      "dynamic_loader_calibration",
    );
    expect(calibration).toEqual({
      mode: "dynamic_loader_calibration",
      denials: [
        {
          name: "indirect_eval_builtin",
          denied: true,
          code: "PDF_LOOPBACK_GUARD_DENIED_MODULE_IMPORT",
        },
        {
          name: "function_constructor_builtin",
          denied: true,
          code: "PDF_LOOPBACK_GUARD_DENIED_MODULE_IMPORT",
        },
        {
          name: "indirect_eval_file",
          denied: true,
          code: "PDF_LOOPBACK_GUARD_DENIED_MODULE_IMPORT",
        },
      ],
      telemetry: {
        allowed_loopback_socket_attempts: 0,
        external_socket_attempts: 0,
        dns_attempts: 0,
        literal_loopback_lookup_shortcuts: 0,
        fetch_attempts: 0,
        tls_attempts: 0,
        datagram_attempts: 0,
        bare_package_import_attempts: 0,
        unreviewed_module_import_attempts: 3,
        builtin_module_retrieval_attempts: 0,
        subprocess_escape_attempts: 0,
        process_binding_attempts: 0,
      },
    });
  });

  it("has a literal reviewed import closure with no package or computed loads", async () => {
    const packageRoots = new Set();
    const localReferences = new Set();
    for (const file of REVIEWED_CLOSURE) {
      const source = await fs.readFile(path.join(REPO_ROOT, file), "utf8");
      const parsed = await parseModuleLoads(path.join(REPO_ROOT, file));
      expect(parsed.computed_loads, file).toEqual([]);
      const specifiers = parsed.dependency_specifiers;
      for (const value of specifiers) {
        if (value.startsWith("node:")) packageRoots.add(value);
        else if (value.startsWith("./") || value.startsWith("../")) {
          localReferences.add(value);
        } else {
          throw new Error(`${file}: unreviewed package import ${value}`);
        }
      }
    }
    expect([...packageRoots].sort()).toEqual([
      "node:crypto",
      "node:fs/promises",
      "node:http",
    ]);
    expect([...localReferences].sort()).toEqual([
      "./remote-loopback-http.mjs",
      "./remote-loopback-state.mjs",
    ]);
    const httpSource = await fs.readFile(
      path.join(REPO_ROOT, "test/helpers/remote-loopback-http.mjs"),
      "utf8",
    );
    expect(httpSource).toContain(
      '"../fixtures/eval/comparison/synthetic/comparison-base.pdf"',
    );
    const importMetaUrlReferences = [...httpSource.matchAll(
      /new URL\(\s*"([^"]+)"\s*,\s*import\.meta\.url\s*,?\s*\)/g,
    )].map(match => match[1]).sort();
    expect(importMetaUrlReferences).toEqual([
      "../../config/remote-hybrid-trust-boundary.v1.json",
      "../../config/remote-loopback-mock.v1.json",
      "../fixtures/eval/comparison/synthetic/comparison-base.pdf",
    ]);
    expect((httpSource.match(/new URL\(/g) ?? [])).toHaveLength(3);
    expect(
      [...packageRoots].filter(value => !value.startsWith("node:")),
    ).toEqual([]);
    const combined = await Promise.all(REVIEWED_CLOSURE.map(file =>
      fs.readFile(path.join(REPO_ROOT, file), "utf8")
    ));
    expect(combined.join("\n"))
      .not.toMatch(/@aws-sdk|googleapis|@azure|openai|anthropic/i);
  });

  it("detects comment-separated computed loads without flagging inert text", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "pdf-loopback-static-loads-"),
    );
    try {
      const hostile = path.join(directory, "hostile.mjs");
      await fs.writeFile(hostile, [
        "const inert = \"import /* text */ ('inert')\";",
        "const template = `inert import /* text */ ('inert')`;",
        "const nested = `value ${await import /* split */ ('provider-sdk')}`;",
        "require /* split */ ('provider-sdk');",
        "process /* split */ . getBuiltinModule('node:child_process');",
        "(0, eval)('process.getBuiltinModule');",
        "Function('return process')();",
        "process.binding('spawn_sync');",
        "process._linkedBinding('spawn_sync');",
      ].join("\n"));
      const parsed = await parseModuleLoads(hostile);
      expect(parsed.dependency_specifiers).toEqual([]);
      expect(parsed.computed_loads.map(load => load.kind))
        .toEqual([
          "import",
          "require",
          "getBuiltinModule",
          "eval",
          "Function",
          "binding",
          "_linkedBinding",
        ]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("is structurally excluded from every MCPB archive", async () => {
    const buildSource = await fs.readFile(
      path.join(REPO_ROOT, "scripts/build-mcpb.mjs"),
      "utf8",
    );
    const harnessPaths = [
      ...REVIEWED_CLOSURE,
      "test/helpers/remote-loopback-test-client.mjs",
      "test/fixtures/remote-loopback/no-egress-preload.mjs",
      "test/fixtures/remote-loopback/no-egress-child.mjs",
      "test/fixtures/remote-loopback/no-package-loader.mjs",
      "test/fixtures/remote-loopback/static-import-parser.mjs",
      "test/fixtures/remote-loopback/unreviewed-loader-sentinel.mjs",
      "test/remote-loopback-mock-transport.test.js",
      "test/remote-loopback-mock-state.test.js",
      "test/remote-loopback-mock-wire-state.test.js",
      "test/remote-loopback-mock-no-egress.test.js",
      "test/remote-loopback-mock-bounds-cleanup.test.js",
      "config/remote-loopback-mock.v1.json",
    ];
    for (const file of harnessPaths) {
      expect(isForbiddenArchivePath(file), file).toBe(true);
    }
    expect(buildSource).not.toMatch(
      /FIRST_PARTY_TEXT_FILES[\s\S]{0,800}remote-loopback-mock/,
    );
  });
});
