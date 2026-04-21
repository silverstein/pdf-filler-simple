import { describe, expect, it } from "vitest";
import {
  buildManagedPdfPath,
  buildSignedWorkingPdfPath,
  getHostBaseName,
  joinHostPath,
  splitHostPath,
  stripSignedPdfSuffix,
} from "../ui/src/path-utils";

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

  it("reuses the canonical -signed path instead of producing signed-signed", () => {
    expect(buildSignedWorkingPdfPath("/Users/alice/Documents/form.pdf"))
      .toBe("/Users/alice/Documents/form-signed.pdf");
    expect(buildSignedWorkingPdfPath("/Users/alice/Documents/form-signed.pdf"))
      .toBe("/Users/alice/Documents/form-signed.pdf");
    expect(buildSignedWorkingPdfPath("C:\\Users\\alice\\Documents\\form-signed.pdf"))
      .toBe("C:\\Users\\alice\\Documents\\form-signed.pdf");
  });

  it("strips the signed suffix only when it is the terminal PDF suffix", () => {
    expect(stripSignedPdfSuffix("form-signed.pdf")).toBe("form.pdf");
    expect(stripSignedPdfSuffix("form-signed-copy.pdf")).toBe("form-signed-copy.pdf");
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
