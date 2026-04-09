import { describe, expect, it } from "vitest";
import { buildManagedPdfPath, getHostBaseName, joinHostPath, splitHostPath } from "../ui/src/path-utils";

describe("path-utils", () => {
  it("extracts the basename from POSIX and Windows paths", () => {
    expect(getHostBaseName("/Users/alice/Documents/form.pdf")).toBe("form.pdf");
    expect(getHostBaseName("C:\\Users\\alice\\Documents\\form.pdf")).toBe("form.pdf");
  });

  it("keeps Windows separators when creating managed PDF paths", () => {
    expect(buildManagedPdfPath("C:\\Users\\alice\\Documents\\form.pdf"))
      .toBe("C:\\Users\\alice\\Documents\\form_managed.pdf");
  });

  it("keeps POSIX separators when creating managed PDF paths", () => {
    expect(buildManagedPdfPath("/Users/alice/Documents/form.pdf"))
      .toBe("/Users/alice/Documents/form_managed.pdf");
  });

  it("splits host paths without losing the drive prefix", () => {
    expect(splitHostPath("C:\\Users\\alice\\Documents\\form.pdf")).toEqual({
      dir: "C:\\Users\\alice\\Documents",
      base: "form.pdf",
    });
  });

  it("joins host paths with the dominant separator", () => {
    expect(joinHostPath("C:\\Users\\alice\\Documents", "managed.pdf"))
      .toBe("C:\\Users\\alice\\Documents\\managed.pdf");
    expect(joinHostPath("/Users/alice/Documents", "managed.pdf"))
      .toBe("/Users/alice/Documents/managed.pdf");
  });
});
