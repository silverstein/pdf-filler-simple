import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { configDefaults } from "vitest/config";
import viteConfigFactory from "../vite.config.mjs";
import { extractModuleLoadEvidence } from "../scripts/javascript-module-load-evidence.mjs";
import {
  NODE_TEST_FILES,
  NODE_TEST_SUITES,
  nodeTestFilesForPlatform,
  nodeTestOmissionsForPlatform,
} from "../scripts/node-test-files.mjs";
import {
  controlledVitestEnvironment,
  RunnerExitError,
  runAllTestSuites,
  validateAggregateArguments,
  validateAggregateExitCode,
} from "../scripts/run-all-test-suites.mjs";
import { parseNodeTestArguments } from "../scripts/run-node-test-suites.mjs";
import {
  CHECKOUT_LOCAL_MUTATING_TEST_SUITES,
  NON_EXECUTABLE_SOURCE_IDENTITY_REFERENCES,
  REAL_CHECKOUT_SOURCE_IDENTITY_BINDERS,
  REVIEWED_COMPUTED_MODULE_LOADS,
  SOURCE_IDENTITY_TEST_FILES,
  SOURCE_IDENTITY_TEST_SUITES,
  SOURCE_IDENTITY_TRANSITIVE_MODULES,
  SYNTHETIC_SOURCE_IDENTITY_IMPORTERS,
} from "../scripts/test-suite-classification.mjs";
import {
  terminateWindowsTree,
  windowsTaskkillPath,
} from "../scripts/test-process-control.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

async function waitForProcessToDisappear(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`cancelled fixture process ${pid} is still alive`);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function findNodeTestFiles(directory = path.join(repoRoot, "test")) {
  const matches = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      matches.push(...await findNodeTestFiles(absolutePath));
      continue;
    }
    if (!entry.isFile() || !/\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/.test(entry.name)) continue;
    const source = await fs.readFile(absolutePath, "utf8");
    if (!/(?:from\s+|require\(\s*)["']node:test["']/.test(source)) continue;
    matches.push(path.relative(repoRoot, absolutePath).split(path.sep).join("/"));
  }
  return matches.sort();
}

const sourceExtensions = Object.freeze([
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
]);

async function findJavaScriptSourceFiles(directory) {
  const matches = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => (
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  ));
  for (const entry of entries) {
    if (
      entry.isDirectory()
      && new Set([
        ".git",
        ".beads",
        "coverage",
        "dist",
        "dist-ui",
        "node_modules",
      ]).has(entry.name)
    ) {
      continue;
    }
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      matches.push(...await findJavaScriptSourceFiles(absolutePath));
      continue;
    }
    if (entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name)) {
      matches.push(path.relative(repoRoot, absolutePath).split(path.sep).join("/"));
    }
  }
  return matches;
}

