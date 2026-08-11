/**
 * The bill has to describe the native code, not just the npm graph.
 *
 * `SBOM.cdx.json` is generated from `package-lock.json`, so for as long as the
 * QPDF WebAssembly runtime shipped without components it was an accurate
 * inventory of the wrong thing: complete about npm, silent about the only
 * compiled-from-source code in either artifact. The notices shipped and
 * `SHARE-PROVENANCE.json` hashed every file, so nothing was unlicensed — but a
 * consumer reading the SBOM would have concluded there was no native code.
 *
 * Everything asserted here is re-derived from `sources.lock.json` and the
 * shipped notice manifest, deliberately NOT from
 * `runtime.provenance.json`, which is what the generator reads. Deriving both
 * sides from the same record would only prove the generator agrees with
 * itself; deriving them from two records that a build must keep in step means
 * a source added to the lock without a component fails here.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  generateCycloneDxSbom,
  validateCycloneDxSbom,
} from "../package-for-friend.js";
import {
  deriveQpdfWasmSbomComponents,
  deriveQpdfWasmSbomDependencies,
  QPDF_WASM_BUILD_TOOL_COMPONENT,
  QPDF_WASM_BUILD_TOOLCHAIN_BOM_REF,
  QPDF_WASM_RUNTIME_COMPONENT_BOM_REF,
  QPDF_WASM_SBOM_COMPONENTS,
} from "../scripts/qpdf-wasm-sbom.mjs";
import { QPDF_WASM_RUNTIME_PROVENANCE } from "../scripts/qpdf-wasm-runtime.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECIPE_DIR = path.join(REPO_ROOT, "vendor", "qpdf-wasm");
const RUNTIME_DIR = path.join(RECIPE_DIR, "runtime");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const sourcesLock = JSON.parse(await fs.readFile(path.join(RECIPE_DIR, "sources.lock.json"), "utf8"));
const noticeManifest = JSON.parse(
  await fs.readFile(path.join(RUNTIME_DIR, "licenses", "manifest.json"), "utf8"),
);
const shareLock = JSON.parse(
  await fs.readFile(path.join(REPO_ROOT, "pdf-toolkit-mcp-share", "package-lock.json"), "utf8"),
);
const sharePackage = JSON.parse(
  await fs.readFile(path.join(REPO_ROOT, "pdf-toolkit-mcp-share", "package.json"), "utf8"),
);
const sbom = generateCycloneDxSbom(shareLock, sharePackage);
const componentsByRef = new Map(sbom.components.map(component => [component["bom-ref"], component]));
const componentsByName = new Map(
  sbom.components.map(component => [`${component.name}@${component.version}`, component]),
);

/** The notice entries that are not a pinned source's own or supplementary notice. */
const sourceKeys = new Set(sourcesLock.sources.map(source => `${source.name} ${source.version}`));
const toolchainNotices = noticeManifest.files.filter(notice => {
  if (/^(.+?) (\d\S*) bundled-code notices$/.test(notice.component)) return false;
  const primary = /^(.+?) (\d\S*)$/.exec(notice.component);
  return !(primary && sourceKeys.has(`${primary[1]} ${primary[2]}`));
});

