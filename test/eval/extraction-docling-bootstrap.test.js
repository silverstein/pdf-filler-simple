import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, afterEach, expect, it } from "vitest";
import {
  prepareDoclingMacHandoff,
  prepareDoclingMacHandoffForTest,
  doclingCalibrationStatus,
} from "./extraction-docling-handoff.js";
import { validateReceipt } from "../../scripts/eval-capture-docling-bakeoff.mjs";

// Regression coverage for the calibration-bootstrap bypass. Deliberately NOT
// gated on calibration currency: this suite tests the staleness machinery
// itself. The two pipeline tests need the attestation to actually be stale,
// which is the repository's current state; if a future re-approval makes the
// calibration current, they skip by construction because the stale branch no
// longer exists to exercise.

const SCHEMA_PATH = path.resolve(
  "test/fixtures/eval/extraction/phase1/docling-handoff.schema.json",
);

const DARWIN_ARM64 = {
  platform: "darwin",
  architecture: "arm64",
  os_build: "25G5065a",
  kernel_release: "25.6.0",
  node_version: process.version,
};

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(
    root => fs.rm(root, { recursive: true, force: true }),
  ));
});

async function temporaryRoot(prefix) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  await fs.chmod(root, 0o700);
  return root;
}

async function fixture(root) {
  const filename = path.join(root, "fixture.pdf");
  await fs.writeFile(filename, "%PDF-1.7\ntruth-free bootstrap fixture\n%%EOF\n", { mode: 0o600 });
  return filename;
}

async function options(root, calibrationBootstrap) {
  const uvPath = path.join(root, "uv-test-binary");
  const uvVersion = "uv 0.11.29 (901092ee1 2026-07-15 aarch64-apple-darwin)";
  await fs.writeFile(uvPath, `#!/bin/sh\nprintf '%s\\n' '${uvVersion}'\n`, { mode: 0o700, flag: "wx" });
  return {
    cacheRoot: path.join(root, "Library/Caches/oda-pdf-tools-extraction"),
    sidecarRoot: path.join(root, "Sites/pdf-tools-extraction-sidecars"),
    protectedRoots: [path.join(root, "Documents"), path.join(root, "Dropbox")],
    fixturePaths: [await fixture(root)],
    calibrationBootstrap,
    testOnlyHost: DARWIN_ARM64,
    testOnlyUv: { path: uvPath, version: uvVersion },
    testOnlySupervisorBuild: {
      binaryBytes: Buffer.from("pdf-tools-test-only-supervisor-binary\n"),
    },
  };
}

const calibrationIsStale = !doclingCalibrationStatus().current;

describe("Docling calibration-bootstrap bypass", () => {
  it("keeps the production entry point closed to injected facts even with the bootstrap flag", async () => {
    await expect(prepareDoclingMacHandoff({
      calibrationBootstrap: true,
      testOnlyHost: DARWIN_ARM64,
    })).rejects.toThrow(/does not accept injected/);
  });

  it.skipIf(!calibrationIsStale)("still raises the typed stale error when the flag is off", async () => {
    const root = await temporaryRoot("pdf-tools-bootstrap-off-");
    const error = await prepareDoclingMacHandoffForTest(await options(root, false))
      .then(() => null, raised => raised);
    expect(error).not.toBeNull();
    expect(error.code).toBe("EVAL_ATTESTATION_STALE");
    expect(error.message).toMatch(/re-approval requirement, not a product defect/);
  });

  it.skipIf(!calibrationIsStale)("stamps the bootstrap marker into the durable receipt bytes and the capture path refuses it", async () => {
    const root = await temporaryRoot("pdf-tools-bootstrap-on-");
    const handoff = await prepareDoclingMacHandoffForTest(await options(root, true));

    // In-memory result and durable receipt object both carry the marker.
    expect(handoff.calibration_bootstrap).toBe(true);
    expect(handoff.receipt.calibration_bootstrap).toBe(true);

    // The marker survives in the exact bytes on disk, so a cross-process
    // consumer reading the receipt by path can see it.
    const persisted = JSON.parse(await fs.readFile(handoff.receiptPath, "utf8"));
    expect(persisted.calibration_bootstrap).toBe(true);

    // The qualifying capture path refuses the receipt outright.
    const schema = JSON.parse(await fs.readFile(SCHEMA_PATH, "utf8"));
    expect(() => validateReceipt(persisted, schema))
      .toThrow(/calibration-bootstrap handoff and cannot produce qualifying or scored evidence/);
  });

  it("refuses a bootstrap-marked receipt before shape validation", () => {
    expect(() => validateReceipt({ calibration_bootstrap: true }, { type: "object" }))
      .toThrow(/cannot produce qualifying or scored evidence/);
  });
});
