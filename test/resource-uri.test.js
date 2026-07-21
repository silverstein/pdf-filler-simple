import { describe, expect, it } from "vitest";
import {
  isUnavailableResourceError,
  pathToPdfResourceUri,
  pdfResourceUriToPath,
} from "../server/resource-uri.js";

describe("PDF resource URI codec", () => {
  it.each([
    "/tmp/quarterly #1 ? draft (final).pdf",
    "C:\\Users\\Casey\\Documents\\quarterly #1 ? draft.pdf",
    "\\\\fileserver\\shared docs\\quarterly #1.pdf",
    "/tmp/日本語/rapport 100%.pdf",
  ])("round-trips POSIX, Windows, UNC, and reserved-character paths: %s", filesystemPath => {
    const uri = pathToPdfResourceUri(filesystemPath);

    expect(uri).toMatch(/^pdf:\/\/local\//);
    expect(uri).not.toContain(" ");
    expect(uri).not.toContain("#");
    expect(uri).not.toContain("?");
    expect(pdfResourceUriToPath(uri)).toBe(filesystemPath);
  });

  it.each([
    "https://local/%2Ftmp%2Fdocument.pdf",
    "pdf://other/%2Ftmp%2Fdocument.pdf",
    "pdf://user@local/%2Ftmp%2Fdocument.pdf",
    "pdf://local:4321/%2Ftmp%2Fdocument.pdf",
    "pdf://local/a/b.pdf",
    "pdf://local/relative.pdf",
    "pdf://local/%E0%A4%A",
    "pdf://local/%2Ftmp%2Fdocument.pdf?download=1",
    "pdf://local/%2Ftmp%2Fdocument.pdf#page=1",
  ])("rejects non-canonical or malformed resource URI: %s", uri => {
    expect(() => pdfResourceUriToPath(uri)).toThrow(TypeError);
  });

  it("rejects relative and NUL-containing filesystem paths", () => {
    expect(() => pathToPdfResourceUri("relative/document.pdf")).toThrow(TypeError);
    expect(() => pathToPdfResourceUri("/tmp/document\0.pdf")).toThrow(TypeError);
  });

  it("distinguishes unavailable resources from internal filesystem failures", () => {
    for (const code of ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EISDIR"]) {
      expect(isUnavailableResourceError({ code }), code).toBe(true);
    }
    for (const code of ["EIO", "EMFILE", "ENFILE", "EBADF", undefined]) {
      expect(isUnavailableResourceError({ code }), String(code)).toBe(false);
    }
  });
});