describe("every pinned native source reaches the bill of materials", () => {
  it("has a component for each source in sources.lock.json", () => {
    expect(sourcesLock.sources.length).toBeGreaterThan(0);
    for (const source of sourcesLock.sources) {
      const component = componentsByName.get(`${source.name}@${source.version}`);
      expect(component, `${source.name} ${source.version} has no SBOM component`).toBeTruthy();
      expect(component.type).toBe("library");
      expect(component.scope).toBe("required");
    }
  });

  it("hashes each source component against the pinned source archive, not an invented digest", () => {
    for (const source of sourcesLock.sources) {
      const component = componentsByName.get(`${source.name}@${source.version}`);
      expect(component.hashes).toEqual([{ alg: "SHA-256", content: source.sha256 }]);
      expect(component.purl).toContain(`sha256%3A${source.sha256}`);
      expect(component.externalReferences).toContainEqual({
        type: "source-distribution",
        url: source.url,
        comment: "Pinned upstream source archive this component was built from",
        hashes: [{ alg: "SHA-256", content: source.sha256 }],
      });
    }
  });

  it("gives each source component the licence its own shipped notice claims", () => {
    for (const source of sourcesLock.sources) {
      const notice = noticeManifest.files.find(
        entry => entry.component === `${source.name} ${source.version}`,
      );
      expect(notice, `${source.name} ships no primary notice`).toBeTruthy();
      const component = componentsByName.get(`${source.name}@${source.version}`);
      expect(component.licenses).toEqual([{ expression: notice.spdx }]);
    }
  });

  it("points every source component at the notice bytes that actually ship", async () => {
    for (const source of sourcesLock.sources) {
      const component = componentsByName.get(`${source.name}@${source.version}`);
      const noticeReferences = component.externalReferences.filter(reference => reference.type === "license");
      expect(noticeReferences.length).toBeGreaterThan(0);
      for (const reference of noticeReferences) {
        const bytes = await fs.readFile(path.join(REPO_ROOT, ...reference.url.split("/")));
        expect(sha256(bytes), `${reference.url} digest`).toBe(reference.hashes[0].content);
      }
    }
  });

  /*
   * The regression this file exists for. A future source added to
   * `sources.lock.json` must not be able to reach a shipped artifact without
   * reaching the bill: the derivation is exercised against a lock that has one
   * more source than the real one, and the component set has to grow with it.
   */
  it("cannot silently skip a newly pinned source", () => {
    const provenance = structuredClone(QPDF_WASM_RUNTIME_PROVENANCE);
    provenance.build.sources.push({
      name: "openjpeg",
      version: "2.5.4",
      filename: "openjpeg-2.5.4.tar.gz",
      url: "https://example.invalid/openjpeg-2.5.4.tar.gz",
      sha256: "f".repeat(64),
    });
    // A source with no notice is a licence gap, and the derivation says so
    // rather than quietly dropping the component.
    expect(() => deriveQpdfWasmSbomComponents(provenance))
      .toThrow(/ships no licence notice: openjpeg 2\.5\.4/);

    provenance.notices.components.push({
      component: "openjpeg 2.5.4",
      spdx: "BSD-2-Clause",
      file: "licenses/OPENJPEG-LICENSE.txt",
      sha256: "e".repeat(64),
    });
    // A notice that does not ship is also a gap, for the same reason.
    expect(() => deriveQpdfWasmSbomComponents(provenance))
      .toThrow(/is not a shipped runtime asset/);

    provenance.runtime_assets.files.push({
      path: "vendor/qpdf-wasm/runtime/licenses/OPENJPEG-LICENSE.txt",
      sha256: "e".repeat(64),
      size_bytes: 1,
    });
    const grown = deriveQpdfWasmSbomComponents(provenance);
    expect(grown.length).toBe(QPDF_WASM_SBOM_COMPONENTS.length + 1);
    const added = grown.find(component => component.name === "openjpeg");
    expect(added.version).toBe("2.5.4");
    expect(added.hashes).toEqual([{ alg: "SHA-256", content: "f".repeat(64) }]);
    expect(added.licenses).toEqual([{ expression: "BSD-2-Clause" }]);
    // And it hangs off the runtime rather than floating free.
    const [runtimeEdge] = deriveQpdfWasmSbomDependencies(grown);
    expect(runtimeEdge.ref).toBe(QPDF_WASM_RUNTIME_COMPONENT_BOM_REF);
    expect(runtimeEdge.dependsOn).toContain(added["bom-ref"]);
  });

  it("refuses a notice it cannot classify instead of ignoring it", () => {
    const provenance = structuredClone(QPDF_WASM_RUNTIME_PROVENANCE);
    provenance.notices.components.push({
      component: "something nobody described",
      spdx: "MIT",
      file: "licenses/MYSTERY.txt",
      sha256: "d".repeat(64),
    });
    expect(() => deriveQpdfWasmSbomComponents(provenance)).toThrow(/not classifiable/);
  });

  it("refuses a notice whose digest disagrees with the file that ships", () => {
    const provenance = structuredClone(QPDF_WASM_RUNTIME_PROVENANCE);
    provenance.notices.components[0].sha256 = "c".repeat(64);
    expect(() => deriveQpdfWasmSbomComponents(provenance)).toThrow(/digest disagrees with the shipped asset/);
  });
});

