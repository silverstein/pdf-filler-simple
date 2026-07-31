import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { prepareDoclingMacHandoffForTest,
  doclingCalibrationStatus,
} from "./extraction-docling-handoff.js";
import {
  canonicalJson,
  validateCandidateResponse,
  validateFinalization,
  validateReceipt,
} from "../../scripts/eval-capture-docling-bakeoff.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const PERMISSIVE_OBJECT_SCHEMA = {
  type: "object",
  additionalProperties: true,
};
const execFileAsync = promisify(execFile);

function receiptFixture() {
  const inputs = [{ role: "input", sha256: "a".repeat(64) }];
  const fixtures = [{ ordinal: 1, sha256: "b".repeat(64) }];
  const identity = {
    protocol: "pdf-tools.docling-macos-handoff.v1",
    inputs: structuredClone(inputs),
    fixtures: structuredClone(fixtures),
  };
  return {
    identity,
    inputs,
    fixtures,
    handoff_id: sha256(Buffer.from(
      `pdf-tools.docling-macos-handoff.v1\0${canonicalJson(identity)}`,
    )),
  };
}

// Sealed Docling calibration evidence goes stale whenever the supervisor
// source moves. That is a re-approval requirement, so these suites report a
// named skip rather than red tests that would hide a real defect.
const doclingEvidence = doclingCalibrationStatus();

describe.skipIf(!doclingEvidence.current)("Docling bakeoff evidence validators", () => {
  it("uses a fresh exact working directory for every scored repetition", async () => {
    const source = await fs.readFile(
      path.resolve("scripts/eval-capture-docling-bakeoff.mjs"),
      "utf8",
    );
    expect(source).toContain("freshAttemptDirectory");
    expect(source).toContain("removeExactAttemptDirectory");
    expect(source).toContain("Scored attempt retained unexpected writable state");
    expect(source).toContain("cwd: attemptDir");
    expect(source).not.toContain("cwd: stagedDir");
  });

  it("requires the handoff identity to bind both retained inventories", () => {
    const receipt = receiptFixture();
    expect(validateReceipt(receipt, PERMISSIVE_OBJECT_SCHEMA)).toBe(receipt);

    const split = structuredClone(receipt);
    split.identity.fixtures[0].sha256 = "c".repeat(64);
    split.handoff_id = sha256(Buffer.from(
      `pdf-tools.docling-macos-handoff.v1\0${canonicalJson(split.identity)}`,
    ));
    expect(() => validateReceipt(split, PERMISSIVE_OBJECT_SCHEMA)).toThrow(/inventories are invalid/);
  });

  it("requires the finalization digest and receipt binding", () => {
    const receipt = receiptFixture();
    const receiptSha256 = "d".repeat(64);
    const core = {
      protocol: "pdf-tools.docling-finalization.v1",
      handoff_id: receipt.handoff_id,
      receipt_sha256: receiptSha256,
      execution_state: "setup_complete_not_executed",
    };
    const finalization = {
      ...core,
      finalization_id: sha256(Buffer.from(
        `pdf-tools.docling-finalization.v1\0${canonicalJson(core)}`,
      )),
    };
    expect(validateFinalization(
      finalization,
      PERMISSIVE_OBJECT_SCHEMA,
      receipt,
      receiptSha256,
    )).toBe(finalization);

    const drifted = { ...finalization, receipt_sha256: "e".repeat(64) };
    expect(() => validateFinalization(
      drifted,
      PERMISSIVE_OBJECT_SCHEMA,
      receipt,
      receiptSha256,
    )).toThrow(/identity is invalid/);
  });

  it("requires every candidate response to match its request", () => {
    const request = { protocol: "pdf-tools.extraction-candidate.v1", request_id: "f".repeat(64) };
    const response = { protocol: request.protocol, request_id: request.request_id };
    expect(validateCandidateResponse(response, request, PERMISSIVE_OBJECT_SCHEMA)).toBe(response);
    expect(() => validateCandidateResponse(
      { ...response, request_id: "0".repeat(64) },
      request,
      PERMISSIVE_OBJECT_SCHEMA,
    )).toThrow(/not bound/);
  });

  it("uses the receipt-bound launcher to execute a private sealed authority", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-docling-bakeoff-authority-")),
    );
    try {
      const fixturePath = path.join(root, "fixture.pdf");
      const uvPath = path.join(root, "uv-test-binary");
      const uvVersion = "uv 0.11.29 (901092ee1 2026-07-15 aarch64-apple-darwin)";
      await Promise.all([
        fs.writeFile(fixturePath, "%PDF-1.7\nsealed authority fixture\n%%EOF\n", { mode: 0o600 }),
        fs.writeFile(uvPath, `#!/bin/sh\nprintf '%s\\n' '${uvVersion}'\n`, { mode: 0o700 }),
      ]);
      const handoff = await prepareDoclingMacHandoffForTest({
        cacheRoot: path.join(root, "Library/Caches/oda-pdf-tools-extraction"),
        sidecarRoot: path.join(root, "Sites/pdf-tools-extraction-sidecars"),
        protectedRoots: [path.join(root, "Documents"), path.join(root, "Dropbox")],
        fixturePaths: [fixturePath],
        testOnlyHost: {
          platform: "darwin",
          architecture: "arm64",
          os_build: "25G5065a",
          kernel_release: "25.6.0",
          node_version: process.version,
        },
        testOnlySupervisorBuild: {
          binaryBytes: Buffer.from("pdf-tools-test-only-supervisor-binary\n"),
        },
        testOnlyUv: { path: uvPath, version: uvVersion },
      });
      const launcherPath = path.join(root, "verify-retained-authority.mjs");
      const moduleUrl = pathToFileURL(path.resolve("scripts/eval-capture-docling-bakeoff.mjs")).href;
      await fs.writeFile(launcherPath, `import fs from "node:fs/promises";
import { createRetainedAuthorityVerifier } from ${JSON.stringify(moduleUrl)};
const receipt = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
const verifier = await createRetainedAuthorityVerifier({
  receipt,
  receiptPath: process.argv[2],
  receiptSha256: process.argv[3],
  protectedRootsJson: process.argv[4],
});
const evidence = await verifier.verify();
process.stdout.write(JSON.stringify(evidence) + "\\n");
`, { mode: 0o600 });
      const cleanEnvironment = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith("NODE_")),
      );
      const result = await execFileAsync(process.execPath, [
        launcherPath,
        handoff.receiptPath,
        handoff.receipt_sha256,
        handoff.protected_roots_json,
      ], { env: cleanEnvironment, maxBuffer: 1024 * 1024 });
      expect(JSON.parse(result.stdout)).toMatchObject({
        verified: true,
        handoff_id: handoff.receipt.handoff_id,
        receipt_sha256: handoff.receipt_sha256,
      });
      expect((await fs.readdir(path.dirname(handoff.receiptPath))).some(
        name => name.startsWith(".authority-seal-"),
      )).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