function relativeModuleSpecifier(file, target) {
  const relative = path.posix.relative(path.posix.dirname(file), target);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function localImportTargets({
  evidence,
  file,
  nonExecutableReferences,
  sourceFileSet,
}) {
  const targetsForFile = new Set();
  for (const occurrence of evidence.stringLiterals.filter(entry =>
    entry.value.startsWith("./") || entry.value.startsWith("../"))) {
    const reference = occurrence.value;
    const specifier = reference.split(/[?#]/, 1)[0];
    const unresolved = path.relative(
      repoRoot,
      path.resolve(path.dirname(path.join(repoRoot, file)), specifier),
    ).split(path.sep).join("/");
    const extension = path.posix.extname(unresolved);
    const candidates = extension
      ? [unresolved]
      : [
          unresolved,
          ...sourceExtensions.map(suffix => `${unresolved}${suffix}`),
          ...sourceExtensions.map(suffix => `${unresolved}/index${suffix}`),
        ];
    const targets = candidates.filter(candidate => sourceFileSet.has(candidate));
    if (targets.length > 1) {
      throw new Error(`ambiguous local source reference in ${file}: ${reference}`);
    }
    const [target] = targets;
    if (!target) continue;
    const exemptionKey = `${file}\0${target}`;
    if (nonExecutableReferences.has(exemptionKey)) {
      const expectedReference = relativeModuleSpecifier(file, target);
      const exactDataReads = evidence.newUrlReferences.filter(
        entry => entry.literal === expectedReference,
      );
      if (
        exactDataReads.length === 1
        && occurrence.start === exactDataReads[0].referenceStart
        && occurrence.end === exactDataReads[0].referenceEnd
      ) {
        continue;
      }
    }
    targetsForFile.add(target);
  }
  return targetsForFile;
}

async function localImportGraph(sourceFiles) {
  const graph = new Map(sourceFiles.map(file => [file, new Set()]));
  const sourceFileSet = new Set(sourceFiles);
  const nonExecutableReferences = new Set(
    NON_EXECUTABLE_SOURCE_IDENTITY_REFERENCES.map(entry =>
      `${entry.file}\0${entry.target}`),
  );
  for (const file of sourceFiles) {
    const source = await fs.readFile(path.join(repoRoot, file), "utf8");
    const evidence = extractModuleLoadEvidence(source, { filename: file });
    graph.set(file, localImportTargets({
      evidence,
      file,
      nonExecutableReferences,
      sourceFileSet,
    }));
  }
  return graph;
}

function graphReachesAny(graph, start, targets) {
  const pending = [start];
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (targets.has(current)) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...graph.get(current) ?? []);
  }
  return false;
}

describe("aggregate test-runner contract", () => {
  it("recognizes every supported literal module edge conservatively", () => {
    const checkerSpecifier = "./source-worktree-" + "state.mjs";
    const source = [
      'import "./side-effect.mjs";',
      'export * from "./reexport.mjs";',
      `import * as sourceState from "${checkerSpecifier}";`,
      'const dynamic = import("./dynamic.mjs?proof=1");',
      'const commonjs = require("./commonjs.cjs");',
      'const readOnly = new URL("./read-as-data.mjs", import.meta.url);',
    ].join("\n");
    const evidence = extractModuleLoadEvidence(source);
    expect(evidence.stringValues.filter(value => value.startsWith("."))).toEqual([
      "./side-effect.mjs",
      "./reexport.mjs",
      checkerSpecifier,
      "./dynamic.mjs?proof=1",
      "./commonjs.cjs",
      "./read-as-data.mjs",
    ]);
    expect(evidence.dynamicImports).toHaveLength(1);
    expect(evidence.dynamicImports[0]).toMatchObject({
      literal: "./dynamic.mjs?proof=1",
    });

    const escapedCheckerSpecifier = ".\\/" + "source-worktree-" + "state.mjs";
    const adversarial = extractModuleLoadEvidence([
      'import("./" + moduleName);',
      'import("." + "/source-worktree-" + "state.mjs");',
      `import * as escaped from "${escapedCheckerSpecifier}";`,
      'import(`./local-${name}.mjs`);',
    ].join("\n"));
    expect(adversarial.dynamicImports.map(entry => entry.literal)).toEqual([
      null,
      null,
      null,
    ]);
    expect(adversarial.dynamicImports.map(entry => entry.fingerprint))
      .toHaveLength(3);
    expect(adversarial.stringValues).toContain(checkerSpecifier);
    expect(extractModuleLoadEvidence(
      'const nested = `proof:${import(moduleUrl)}`;',
    ).dynamicImports).toHaveLength(1);
    expect(extractModuleLoadEvidence(
      'const decoy = `proof:${"import(moduleUrl)"}`;',
    ).dynamicImports).toHaveLength(0);
    expect(extractModuleLoadEvidence("import(firstUrl)").dynamicImports[0]
      .fingerprint).not.toBe(
      extractModuleLoadEvidence("import(secondUrl)").dynamicImports[0]
        .fingerprint,
    );
    expect(extractModuleLoadEvidence(
      "counter++ / import(moduleUrl) / divisor;",
    ).dynamicImports).toHaveLength(1);
    expect(extractModuleLoadEvidence(
      "counter-- / import(otherUrl) / divisor;",
    ).dynamicImports).toHaveLength(1);
    expect(extractModuleLoadEvidence(
      "const decoy = / import(decoyUrl) /;",
    ).dynamicImports).toHaveLength(0);
    expect(extractModuleLoadEvidence(
      "value! / import(moduleUrl) / divisor;",
      { filename: "postfix-non-null.ts" },
    ).dynamicImports).toHaveLength(1);
    expect(extractModuleLoadEvidence(
      "! /import(decoyUrl)/.test(text);",
      { filename: "prefix-not-regex.ts" },
    ).dynamicImports).toHaveLength(0);
    expect(extractModuleLoadEvidence(
      "<Component /> / import(moduleUrl) / divisor;",
      { filename: "element-division.jsx" },
    ).dynamicImports).toHaveLength(1);
    expect(extractModuleLoadEvidence(
      "value > /import(decoyUrl)/.test(text);",
      { filename: "comparison-regex.jsx" },
    ).dynamicImports).toHaveLength(0);
    expect(extractModuleLoadEvidence(
      'const nested = `outer:${`inner:${import(nestedUrl)}`}`;',
    ).dynamicImports).toHaveLength(1);

    const readerFile = "test/reader.test.js";
    const readerTarget = "test/source.mjs";
    const sourceFileSet = new Set([readerFile, readerTarget]);
    const nonExecutableReferences = new Set([
      `${readerFile}\0${readerTarget}`,
    ]);
    const targetsFor = source => localImportTargets({
      evidence: extractModuleLoadEvidence(source),
      file: readerFile,
      nonExecutableReferences,
      sourceFileSet,
    });
    expect(targetsFor(
      'const source = new URL("./source.mjs", import.meta.url);',
    )).toEqual(new Set());
    expect(targetsFor([
      'const source = new URL("./source.mjs", import.meta.url);',
      'await import("./source.mjs");',
    ].join("\n"))).toEqual(new Set([readerTarget]));
    expect(targetsFor([
      '// const source = new URL("./source.mjs", import.meta.url);',
      'await import("./source.mjs");',
    ].join("\n"))).toEqual(new Set([readerTarget]));

    const graph = new Map([
      ["suite", new Set(["helper"])],
      ["helper", new Set(["reexport"])],
      ["reexport", new Set(["binder"])],
      ["binder", new Set()],
    ]);
    expect(graphReachesAny(graph, "suite", new Set(["binder"]))).toBe(true);
  });

  it("classifies the complete reviewed import closure to every real-checkout source binder", async () => {
    const nativeFiles = new Set(NODE_TEST_FILES);
    const discoveredVitestFiles = [];
    const visit = async directory => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(absolutePath);
          continue;
      }
        if (!entry.isFile() || !/\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/.test(entry.name)) continue;
        const relativePath = path.relative(repoRoot, absolutePath).split(path.sep).join("/");
        if (!nativeFiles.has(relativePath)) {
          discoveredVitestFiles.push(relativePath);
        }
      }
    };
    await visit(path.join(repoRoot, "test"));

    const allSourceFiles = await findJavaScriptSourceFiles(repoRoot);
    const graph = await localImportGraph(allSourceFiles);
    const binderFiles = REAL_CHECKOUT_SOURCE_IDENTITY_BINDERS.map(entry => entry.file);
    const closureFiles = [
      ...binderFiles,
      ...SOURCE_IDENTITY_TRANSITIVE_MODULES.map(entry => entry.file),
    ];
    const reviewedImporters = new Set([
      ...closureFiles,
      ...SOURCE_IDENTITY_TEST_FILES,
    ]);
    const closureSet = new Set(closureFiles);
    const binderSet = new Set(binderFiles);
    const unreviewedClosureImporters = allSourceFiles.filter(file =>
      !reviewedImporters.has(file)
      && [...graph.get(file) ?? []].some(target => closureSet.has(target)));

    expect(unreviewedClosureImporters).toEqual([]);
    expect(closureFiles.every(file => graph.has(file))).toBe(true);
    expect(SOURCE_IDENTITY_TEST_FILES.every(file =>
      graphReachesAny(graph, file, binderSet))).toBe(true);
    expect(SOURCE_IDENTITY_TRANSITIVE_MODULES.every(entry =>
      graphReachesAny(graph, entry.file, binderSet))).toBe(true);
    expect(graph.get("test/eval/agent-workflow-v3-retirement.test.js")?.has(
      "scripts/eval-prepare-agent-workflow-campaign-v3.mjs",
    )).toBe(false);
    expect(SOURCE_IDENTITY_TEST_FILES).not.toContain(
      "test/eval/agent-workflow-v3-retirement.test.js",
    );
    expect(graphReachesAny(
      graph,
      "test/source-worktree-state.test.js",
      binderSet,
    )).toBe(false);

    const genericCheckerModule = [
      "scripts/source-worktree-",
      "state.mjs",
    ].join("");
    const genericCheckerImporters = allSourceFiles.filter(file =>
      graph.get(file)?.has(genericCheckerModule));
    expect(genericCheckerImporters.sort()).toEqual([
      ...binderFiles,
      ...SYNTHETIC_SOURCE_IDENTITY_IMPORTERS.map(entry => entry.file),
    ].sort());

    expect(Object.isFrozen(SOURCE_IDENTITY_TEST_SUITES)).toBe(true);
    expect(Object.isFrozen(SOURCE_IDENTITY_TEST_FILES)).toBe(true);
    expect(Object.isFrozen(REAL_CHECKOUT_SOURCE_IDENTITY_BINDERS)).toBe(true);
    expect(Object.isFrozen(NON_EXECUTABLE_SOURCE_IDENTITY_REFERENCES)).toBe(true);
    expect(Object.isFrozen(CHECKOUT_LOCAL_MUTATING_TEST_SUITES)).toBe(true);
    expect(Object.isFrozen(REVIEWED_COMPUTED_MODULE_LOADS)).toBe(true);
    expect(Object.isFrozen(SOURCE_IDENTITY_TRANSITIVE_MODULES)).toBe(true);
    expect(Object.isFrozen(SYNTHETIC_SOURCE_IDENTITY_IMPORTERS)).toBe(true);
    expect(REVIEWED_COMPUTED_MODULE_LOADS.every(entry =>
      Object.isFrozen(entry)
      && Object.isFrozen(entry.fingerprints)
      && entry.fingerprints.length === entry.count
      && entry.reason.length > 0)).toBe(true);
    expect(new Set(SOURCE_IDENTITY_TEST_FILES).size).toBe(SOURCE_IDENTITY_TEST_FILES.length);
    expect(SOURCE_IDENTITY_TEST_SUITES.every(
      suite => suite.reason.length > 0 && discoveredVitestFiles.includes(suite.file),
    )).toBe(true);
    expect(SOURCE_IDENTITY_TEST_FILES.every(file => !nativeFiles.has(file))).toBe(true);

    const allocatorModule = "test/helpers/temp-directory.js";
    const discoveredMutatingTests = discoveredVitestFiles.filter(file =>
      graphReachesAny(graph, file, new Set([allocatorModule])));
    expect(discoveredMutatingTests.sort()).toEqual(
      [...CHECKOUT_LOCAL_MUTATING_TEST_SUITES].sort(),
    );

    const discoveredComputedLoads = [];
    for (const file of allSourceFiles) {
      const source = await fs.readFile(path.join(repoRoot, file), "utf8");
      const computed = extractModuleLoadEvidence(source, { filename: file })
        .dynamicImports.filter(entry => entry.literal === null);
      if (computed.length > 0) {
        discoveredComputedLoads.push({
          file,
          count: computed.length,
          fingerprints: computed.map(entry => entry.fingerprint),
        });
      }
    }
    expect(discoveredComputedLoads).toEqual(
      REVIEWED_COMPUTED_MODULE_LOADS.map(
        ({ file, count, fingerprints }) => ({
          file,
          count,
          fingerprints: [...fingerprints],
        }),
      ),
    );
  });

  it("classifies every node:test suite exactly once", async () => {
    expect([...NODE_TEST_FILES].sort()).toEqual(await findNodeTestFiles());
    expect(new Set(NODE_TEST_FILES).size).toBe(NODE_TEST_FILES.length);
    expect(Object.isFrozen(NODE_TEST_SUITES)).toBe(true);
    expect(NODE_TEST_SUITES.every(suite => suite.platforms.length > 0)).toBe(true);
    expect(NODE_TEST_SUITES.every(suite => Object.isFrozen(suite))).toBe(true);
    for (const platform of ["darwin", "linux", "win32"]) {
      for (const omission of nodeTestOmissionsForPlatform(platform)) {
        expect(omission.reason).toEqual(expect.any(String));
        expect(omission.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it("uses exact, explicit native-suite partitions on each release platform", () => {
    expect(nodeTestFilesForPlatform("win32")).toEqual([
      "test/deep-malformed-native-v2-contract.test.js",
      "test/deep-malformed-native-v3-contract.test.js",
      "test/deep-malformed-native-v4-contract.test.js",
      "test/qpdf-macos-budget-exec.test.js",
      "test/deep-malformed-native-windows-portable.test.js",
    ]);
    const posixFiles = [
      "test/deep-malformed-native-v2-contract.test.js",
      "test/deep-malformed-native-v2-mechanisms.test.js",
      "test/deep-malformed-native-v3-contract.test.js",
      "test/deep-malformed-native-v3-mechanisms.test.js",
      "test/deep-malformed-native-v4-contract.test.js",
      "test/deep-malformed-native-v4-mechanisms.test.js",
      "test/qpdf-macos-budget-exec.test.js",
    ];
    expect(nodeTestFilesForPlatform("darwin")).toEqual(posixFiles);
    expect(nodeTestFilesForPlatform("linux")).toEqual(posixFiles);
    expect(NODE_TEST_FILES).toEqual([
      ...posixFiles,
      "test/deep-malformed-native-windows-portable.test.js",
    ]);
    expect(() => nodeTestFilesForPlatform("android")).toThrow(
      "Unsupported native test platform",
    );
  });

  it("runs ordinary tests before an exclusive source-identity project", () => {
    const config = viteConfigFactory({ command: "build", mode: "test" });
    expect(config.test.exclude).toEqual([
      ...configDefaults.exclude,
      ...NODE_TEST_FILES,
    ]);
    const projects = config.test.projects ?? [];
    expect(projects.map(project => project.test?.name)).toEqual([
      "ordinary",
      "source-identity",
    ]);
    expect(projects.every(project => project.extends === true)).toBe(true);
    expect(projects[0]?.test).toMatchObject({
      pool: "forks",
      isolate: true,
      sequence: { groupOrder: 0 },
    });
    expect(projects[0]?.test?.exclude).toEqual([
      ...configDefaults.exclude,
      ...NODE_TEST_FILES,
      ...SOURCE_IDENTITY_TEST_FILES,
    ]);
    expect(projects[1]?.test).toMatchObject({
      include: SOURCE_IDENTITY_TEST_FILES,
      pool: "forks",
      isolate: true,
      fileParallelism: false,
      maxWorkers: 1,
      sequence: { groupOrder: 1 },
    });
  });

  it("exposes explicit aggregate and native runner scripts", async () => {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(repoRoot, "package.json"), "utf8"),
    );
    expect(packageJson.scripts["test:node-native"]).toBe(
      "node scripts/run-node-test-suites.mjs",
    );
    expect(packageJson.scripts["test:all"]).toBe(
      "node scripts/run-all-test-suites.mjs",
    );
  });

  it("rejects coverage-changing aggregate and native-runner arguments", () => {
    expect(parseNodeTestArguments([])).toEqual({ reporter: "spec" });
    expect(parseNodeTestArguments(["--reporter=tap"])).toEqual({
      reporter: "tap",
    });
    expect(() => parseNodeTestArguments(["--test-shard=1/2"])).toThrow(
      "Unsupported native-test argument",
    );
    expect(() => parseNodeTestArguments([
      "--reporter=tap",
      "--reporter=spec",
    ])).toThrow("only once");
    expect(() => validateAggregateArguments(["--reporter=tap"])).toThrow(
      "does not accept",
    );
  });

  it("removes the Vitest worker override from the controlled aggregate child", () => {
    expect(controlledVitestEnvironment({
      OFFLINE: "0",
      PATH: "fixture-path",
      VITEST_MAX_WORKERS: "8",
      VITEST_POOL_ID: "fixture-pool",
      VITEST_WORKER_ID: "fixture-worker",
      vitest_max_workers: "4",
    })).toEqual({
      OFFLINE: "0",
      PATH: "fixture-path",
    });
    expect(controlledVitestEnvironment({ PATH: "fixture-path" })).toEqual({
      OFFLINE: "1",
      PATH: "fixture-path",
    });
  });

  it("checks source identity around every aggregate runner partition", async () => {
    const events = [];
    const exitCode = await runAllTestSuites([], {
      verifyNodeVersion: () => events.push("node"),
      verifySourceState: async phase => {
        events.push(`source:${phase}`);
        return HEAD_A;
      },
      runVitest: async () => {
        events.push("vitest");
        return 0;
      },
      runNative: async () => {
        events.push("native");
        return 0;
      },
    });
    expect(exitCode).toBe(0);
    expect(events).toEqual([
      "node",
      "source:before Vitest",
      "vitest",
      "source:after Vitest",
      "native",
      "source:after native tests",
    ]);

    const failedEvents = [];
    const failedExitCode = await runAllTestSuites([], {
      verifyNodeVersion: () => failedEvents.push("node"),
      verifySourceState: async phase => {
        failedEvents.push(`source:${phase}`);
        return HEAD_A;
      },
      runVitest: async () => {
        failedEvents.push("vitest");
        return 1;
      },
      runNative: async () => {
        failedEvents.push("native");
        return 0;
      },
    });
    expect(failedExitCode).toBe(1);
    expect(failedEvents).toEqual([
      "node",
      "source:before Vitest",
      "vitest",
      "source:after Vitest",
    ]);

    const nativeEvents = [];
    const nativeExitCode = await runAllTestSuites([], {
      verifyNodeVersion: () => nativeEvents.push("node"),
      verifySourceState: async phase => {
        nativeEvents.push(`source:${phase}`);
        return HEAD_A;
      },
      runVitest: async () => {
        nativeEvents.push("vitest");
        return 0;
      },
      runNative: async () => {
        nativeEvents.push("native");
        return 7;
      },
    });
    expect(nativeExitCode).toBe(7);
    expect(nativeEvents).toEqual([
      "node",
      "source:before Vitest",
      "vitest",
      "source:after Vitest",
      "native",
      "source:after native tests",
    ]);
  });

  it("runs post-partition source checks even when a runner throws", async () => {
    const events = [];
    await expect(runAllTestSuites([], {
      verifyNodeVersion: () => {},
      verifySourceState: async phase => {
        events.push(phase);
        return HEAD_A;
      },
      runVitest: async () => {
        throw new Error("fixture runner failure");
      },
      runNative: async () => 0,
    })).rejects.toThrow("fixture runner failure");
    expect(events).toEqual(["before Vitest", "after Vitest"]);

    const nativeEvents = [];
    await expect(runAllTestSuites([], {
      verifyNodeVersion: () => {},
      verifySourceState: async phase => {
        nativeEvents.push(phase);
        return HEAD_A;
      },
      runVitest: async () => 0,
      runNative: async () => {
        throw new Error("fixture native failure");
      },
    })).rejects.toThrow("fixture native failure");
    expect(nativeEvents).toEqual([
      "before Vitest",
      "after Vitest",
      "after native tests",
    ]);
  });

  it("rejects source commit movement after either aggregate partition", async () => {
    await expect(runAllTestSuites([], {
      verifyNodeVersion: () => {},
      verifySourceState: async phase =>
        phase === "before Vitest" ? HEAD_A : HEAD_B,
      runVitest: async () => 0,
      runNative: async () => {
        throw new Error("native must not start after source movement");
      },
    })).rejects.toThrow(`changed from ${HEAD_A} to ${HEAD_B} after Vitest`);

    const commits = [HEAD_A, HEAD_A, HEAD_B];
    await expect(runAllTestSuites([], {
      verifyNodeVersion: () => {},
      verifySourceState: async () => commits.shift(),
      runVitest: async () => 0,
      runNative: async () => 0,
    })).rejects.toThrow(`changed from ${HEAD_A} to ${HEAD_B} after native tests`);
  });

  it("awaits Node verification before starting source or runner work", async () => {
    const events = [];
    await expect(runAllTestSuites([], {
      verifyNodeVersion: async () => {
        events.push("node");
        throw new Error("unsupported fixture Node");
      },
      verifySourceState: async () => {
        events.push("source");
        return HEAD_A;
      },
      runVitest: async () => {
        events.push("vitest");
        return 0;
      },
      runNative: async () => {
        events.push("native");
        return 0;
      },
    })).rejects.toThrow("unsupported fixture Node");
    expect(events).toEqual(["node"]);
  });

  it("requires bounded integer exit codes from both aggregate runners", async () => {
    const invalidExitCodes = [
      undefined,
      null,
      "0",
      Number.NaN,
      -1,
      256,
      Number.MAX_SAFE_INTEGER + 1,
    ];
    for (const value of invalidExitCodes) {
      expect(() => validateAggregateExitCode(value, "fixture")).toThrow(
        "fixture returned an invalid exit code",
      );
      await expect(runAllTestSuites([], {
        verifyNodeVersion: () => {},
        verifySourceState: async () => HEAD_A,
        runVitest: async () => value,
        runNative: async () => 0,
      })).rejects.toThrow("test:all:vitest returned an invalid exit code");
      await expect(runAllTestSuites([], {
        verifyNodeVersion: () => {},
        verifySourceState: async () => HEAD_A,
        runVitest: async () => 0,
        runNative: async () => value,
      })).rejects.toThrow("test:all:native returned an invalid exit code");
    }
  });

  it("preserves both runner and post-run source failures", async () => {
    const runnerError = new Error("fixture runner failure");
    const sourceError = new Error("fixture source failure");
    let verificationCount = 0;
    let caught;
    try {
      await runAllTestSuites([], {
        verifyNodeVersion: () => {},
        verifySourceState: async () => {
          verificationCount += 1;
          if (verificationCount === 1) return HEAD_A;
          throw sourceError;
        },
        runVitest: async () => {
          throw runnerError;
        },
        runNative: async () => 0,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught.errors).toEqual([runnerError, sourceError]);

    verificationCount = 0;
    const nativeRunnerError = new Error("fixture native failure");
    try {
      await runAllTestSuites([], {
        verifyNodeVersion: () => {},
        verifySourceState: async () => {
          verificationCount += 1;
          if (verificationCount < 3) return HEAD_A;
          throw sourceError;
        },
        runVitest: async () => 0,
        runNative: async () => {
          throw nativeRunnerError;
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught.errors).toEqual([nativeRunnerError, sourceError]);
  });

  it("preserves valid nonzero runner exits when the source barrier also fails", async () => {
    for (const exitCode of [1, 143]) {
      let verificationCount = 0;
      let caught;
      try {
        await runAllTestSuites([], {
          verifyNodeVersion: () => {},
          verifySourceState: async () => {
            verificationCount += 1;
            if (verificationCount === 1) return HEAD_A;
            throw new Error("fixture source failure");
          },
          runVitest: async () => exitCode,
          runNative: async () => 0,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AggregateError);
      expect(caught.errors[0]).toBeInstanceOf(RunnerExitError);
      expect(caught.errors[0]).toMatchObject({ exitCode });
      expect(caught.errors[1].message).toBe("fixture source failure");
    }

    let verificationCount = 0;
    let caught;
    try {
      await runAllTestSuites([], {
        verifyNodeVersion: () => {},
        verifySourceState: async () => {
          verificationCount += 1;
          if (verificationCount < 3) return HEAD_A;
          throw new Error("fixture native source failure");
        },
        runVitest: async () => 0,
        runNative: async () => 7,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught.errors[0]).toBeInstanceOf(RunnerExitError);
    expect(caught.errors[0]).toMatchObject({ exitCode: 7 });
    expect(caught.errors[1].message).toBe("fixture native source failure");
  });

  it("resolves Windows tree termination through the system directory", () => {
    expect(windowsTaskkillPath({ SystemRoot: "C:\\Windows" })).toBe(
      "C:\\Windows\\System32\\taskkill.exe",
    );
    expect(windowsTaskkillPath({})).toBe("taskkill.exe");
  });

  it("bounds Windows taskkill and treats only exit zero as verified", async () => {
    const successfulChild = { pid: 321, kill: vi.fn(() => true) };
    const successfulKiller = new EventEmitter();
    successfulKiller.kill = vi.fn();
    const successfulSpawn = vi.fn(() => successfulKiller);
    const successfulTermination = terminateWindowsTree(successfulChild, {
      environment: { SystemRoot: "C:\\Windows" },
      timeoutMs: 100,
      spawnProcess: successfulSpawn,
    });
    successfulKiller.emit("close", 0, null);
    await expect(successfulTermination).resolves.toEqual({
      verified: true,
      reason: null,
    });
    expect(successfulChild.kill).not.toHaveBeenCalled();
    expect(successfulSpawn).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\taskkill.exe",
      ["/PID", "321", "/T", "/F"],
      expect.objectContaining({ windowsHide: true }),
    );

    const failedChild = { pid: 654, kill: vi.fn(() => true) };
    const failedKiller = new EventEmitter();
    failedKiller.kill = vi.fn();
    const failedTermination = terminateWindowsTree(failedChild, {
      environment: {},
      timeoutMs: 100,
      spawnProcess: () => failedKiller,
    });
    failedKiller.emit("close", 1, null);
    await expect(failedTermination).resolves.toEqual({
      verified: false,
      reason:
        "taskkill did not verify tree termination (code=1, signal=null)",
    });
    expect(failedChild.kill).toHaveBeenCalledWith("SIGKILL");

    const hungChild = { pid: 987, kill: vi.fn(() => true) };
    const hungKiller = new EventEmitter();
    hungKiller.kill = vi.fn();
    await expect(terminateWindowsTree(hungChild, {
      environment: {},
      timeoutMs: 10,
      spawnProcess: () => hungKiller,
    })).resolves.toEqual({
      verified: false,
      reason: "taskkill exceeded 10 ms",
    });
    expect(hungKiller.kill).toHaveBeenCalledWith("SIGKILL");
    expect(hungChild.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it.skipIf(process.platform === "win32")(
    "forwards cancellation and reaps the complete POSIX test process group",
    async () => {
      const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "node-runner-signal-"));
      const pidFile = path.join(root, "fixture.pid");
      const helper = spawn(process.execPath, [
        path.join(repoRoot, "test/fixtures/run-node-test-suites-signal-helper.mjs"),
      ], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PDF_TOOLS_NODE_RUNNER_FIXTURE_PID_FILE: pidFile,
        },
        stdio: "ignore",
      });
      let fixturePid = null;
      try {
        const deadline = Date.now() + 5_000;
        while (true) {
          try {
            await fs.access(pidFile);
            break;
          } catch {
            if (Date.now() >= deadline) throw new Error("signal fixture did not start");
            await new Promise(resolve => setTimeout(resolve, 20));
          }
        }
        fixturePid = Number(await fs.readFile(pidFile, "utf8"));
        expect(Number.isSafeInteger(fixturePid)).toBe(true);
        helper.kill("SIGTERM");
        const exit = await Promise.race([
          new Promise(resolve => helper.once("close", (code, signal) => resolve({ code, signal }))),
          new Promise((_, reject) => setTimeout(
            () => reject(new Error("test runner did not terminate")),
            5_000,
          )),
        ]);
        expect(exit).toEqual({ code: 143, signal: null });
        await waitForProcessToDisappear(fixturePid);
      } finally {
        if (helper.exitCode === null && helper.signalCode === null) helper.kill("SIGKILL");
        if (fixturePid !== null) {
          try {
            process.kill(fixturePid, "SIGKILL");
          } catch {}
        }
        await fs.rm(root, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