describe("toolchain code that ships is a component; the compiler is not", () => {
  it("lists every Emscripten-linked library the runtime redistributes", () => {
    expect(toolchainNotices.length).toBeGreaterThan(0);
    const expressions = new Set(QPDF_WASM_SBOM_COMPONENTS.map(component => component.licenses[0].expression));
    for (const notice of toolchainNotices) {
      expect(expressions.has(notice.spdx), `no component carries ${notice.component}`).toBe(true);
    }
    // musl, compiler-rt, libc++, libc++abi, libunwind and the generated
    // runtime are linked into `qpdf.wasm`, so each owes a component.
    const toolchainComponents = QPDF_WASM_SBOM_COMPONENTS
      .filter(component => component.group === "emscripten");
    expect(toolchainComponents.length).toBe(toolchainNotices.length);
    for (const component of toolchainComponents) {
      expect(component.type).toBe("library");
      expect(component.scope).toBe("required");
      expect(component.purl).toMatch(/^pkg:generic\/emscripten\//);
      const linkage = component.properties.find(p => p.name === "pdf-tools:qpdf-wasm-linkage")?.value;
      expect(linkage).toMatch(/qpdf\.(wasm|mjs)/);
    }
  });

  it("hashes toolchain libraries against the pinned build image rather than inventing a digest", () => {
    const digest = QPDF_WASM_RUNTIME_PROVENANCE.build.toolchain.digest.replace(/^sha256:/, "");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    for (const component of QPDF_WASM_SBOM_COMPONENTS.filter(entry => entry.group === "emscripten")) {
      expect(component.hashes).toEqual([{ alg: "SHA-256", content: digest }]);
      const subject = component.properties.find(p => p.name === "pdf-tools:qpdf-wasm-hash-subject")?.value;
      expect(subject).toMatch(/image digest/);
      expect(subject).toMatch(/no separately isolable source archive/);
    }
  });

  it("records the build image as tooling and keeps it out of the shipped inventory", () => {
    expect(QPDF_WASM_BUILD_TOOL_COMPONENT.type).toBe("container");
    expect(QPDF_WASM_BUILD_TOOL_COMPONENT["bom-ref"]).toBe(QPDF_WASM_BUILD_TOOLCHAIN_BOM_REF);
    expect(QPDF_WASM_BUILD_TOOL_COMPONENT.purl)
      .toContain(QPDF_WASM_RUNTIME_PROVENANCE.build.toolchain.digest);
    expect(sbom.metadata.tools.components).toEqual([QPDF_WASM_BUILD_TOOL_COMPONENT]);
    expect(componentsByRef.has(QPDF_WASM_BUILD_TOOLCHAIN_BOM_REF)).toBe(false);
    expect(sbom.dependencies.some(entry => entry.ref === QPDF_WASM_BUILD_TOOLCHAIN_BOM_REF)).toBe(false);
  });
});

describe("the native half of the bill hangs off the runtime that ships it", () => {
  it("covers every shipped runtime file with a hashed reference", () => {
    const referenced = new Map();
    for (const component of [...sbom.components, ...sbom.metadata.tools.components]) {
      for (const reference of component.externalReferences || []) {
        if (!reference.url.startsWith("vendor/qpdf-wasm/runtime/")) continue;
        referenced.set(reference.url, reference.hashes?.[0]?.content);
      }
    }
    for (const asset of QPDF_WASM_RUNTIME_PROVENANCE.runtime_assets.files) {
      expect(referenced.has(asset.path), `${asset.path} is shipped but unreferenced`).toBe(true);
      expect(referenced.get(asset.path), `${asset.path} digest`).toBe(asset.sha256);
    }
  });

  it("attaches every native component to the runtime, and the runtime to the application", () => {
    const runtime = componentsByRef.get(QPDF_WASM_RUNTIME_COMPONENT_BOM_REF);
    expect(runtime).toBeTruthy();
    const edges = new Map(sbom.dependencies.map(entry => [entry.ref, entry.dependsOn]));
    const runtimeChildren = edges.get(QPDF_WASM_RUNTIME_COMPONENT_BOM_REF);
    const nativeRefs = QPDF_WASM_SBOM_COMPONENTS
      .map(component => component["bom-ref"])
      .filter(ref => ref !== QPDF_WASM_RUNTIME_COMPONENT_BOM_REF);
    expect([...runtimeChildren].sort()).toEqual([...nativeRefs].sort());
    for (const ref of nativeRefs) {
      expect(edges.has(ref), `${ref} has no dependency entry`).toBe(true);
      expect(edges.get(ref)).toEqual([]);
    }
    expect(edges.get(sbom.metadata.component["bom-ref"]))
      .toContain(QPDF_WASM_RUNTIME_COMPONENT_BOM_REF);
  });

  it("counts the npm graph and the native graph, each from its own record", () => {
    const npmComponents = Object.keys(shareLock.packages).length - 1;
    const nativeComponents = sourcesLock.sources.length + toolchainNotices.length + 1;
    expect(sbom.components.length).toBe(npmComponents + nativeComponents);
    expect(sbom.dependencies.length).toBe(npmComponents + nativeComponents + 1);
  });
});

describe("the generated bill is validated, not trusted", () => {
  it("rejects a native component that was edited after generation", () => {
    const tampered = structuredClone(sbom);
    const target = tampered.components.find(
      component => component["bom-ref"] === QPDF_WASM_RUNTIME_COMPONENT_BOM_REF,
    );
    target.hashes[0].content = "0".repeat(64);
    expect(() => validateCycloneDxSbom(tampered, shareLock, sharePackage))
      .toThrow(/native component does not exactly cover/);
  });

  it("rejects a bill that drops a native component", () => {
    const tampered = structuredClone(sbom);
    tampered.components = tampered.components.filter(
      component => component["bom-ref"] !== "urn:pdf-tools:qpdf-wasm-source:zlib@1.3.2",
    );
    expect(() => validateCycloneDxSbom(tampered, shareLock, sharePackage))
      .toThrow(/component coverage mismatch/);
  });

  it("rejects a bill that detaches the runtime from the application", () => {
    const tampered = structuredClone(sbom);
    const rootRef = tampered.metadata.component["bom-ref"];
    const rootEntry = tampered.dependencies.find(entry => entry.ref === rootRef);
    rootEntry.dependsOn = rootEntry.dependsOn.filter(
      ref => ref !== QPDF_WASM_RUNTIME_COMPONENT_BOM_REF,
    );
    expect(() => validateCycloneDxSbom(tampered, shareLock, sharePackage))
      .toThrow(/dependency edges do not exactly cover root/);
  });

  it("rejects a bill that forgets the build toolchain", () => {
    const tampered = structuredClone(sbom);
    delete tampered.metadata.tools;
    expect(() => validateCycloneDxSbom(tampered, shareLock, sharePackage))
      .toThrow(/build toolchain as build tooling/);
  });
});
