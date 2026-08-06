import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  embeddedNativeCanvasAllowed,
  nativeCanvasLatched,
  nativeCanvasMarkerPath,
} from "../server/pdfjs-subprocess.js";

let stateDir;
let markerPath;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "pdf-tools-canvas-latch-"));
  markerPath = join(stateDir, "native-canvas-attempt.json");
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("embedded native canvas policy", () => {
  it("defaults on for win32 and stays off everywhere else", () => {
    const env = {};
    expect(embeddedNativeCanvasAllowed({ env, platform: "win32", markerPath })).toBe(true);
    // macOS keeps the block: it has a working system-renderer fallback and it is
    // the only platform where a canvas-attributed failure was ever observed.
    expect(embeddedNativeCanvasAllowed({ env, platform: "darwin", markerPath })).toBe(false);
    // Linux keeps the block for want of a single datapoint.
    expect(embeddedNativeCanvasAllowed({ env, platform: "linux", markerPath })).toBe(false);
  });

  it("treats 0 as an unconditional kill switch, including on win32", () => {
    const env = { PDF_TOOLS_EMBEDDED_NATIVE_CANVAS: "0" };
    for (const platform of ["win32", "darwin", "linux"]) {
      expect(embeddedNativeCanvasAllowed({ env, platform, markerPath })).toBe(false);
    }
  });

  it("treats 1 as an unconditional opt-in on platforms that default off", () => {
    const env = { PDF_TOOLS_EMBEDDED_NATIVE_CANVAS: "1" };
    for (const platform of ["win32", "darwin", "linux"]) {
      expect(embeddedNativeCanvasAllowed({ env, platform, markerPath })).toBe(true);
    }
  });

  it("latches off after a marker survives, which is what a host crash looks like", () => {
    // A marker present at policy time means a previous load began and the
    // process never returned to clear it.
    writeFileSync(markerPath, JSON.stringify({ attempted_at: "2026-08-06T00:00:00.000Z" }));
    expect(nativeCanvasLatched(markerPath)).toBe(true);
    expect(embeddedNativeCanvasAllowed({ env: {}, platform: "win32", markerPath })).toBe(false);
  });

  it("lets an explicit opt-in override the latch so an install is recoverable", () => {
    writeFileSync(markerPath, JSON.stringify({ attempted_at: "2026-08-06T00:00:00.000Z" }));
    expect(embeddedNativeCanvasAllowed({
      env: { PDF_TOOLS_EMBEDDED_NATIVE_CANVAS: "1" },
      platform: "win32",
      markerPath,
    })).toBe(true);
  });

  it("does not latch on an absent or empty marker", () => {
    expect(nativeCanvasLatched(markerPath)).toBe(false);
    writeFileSync(markerPath, "");
    expect(nativeCanvasLatched(markerPath)).toBe(false);
    expect(embeddedNativeCanvasAllowed({ env: {}, platform: "win32", markerPath })).toBe(true);
  });

  it("does not latch on an unreadable marker directory", () => {
    // A missing state directory must read as "no crash recorded", not as a latch.
    expect(nativeCanvasLatched(join(stateDir, "absent", "native-canvas-attempt.json"))).toBe(false);
  });
});

describe("marker location", () => {
  it("follows DEFAULT_PROFILES_DIR so the marker sits with the server's durable state", () => {
    expect(nativeCanvasMarkerPath({ DEFAULT_PROFILES_DIR: stateDir }))
      .toBe(join(stateDir, "native-canvas-attempt.json"));
  });

  it("ignores an unsubstituted manifest template and falls back to the home default", () => {
    // Claude Desktop can hand us a raw "${user_config...}" literal; that must not
    // become a directory name.
    const resolved = nativeCanvasMarkerPath({ DEFAULT_PROFILES_DIR: "${user_config.profiles}" });
    expect(resolved).not.toContain("${");
    expect(resolved.endsWith(join(".pdf-toolkit-files", "native-canvas-attempt.json"))).toBe(true);
  });

  it("falls back to the home default when the variable is absent or empty", () => {
    for (const env of [{}, { DEFAULT_PROFILES_DIR: "" }]) {
      expect(nativeCanvasMarkerPath(env).endsWith(
        join(".pdf-toolkit-files", "native-canvas-attempt.json"),
      )).toBe(true);
    }
  });
});

describe("crash survival, by fault injection", () => {
  // The guard writes the marker before dlopen and removes it after. These
  // reproduce that sequence against the real filesystem and assert what the
  // next boot would decide, which is the only thing that matters after the
  // host has died.
  function armed() {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(markerPath, JSON.stringify({ attempted_at: "2026-08-06T00:00:00.000Z" }));
  }
  function cleared() {
    rmSync(markerPath, { force: true });
  }

  it("a load that returns leaves no latch for the next boot", () => {
    armed();
    cleared(); // dlopen returned
    expect(embeddedNativeCanvasAllowed({ env: {}, platform: "win32", markerPath })).toBe(true);
  });

  it("a load that raises leaves no latch, so recoverable failures stay retryable", () => {
    // A missing VC++ runtime or an arch mismatch raises; the host is intact and
    // must not be permanently downgraded for it.
    armed();
    cleared(); // the catch path also clears
    expect(embeddedNativeCanvasAllowed({ env: {}, platform: "win32", markerPath })).toBe(true);
  });

  it("a load that never returns latches the next boot off", () => {
    armed();
    // no clear: the host died inside dlopen
    expect(embeddedNativeCanvasAllowed({ env: {}, platform: "win32", markerPath })).toBe(false);
    // and it stays off across further boots, rather than crash-looping
    expect(embeddedNativeCanvasAllowed({ env: {}, platform: "win32", markerPath })).toBe(false);
  });

  it("records enough in the marker to diagnose which build crashed", () => {
    armed();
    const recorded = JSON.parse(readFileSync(markerPath, "utf8"));
    expect(recorded).toHaveProperty("attempted_at");
  });
});
