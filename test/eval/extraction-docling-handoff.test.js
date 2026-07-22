import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertSchema } from "./extraction-phase1-protocol.js";
import {
  prepareDoclingMacHandoff,
} from "./extraction-docling-handoff.js";
import { verifyDoclingHandoff } from "./extraction-docling-handoff-verifier.js";

const roots = [];
const DARWIN_ARM64 = {
  platform: "darwin", architecture: "arm64", os_build: "25G88", kernel_release: "25.6.0", node_version: process.version,
};

async function temporaryRoot(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  await fs.chmod(root, 0o700);
  return root;
}

async function fixture(root, name = "fixture.pdf") {
  const filename = path.join(root, name);
  await fs.writeFile(filename, "%PDF-1.7\ntruth-free handoff fixture\n%%EOF\n", { mode: 0o600 });
  return filename;
}

async function options(root, fixturePaths) {
  const uvPath = path.join(root, "uv-test-binary");
  try {
    await fs.writeFile(uvPath, "#!/bin/sh\nprintf 'uv 0.8.15\\n'\n", { mode: 0o700, flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  return {
    cacheRoot: path.join(root, "Library/Caches/oda-pdf-tools-extraction"),
    sidecarRoot: path.join(root, "Sites/pdf-tools-extraction-sidecars"),
    protectedRoots: [path.join(root, "Documents"), path.join(root, "Dropbox"), path.join(root, "Library/Mobile Documents")],
    fixturePaths,
    testOnlyHost: DARWIN_ARM64,
    testOnlyUv: { path: uvPath, version: "uv 0.8.15" },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("Docling macOS handoff", () => {
  it("creates a truth-free, content-addressed, mode-0700/0600 handoff outside protected roots", async () => {
    const root = await temporaryRoot("pdf-tools-docling-handoff-");
    const source = await fixture(root);
    const result = await prepareDoclingMacHandoff(await options(root, [source]));
    const schema = JSON.parse(await fs.readFile(path.resolve("test/fixtures/eval/extraction/phase1/docling-handoff.schema.json"), "utf8"));
    expect(() => assertSchema(result.receipt, schema, "Docling handoff receipt")).not.toThrow();
    expect(result.receipt).toMatchObject({
      protocol: "pdf-tools.docling-macos-handoff.v1",
      execution_state: "not_run",
      setup: { network_required: true },
      execution: { offline_intent: true, network_isolation_enforced: false },
    });
    expect(result.receipt.handoff_id).toMatch(/^[a-f0-9]{64}$/);
    expect(result.receipt_sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(verifyDoclingHandoff({
      receiptPath: result.receiptPath,
      expectedReceiptSha256: result.receipt_sha256,
      trustedSchemaPath: path.resolve("test/fixtures/eval/extraction/phase1/docling-handoff.schema.json"),
    })).resolves.toMatchObject({ receipt_sha256: result.receipt_sha256 });
    const serialized = JSON.stringify({ inputs: result.receipt.inputs, fixtures: result.receipt.fixtures });
    for (const forbidden of ["ground_truth", "expected", "partition", "category", "fact_ids", "truth_boxes", "answer_state"]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(result.receipt.fixtures).toEqual([
      expect.objectContaining({ ordinal: 1, filename: expect.stringMatching(/^source-001-[a-f0-9]{12}\.pdf$/), bytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    ]);
    expect(result.receipt.fixtures[0]).not.toHaveProperty("source_path");
    for (const directory of Object.values(result.receipt.roots).filter(value => typeof value === "string" && value.startsWith(root))) {
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    }
    expect((await fs.stat(result.receiptPath)).mode & 0o777).toBe(0o600);
    for (const retained of result.receipt.inputs) {
      const bytes = await fs.readFile(path.join(result.receipt.roots.sidecar_snapshot, retained.filename));
      expect(bytes.length).toBe(retained.bytes);
    }
  });

  it("is content deterministic across distinct secure destinations", async () => {
    const firstRoot = await temporaryRoot("pdf-tools-docling-handoff-a-");
    const secondRoot = await temporaryRoot("pdf-tools-docling-handoff-b-");
    const firstFixture = await fixture(firstRoot);
    const secondFixture = await fixture(secondRoot);
    const [first, second] = await Promise.all([
      prepareDoclingMacHandoff(await options(firstRoot, [firstFixture])),
      prepareDoclingMacHandoff(await options(secondRoot, [secondFixture])),
    ]);
    expect(first.receipt.handoff_id).toBe(second.receipt.handoff_id);
    expect(first.receipt.fixtures).toEqual(second.receipt.fixtures);
    expect(first.receipt.inputs).toEqual(second.receipt.inputs);
  });

  it("rejects cache or sidecar destinations under protected sync roots", async () => {
    const root = await temporaryRoot("pdf-tools-docling-protected-");
    const source = await fixture(root);
    const unsafe = await options(root, [source]);
    unsafe.cacheRoot = path.join(root, "Documents/oda-pdf-tools-extraction");
    await expect(prepareDoclingMacHandoff(unsafe)).rejects.toThrow(/outside Documents/);
  });

  it("rejects symbolic-link fixtures and weak existing destination modes", async () => {
    const root = await temporaryRoot("pdf-tools-docling-hostile-");
    const source = await fixture(root, "source.pdf");
    const linked = path.join(root, "linked.pdf");
    await fs.symlink(source, linked);
    await expect(prepareDoclingMacHandoff(await options(root, [linked]))).rejects.toThrow(/symbolic link|ELOOP/);

    const weak = await options(root, [source]);
    await fs.mkdir(weak.cacheRoot, { recursive: true, mode: 0o755 });
    await fs.chmod(weak.cacheRoot, 0o755);
    await expect(prepareDoclingMacHandoff(weak)).rejects.toThrow(/mode-0700/);
  });

  it("rejects wrong hosts, non-PDF inputs, hard links, and aggregate fixture overages", async () => {
    const root = await temporaryRoot("pdf-tools-docling-inputs-");
    const source = await fixture(root);
    await expect(prepareDoclingMacHandoff({ ...(await options(root, [source])), testOnlyHost: { ...DARWIN_ARM64, platform: "linux", architecture: "x64" } })).rejects.toThrow(/darwin\/arm64/);

    const text = path.join(root, "fixture.txt");
    await fs.writeFile(text, "not a pdf", { mode: 0o600 });
    await expect(prepareDoclingMacHandoff(await options(root, [text]))).rejects.toThrow(/only PDF/);

    const hard = path.join(root, "hard.pdf");
    await fs.link(source, hard);
    await expect(prepareDoclingMacHandoff(await options(root, [hard]))).rejects.toThrow(/single-link/);

    const large = path.join(root, "large.pdf");
    await fs.writeFile(large, Buffer.alloc((8 * 1024 * 1024) + 1, 0x20), { mode: 0o600 });
    await expect(prepareDoclingMacHandoff(await options(root, [large]))).rejects.toThrow(/bounded|8 MiB/);
  });

  it("rejects receipt, retained-input, fixture, and uv mutations against the out-of-band receipt digest", async () => {
    const create = async suffix => {
      const root = await temporaryRoot(`pdf-tools-docling-mutation-${suffix}-`);
      const result = await prepareDoclingMacHandoff(await options(root, [await fixture(root)]));
      return { root, result };
    };
    const trustedSchemaPath = path.resolve("test/fixtures/eval/extraction/phase1/docling-handoff.schema.json");

    const receiptCase = await create("receipt");
    await fs.appendFile(receiptCase.result.receiptPath, " ");
    await expect(verifyDoclingHandoff({ receiptPath: receiptCase.result.receiptPath, expectedReceiptSha256: receiptCase.result.receipt_sha256, trustedSchemaPath })).rejects.toThrow(/out-of-band/);

    const inputCase = await create("input");
    const config = inputCase.result.receipt.inputs.find(item => item.role === "candidate_config");
    await fs.appendFile(path.join(inputCase.result.receipt.roots.sidecar_snapshot, config.filename), " ");
    await expect(verifyDoclingHandoff({ receiptPath: inputCase.result.receiptPath, expectedReceiptSha256: inputCase.result.receipt_sha256, trustedSchemaPath })).rejects.toThrow(/input mismatch/);

    const fixtureCase = await create("fixture");
    const retainedFixture = fixtureCase.result.receipt.fixtures[0];
    await fs.appendFile(path.join(path.dirname(fixtureCase.result.receiptPath), "fixtures", retainedFixture.filename), " ");
    await expect(verifyDoclingHandoff({ receiptPath: fixtureCase.result.receiptPath, expectedReceiptSha256: fixtureCase.result.receipt_sha256, trustedSchemaPath })).rejects.toThrow(/fixture mismatch/);

    const uvCase = await create("uv");
    await fs.appendFile(uvCase.result.receipt.toolchain.uv.path, "mutated");
    await expect(verifyDoclingHandoff({ receiptPath: uvCase.result.receiptPath, expectedReceiptSha256: uvCase.result.receipt_sha256, trustedSchemaPath })).rejects.toThrow(/uv binary/);
  });
});
