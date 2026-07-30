import fs from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  canvasCandidateRegistryAssetInventory,
  staticArchiveConformanceEvidence,
  verifyCanvasLockGraph,
  verifyCanvasNativeStageManifest,
} from "../scripts/build-mcpb.mjs";

const LOCK = JSON.parse(await fs.readFile(
  new URL("../package-lock.json", import.meta.url),
  "utf8",
));

const TARGETS = Object.freeze({
  "@napi-rs/canvas-darwin-arm64": {
    binary: "skia.darwin-arm64.node",
    cpu: "arm64",
    os: "darwin",
  },
  "@napi-rs/canvas-darwin-x64": {
    binary: "skia.darwin-x64.node",
    cpu: "x64",
    os: "darwin",
  },
  "@napi-rs/canvas-linux-x64-gnu": {
    binary: "skia.linux-x64-gnu.node",
    cpu: "x64",
    os: "linux",
  },
  "@napi-rs/canvas-win32-arm64-msvc": {
    binary: "skia.win32-arm64-msvc.node",
    cpu: "arm64",
    os: "win32",
  },
  "@napi-rs/canvas-win32-x64-msvc": {
    binary: "skia.win32-x64-msvc.node",
    cpu: "x64",
    os: "win32",
  },
});
const EXPECTED_0_1_99_PACKAGE_FILES = Object.freeze({
  "@napi-rs/canvas-darwin-arm64": Object.freeze([
    "README.md",
    "package.json",
    "skia.darwin-arm64.node",
  ]),
  "@napi-rs/canvas-darwin-x64": Object.freeze([
    "README.md",
    "package.json",
    "skia.darwin-x64.node",
  ]),
  "@napi-rs/canvas-linux-x64-gnu": Object.freeze([
    "README.md",
    "package.json",
    "skia.linux-x64-gnu.node",
  ]),
  "@napi-rs/canvas-win32-arm64-msvc": Object.freeze([
    "package.json",
    "skia.win32-arm64-msvc.node",
  ]),
  "@napi-rs/canvas-win32-x64-msvc": Object.freeze([
    "README.md",
    "icudtl.dat",
    "package.json",
    "skia.win32-x64-msvc.node",
  ]),
});

function clone(value) {
  return structuredClone(value);
}

function candidateLock(version) {
  const lock = clone(LOCK);
  lock.packages[""].dependencies["@napi-rs/canvas"] = `^${version}`;
  const canvas = lock.packages["node_modules/@napi-rs/canvas"];
  canvas.version = version;
  canvas.resolved =
    `https://registry.npmjs.org/@napi-rs/canvas/-/canvas-${version}.tgz`;
  for (const packageName of Object.keys(TARGETS)) {
    canvas.optionalDependencies[packageName] = version;
    const entry = lock.packages[`node_modules/${packageName}`];
    entry.version = version;
    entry.resolved =
      `https://registry.npmjs.org/${packageName}/-/${packageName.split("/")[1]}-${version}.tgz`;
  }
  return lock;
}

function manifestEntry(relativePath, value) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(
        typeof value === "string" ? value : `${JSON.stringify(value)}\n`,
      );
  return {
    path: relativePath,
    bytes,
    size: bytes.length,
  };
}

