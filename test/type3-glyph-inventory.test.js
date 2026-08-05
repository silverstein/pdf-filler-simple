import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "inventory-type3-glyphs.mjs");
const FIXTURE = path.join(REPO_ROOT, "test", "fixtures", "eval", "extraction", "type3-cm-reference.pdf");

describe("Type-3 maintainer inventory", () => {
  it("keeps whitespace-like legacy glyph controls and reports explicit omissions", async () => {
    const { stdout } = await execFileAsync(process.execPath, [SCRIPT, "--source", FIXTURE], {
      cwd: REPO_ROOT,
      maxBuffer: 1_000_000,
    });
    const report = JSON.parse(stdout);
    expect(report).toMatchObject({
      schema: "pdf-tools.type3-glyph-inventory.v1",
      occurrence_count: 12,
      abstentions: [],
      source: { page_count: 1 },
    });
    expect(report.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        original_char_code: 11,
        source_unicode_codepoints: "U+000B",
        count: 1,
      }),
      expect.objectContaining({
        family: "computer-modern-math-symbol",
        original_char_code: 0,
        intended_unicode: "−",
        count: 1,
      }),
      expect.objectContaining({
        family: "computer-modern-math-symbol",
        original_char_code: 6,
        intended_unicode: null,
        count: 1,
      }),
      expect.objectContaining({
        family: "computer-modern-math-symbol",
        original_char_code: 33,
        intended_unicode: null,
        count: 1,
      }),
    ]));
  });

  it("rejects ambiguous command-line input", async () => {
    await expect(execFileAsync(process.execPath, [SCRIPT, FIXTURE], { cwd: REPO_ROOT }))
      .rejects.toMatchObject({ code: 1 });
  });
});
