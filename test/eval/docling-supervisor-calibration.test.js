import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertCalibrationModeContract } from "../../scripts/eval-calibrate-docling-supervisor.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CALIBRATION_SOURCE = path.join(
  REPO_ROOT,
  "scripts/eval-calibrate-docling-supervisor.mjs",
);

describe("Docling supervisor calibration boundary", () => {
  it("uses a distinct empty work root and exact out-of-band receipt bindings", async () => {
    const source = await fs.readFile(CALIBRATION_SOURCE, "utf8");
    for (const option of [
      "--attempt-source-root",
      "--calibration-bootstrap",
      "--finalization",
      "--finalization-sha256",
      "--output",
      "--receipt",
      "--receipt-sha256",
      "--work-root",
    ]) {
      expect(source).toContain(JSON.stringify(option));
    }
    expect(source).toContain("emptyPrivateDirectory");
    expect(source).toContain("Calibration work root must be distinct");
    expect(source).toContain("attempt retained unexpected writable state");
  });

  it("executes only the receipt-retained controller and build", async () => {
    const source = await fs.readFile(CALIBRATION_SOURCE, "utf8");
    expect(source).not.toContain("compileDoclingMacosSupervisor");
    expect(source).toContain('retainedFile(receipt, "supervisor_controller")');
    expect(source).toContain('retainedFile(receipt, "supervisor_source")');
    expect(source).toContain("data:text/javascript;base64");
    expect(source).toContain("verifyDoclingMacosSupervisorBuild");
    expect(source).toContain(
      "Calibration build differs across receipt, finalization, and live verification",
    );
  });

  it("stages disjoint observation and confirmation attempts and freezes the recommendation", async () => {
    const source = await fs.readFile(CALIBRATION_SOURCE, "utf8");
    expect(source).toContain('"observation"');
    expect(source).toContain('"confirmation"');
    expect(source).toContain("stageAttempts");
    expect(source).toContain(
      "Calibration recommendation differs from the frozen receipt policy",
    );
    expect(source).toContain("delete frozenPolicy.calibration_attestation_sha256");
    expect(source).toContain("Private non-scored calibration only");
  });

  it("enforces the explicit calibration-mode trust contract in both directions", () => {
    // Bootstrap re-measurement requires a marked receipt.
    expect(() => assertCalibrationModeContract(true, {}))
      .toThrow(/requires a calibration-bootstrap-marked receipt/);
    expect(() => assertCalibrationModeContract(true, { calibration_bootstrap: true }))
      .not.toThrow();
    // Ordinary calibration must never consume a marked receipt.
    expect(() => assertCalibrationModeContract(false, { calibration_bootstrap: true }))
      .toThrow(/cannot feed an ordinary calibration/);
    expect(() => assertCalibrationModeContract(false, {}))
      .not.toThrow();
    // The marker is only meaningful as the literal boolean true. Any other
    // present value is malformed provenance and refused in both modes.
    expect(() => assertCalibrationModeContract(false, { calibration_bootstrap: "true" }))
      .toThrow(/literal true; this receipt is malformed/);
    expect(() => assertCalibrationModeContract(true, { calibration_bootstrap: "true" }))
      .toThrow(/literal true; this receipt is malformed/);
    expect(() => assertCalibrationModeContract(false, { calibration_bootstrap: false }))
      .toThrow(/literal true; this receipt is malformed/);
  });

  it("checks the mode contract before staging and taints the bootstrap report and envelope", async () => {
    const source = await fs.readFile(CALIBRATION_SOURCE, "utf8");
    expect(source.indexOf("assertCalibrationModeContract(calibrationBootstrap, receipt)"))
      .toBeGreaterThan(-1);
    // Contract check precedes attempt staging in the source.
    expect(source.indexOf("assertCalibrationModeContract(calibrationBootstrap, receipt)"))
      .toBeLessThan(source.indexOf("stageAttempts"));
    // The report and the stdout envelope both carry the taint when and only
    // when the run was a bootstrap re-measurement.
    expect(source).toContain("...(calibrationBootstrap ? { calibration_bootstrap: true } : {})");
    expect(source).toContain("...(calibrationBootstrap ? { calibration_bootstrap: true, qualifying: false } : {})");
    expect(source).toContain('"--calibration-bootstrap"');
    expect(source).toContain("must be exactly true or false");
  });
});