function stageManifest(policy) {
  const files = [
    manifestEntry(
      "node_modules/@napi-rs/canvas/package.json",
      {
        name: "@napi-rs/canvas",
        version: policy.implementationVersion,
      },
    ),
  ];
  for (const target of policy.packages) {
    const prefix = `node_modules/${target.packageName}`;
    const metadata = target.packageName
      === "@napi-rs/canvas-win32-arm64-msvc"
      ? []
      : [manifestEntry(`${prefix}/README.md`, "package documentation")];
    files.push(
      manifestEntry(`${prefix}/package.json`, {
        name: target.packageName,
        version: target.version,
        os: [target.os],
        cpu: [target.cpu],
        files: target.assets,
      }),
      ...metadata,
      ...target.assets.map(asset =>
        manifestEntry(`${prefix}/${asset}`, `asset:${target.packageName}:${asset}`),
      ),
    );
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function replaceJson(files, relativePath, mutate) {
  return files.map(file => {
    if (file.path !== relativePath) return file;
    const value = JSON.parse(file.bytes.toString("utf8"));
    mutate(value);
    return manifestEntry(relativePath, value);
  });
}

describe("native canvas packaging policy", () => {
  it("accepts the protected 0.1.99 lock and its asymmetric Windows assets", () => {
    const policy = verifyCanvasLockGraph(clone(LOCK));
    expect(policy.implementationVersion).toBe("0.1.99");
    expect(policy.packages).toHaveLength(5);
    for (const target of policy.packages) {
      expect(target.assets).toEqual(
        target.packageName === "@napi-rs/canvas-win32-x64-msvc"
          ? [TARGETS[target.packageName].binary, "icudtl.dat"]
          : [TARGETS[target.packageName].binary],
      );
    }
    const files = stageManifest(policy);
    for (const target of policy.packages) {
      const prefix = `node_modules/${target.packageName}/`;
      expect(
        files
          .filter(file => file.path.startsWith(prefix))
          .map(file => file.path.slice(prefix.length))
          .sort(),
      ).toEqual([...EXPECTED_0_1_99_PACKAGE_FILES[target.packageName]].sort());
    }
    expect(() =>
      verifyCanvasNativeStageManifest(files, policy),
    ).not.toThrow();

    const x64Icu =
      "node_modules/@napi-rs/canvas-win32-x64-msvc/icudtl.dat";
    expect(() =>
      verifyCanvasNativeStageManifest(
        files.filter(file => file.path !== x64Icu),
        policy,
      ),
    ).toThrow(/required native canvas (?:asset|package file)/i);
    expect(() =>
      verifyCanvasNativeStageManifest([
        ...files,
        manifestEntry(
          "node_modules/@napi-rs/canvas-win32-arm64-msvc/icudtl.dat",
          "unexpected ARM64 ICU data",
        ),
      ], policy),
    ).toThrow(/unexpected native canvas package payload/i);
    expect(() =>
      verifyCanvasNativeStageManifest([
        ...files,
        manifestEntry(
          "node_modules/@napi-rs/canvas-win32-arm64-msvc/README.md",
          "unexpected README in the genuine ARM64 package inventory",
        ),
      ], policy),
    ).toThrow(/unexpected native canvas package payload/i);
    const arm64PackageJson =
      "node_modules/@napi-rs/canvas-win32-arm64-msvc/package.json";
    expect(() =>
      verifyCanvasNativeStageManifest(
        files.filter(file => file.path !== arm64PackageJson),
        policy,
      ),
    ).toThrow(/missing|required native canvas package file/i);
  });

  it("rejects a second nested canvas implementation and native package records", () => {
    const lock = clone(LOCK);
    lock.packages[
      "node_modules/pdfjs-dist/node_modules/@napi-rs/canvas"
    ] = {
      version: "0.1.100",
      integrity: "sha512-nested",
      resolved: "https://registry.npmjs.org/nested.tgz",
    };
    lock.packages[
      "node_modules/pdfjs-dist/node_modules/@napi-rs/canvas-win32-x64-msvc"
    ] = {
      version: "0.1.100",
      integrity: "sha512-nested-target",
      resolved: "https://registry.npmjs.org/nested-target.tgz",
      optional: true,
      os: ["win32"],
      cpu: ["x64"],
    };
    expect(() => verifyCanvasLockGraph(lock)).toThrow(
      /exactly one canvas implementation|nested canvas package/i,
    );

    const nativeOnly = clone(LOCK);
    nativeOnly.packages[
      "node_modules/pdfjs-dist/node_modules/@NAPI-RS/canvas-win32-x64-msvc"
    ] = {
      version: "0.1.99",
      integrity:
        LOCK.packages[
          "node_modules/@napi-rs/canvas-win32-x64-msvc"
        ].integrity,
      resolved:
        LOCK.packages[
          "node_modules/@napi-rs/canvas-win32-x64-msvc"
        ].resolved,
    };
    expect(() => verifyCanvasLockGraph(nativeOnly)).toThrow(
      /nested canvas package/i,
    );
  });

  it("rejects lock aliases, aliased identities, and case-folded package paths", () => {
    const aliasedIdentity = clone(LOCK);
    aliasedIdentity.packages["node_modules/canvas-alias"] = {
      name: "@napi-rs/canvas",
      version: "0.1.99",
      integrity:
        aliasedIdentity.packages["node_modules/@napi-rs/canvas"].integrity,
      resolved:
        aliasedIdentity.packages["node_modules/@napi-rs/canvas"].resolved,
    };
    expect(() => verifyCanvasLockGraph(aliasedIdentity)).toThrow(
      /aliased or noncanonical canvas package identity/i,
    );

    const dependencyAlias = clone(LOCK);
    dependencyAlias.packages[""].dependencies["canvas-alias"] =
      "npm:@napi-rs/canvas@0.1.99";
    expect(() => verifyCanvasLockGraph(dependencyAlias)).toThrow(
      /npm alias/i,
    );

    const caseFolded = clone(LOCK);
    caseFolded.packages["node_modules/@NAPI-RS/canvas"] =
      caseFolded.packages["node_modules/@napi-rs/canvas"];
    delete caseFolded.packages["node_modules/@napi-rs/canvas"];
    expect(() => verifyCanvasLockGraph(caseFolded)).toThrow(
      /noncanonical path|exactly one canvas implementation/i,
    );

    const caseFoldedNested = clone(LOCK);
    caseFoldedNested.packages[
      "node_modules/pdfjs-dist/node_modules/@NAPI-RS/canvas"
    ] = {
      version: "0.1.99",
      integrity:
        LOCK.packages["node_modules/@napi-rs/canvas"].integrity,
      resolved:
        LOCK.packages["node_modules/@napi-rs/canvas"].resolved,
    };
    caseFoldedNested.packages[
      "node_modules/pdfjs-dist/node_modules/@NAPI-RS/canvas-win32-x64-msvc"
    ] = {
      version: "0.1.99",
      integrity:
        LOCK.packages[
          "node_modules/@napi-rs/canvas-win32-x64-msvc"
        ].integrity,
      resolved:
        LOCK.packages[
          "node_modules/@napi-rs/canvas-win32-x64-msvc"
        ].resolved,
    };
    expect(() => verifyCanvasLockGraph(caseFoldedNested)).toThrow(
      /exactly one canvas implementation|nested canvas package/i,
    );
  });

  it("rejects lock target version, platform, and integrity mutants", () => {
    const targetPath =
      "node_modules/@napi-rs/canvas-win32-arm64-msvc";
    for (const mutate of [
      entry => {
        entry.version = "0.1.98";
      },
      entry => {
        entry.os = ["linux"];
      },
      entry => {
        entry.cpu = ["x64"];
      },
      entry => {
        entry.optional = false;
      },
      entry => {
        delete entry.integrity;
      },
      entry => {
        entry.integrity = "sha512-A";
      },
    ]) {
      const lock = clone(LOCK);
      mutate(lock.packages[targetPath]);
      expect(() => verifyCanvasLockGraph(lock)).toThrow(
        /lock metadata|complete metadata|mismatch|version|platform|optional|integrity|registry source/i,
      );
    }
  });

  it("rejects incomplete root metadata and an incompatible root declaration", () => {
    for (const mutate of [
      lock => {
        lock.packages["node_modules/@napi-rs/canvas"].integrity = "";
      },
      lock => {
        lock.packages["node_modules/@napi-rs/canvas"].integrity =
          "sha512-A";
      },
      lock => {
        lock.packages["node_modules/@napi-rs/canvas"].resolved = " ";
      },
      lock => {
        lock.packages[""].dependencies["@napi-rs/canvas"] = "^0.1.98";
      },
    ]) {
      const lock = clone(LOCK);
      mutate(lock);
      expect(() => verifyCanvasLockGraph(lock)).toThrow(
        /complete locked canvas metadata|root canvas declaration/i,
      );
    }
  });

  it("fails closed on an implementation version without a reviewed asset contract", () => {
    expect(() => verifyCanvasLockGraph(candidateLock("9.0.0"))).toThrow(
      /production native asset contract.*not reviewed/i,
    );
  });

  it("records 1.0.2 candidate registry assets without authorizing production use", () => {
    const inventory = canvasCandidateRegistryAssetInventory("1.0.2");
    expect(inventory).toMatchObject({
      compatibilityEvaluated: false,
      evidenceClassification:
        "PUBLIC_REGISTRY_ASSET_INVENTORY_ONLY_NOT_COMPATIBILITY_EVIDENCE",
      productionAuthorized: false,
    });
    expect(inventory.packages).toHaveLength(5);
    for (const target of inventory.packages) {
      expect(target.assets).toEqual(
        TARGETS[target.packageName].os === "win32"
          ? [TARGETS[target.packageName].binary, "icudtl.dat"]
          : [TARGETS[target.packageName].binary],
      );
    }
    expect(() => verifyCanvasLockGraph(candidateLock("1.0.2"))).toThrow(
      /production native asset contract.*not reviewed/i,
    );
  });

  it("rejects nested implementations and runtime assets in the staged archive", () => {
    const policy = verifyCanvasLockGraph(clone(LOCK));
    const files = stageManifest(policy);
    expect(() =>
      verifyCanvasNativeStageManifest([
        ...files,
        manifestEntry(
          "node_modules/pdfjs-dist/node_modules/@napi-rs/canvas/package.json",
          { name: "@napi-rs/canvas", version: "0.1.100" },
        ),
      ], policy),
    ).toThrow(
      /nested canvas package|exactly one canvas implementation|aliased or noncanonical canvas package identity/i,
    );

    const target = policy.packages[0];
    expect(() =>
      verifyCanvasNativeStageManifest([
        ...files,
        manifestEntry(
          `node_modules/${target.packageName}/unexpected.dat`,
          "unexpected native payload",
        ),
      ], policy),
    ).toThrow(/unexpected native canvas package payload/i);
  });

  it("rejects arbitrary target payloads and unknown root native packages", () => {
    const policy = verifyCanvasLockGraph(clone(LOCK));
    const files = stageManifest(policy);
    const target = policy.packages[0];
    for (const unexpected of ["evil.dll", "auxiliary.bin"]) {
      expect(() =>
        verifyCanvasNativeStageManifest([
          ...files,
          manifestEntry(
            `node_modules/${target.packageName}/${unexpected}`,
            "unexpected native package payload",
          ),
        ], policy),
      ).toThrow(/unexpected native canvas package payload/i);
    }
    expect(() =>
      verifyCanvasNativeStageManifest([
        ...files,
        manifestEntry(
          "node_modules/@napi-rs/canvas-evil/package.json",
          { name: "@napi-rs/canvas-evil", version: "0.1.99" },
        ),
        manifestEntry(
          "node_modules/@napi-rs/canvas-evil/evil.node",
          "unknown native package",
        ),
      ], policy),
    ).toThrow(/native canvas package inventory/i);
  });

  it("rejects staged aliases and case-folded package paths", () => {
    const policy = verifyCanvasLockGraph(clone(LOCK));
    const files = stageManifest(policy);
    expect(() =>
      verifyCanvasNativeStageManifest([
        ...files,
        manifestEntry(
          "node_modules/canvas-alias/package.json",
          { name: "@napi-rs/canvas", version: "0.1.99" },
        ),
      ], policy),
    ).toThrow(/aliased or noncanonical canvas package identity/i);

    expect(() =>
      verifyCanvasNativeStageManifest(
        files.map(file =>
          file.path === "node_modules/@napi-rs/canvas/package.json"
            ? { ...file, path: "node_modules/@NAPI-RS/canvas/package.json" }
            : file,
        ),
        policy,
      ),
    ).toThrow(/noncanonical canvas package path|implementation at the root/i);

    expect(() =>
      verifyCanvasNativeStageManifest([
        ...files,
        manifestEntry(
          "node_modules/pdfjs-dist/node_modules/@NAPI-RS/canvas/package.json",
          { version: "0.1.99" },
        ),
        manifestEntry(
          "node_modules/pdfjs-dist/node_modules/@NAPI-RS/canvas-win32-x64-msvc/package.json",
          { version: "0.1.99" },
        ),
      ], policy),
    ).toThrow(/exactly one canvas implementation|nested canvas package/i);

    expect(() =>
      verifyCanvasNativeStageManifest([
        ...files,
        manifestEntry(
          "node_modules/pdfjs-dist/node_modules/@NAPI-RS/canvas-win32-x64-msvc/package.json",
          { version: "0.1.99" },
        ),
      ], policy),
    ).toThrow(/nested canvas package/i);
  });

  it("rejects a caller-supplied policy that diverges from the reviewed contract", () => {
    const policy = verifyCanvasLockGraph(clone(LOCK));
    const files = stageManifest(policy);
    const mutants = [
      value => {
        value.packages[0].assets = [];
      },
      value => {
        value.packages[0].binary = "substitute.node";
      },
      value => {
        value.packages[0].integrity = "";
      },
      value => {
        value.packages[0].integrity = "sha512-A";
      },
      value => {
        value.packages.push(clone(value.packages[0]));
      },
    ];
    for (const mutate of mutants) {
      const mutant = clone(policy);
      mutate(mutant);
      expect(() =>
        verifyCanvasNativeStageManifest(files, mutant),
      ).toThrow(/native canvas policy/i);
    }
  });

  it("rejects missing and empty native binaries", () => {
    const policy = verifyCanvasLockGraph(clone(LOCK));
    const files = stageManifest(policy);
    const target = policy.packages[0];
    const binaryPath =
      `node_modules/${target.packageName}/${target.binary}`;
    expect(() =>
      verifyCanvasNativeStageManifest(
        files.filter(file => file.path !== binaryPath),
        policy,
      ),
    ).toThrow(/required native canvas (?:asset|package file)/i);
    expect(() =>
      verifyCanvasNativeStageManifest(
        files.map(file =>
          file.path === binaryPath
            ? manifestEntry(binaryPath, Buffer.alloc(0))
            : file,
        ),
        policy,
      ),
    ).toThrow(/empty native canvas asset/i);
  });

  it("rejects staged byte-count and digest metadata inconsistencies", () => {
    const policy = verifyCanvasLockGraph(clone(LOCK));
    const files = stageManifest(policy);
    const target = policy.packages[0];
    const binaryPath =
      `node_modules/${target.packageName}/${target.binary}`;
    expect(() =>
      verifyCanvasNativeStageManifest(
        files.map(file =>
          file.path === binaryPath ? { ...file, size: file.size + 1 } : file,
        ),
        policy,
      ),
    ).toThrow(/invalid bytes, metadata/i);
    expect(() =>
      verifyCanvasNativeStageManifest(
        files.map(file =>
          file.path === binaryPath
            ? { ...file, sha256: "0".repeat(64) }
            : file,
        ),
        policy,
      ),
    ).toThrow(/invalid bytes, metadata/i);
  });

  it("rejects staged package identity, version, and platform mutants", () => {
    const policy = verifyCanvasLockGraph(clone(LOCK));
    const target = policy.packages[0];
    const packagePath =
      `node_modules/${target.packageName}/package.json`;
    const files = stageManifest(policy);
    for (const mutate of [
      value => {
        value.name = "@napi-rs/canvas-unexpected";
      },
      value => {
        value.version = "0.1.98";
      },
      value => {
        value.os = ["win32"];
      },
      value => {
        value.cpu = ["unexpected"];
      },
    ]) {
      expect(() =>
        verifyCanvasNativeStageManifest(
          replaceJson(files, packagePath, mutate),
          policy,
        ),
      ).toThrow(/package identity or platform metadata/i);
    }
  });

  it("classifies packaged paths as static conformance rather than execution evidence", async () => {
    const paths = ["node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node"];
    expect(staticArchiveConformanceEvidence(paths)).toEqual({
      evidenceClassification:
        "STATIC_ARCHIVE_CONFORMANCE_NOT_NATIVE_EXECUTION_OR_HOST_EVIDENCE",
      packagedNativeAssetPaths: paths,
      nativeExecutionPerformed: false,
      crossArchitectureExecutionPerformed: false,
      claudeDesktopTested: false,
    });
    const source = await fs.readFile(
      new URL("../scripts/build-mcpb.mjs", import.meta.url),
      "utf8",
    );
    expect(source).toContain(
      "Verified packaged native asset paths (static; not executed):",
    );
    expect(source).not.toContain("Verified native bindings:");
  });
});
