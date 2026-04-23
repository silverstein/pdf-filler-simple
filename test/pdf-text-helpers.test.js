import { describe, expect, it } from "vitest";
import { buildPageTextSegments, searchPageTexts } from "../server/helpers.js";

describe("buildPageTextSegments", () => {
  it("returns bounded page text with per-page and total truncation metadata", () => {
    const segments = buildPageTextSegments([
      { page: 1, text: "Alpha ".repeat(20) },
      { page: 2, text: "Beta ".repeat(20) },
      { page: 3, text: "Gamma ".repeat(20) },
    ], {
      startPage: 1,
      endPage: 3,
      maxCharsPerPage: 30,
      maxTotalChars: 70,
    });

    expect(segments.totalPages).toBe(3);
    expect(segments.pages).toHaveLength(3);
    expect(segments.pages[0]).toMatchObject({
      page: 1,
      returned_chars: 30,
      truncated: true,
    });
    expect(segments.pages[1]).toMatchObject({
      page: 2,
      returned_chars: 30,
      truncated: true,
    });
    expect(segments.pages[2]).toMatchObject({
      page: 3,
      returned_chars: 10,
      truncated: true,
    });
    expect(segments.totalReturnedChars).toBe(70);
    expect(segments.truncated).toBe(true);
  });

  it("rejects out-of-range page windows", () => {
    expect(() => buildPageTextSegments([
      { page: 1, text: "Only one page" },
    ], {
      startPage: 1,
      endPage: 2,
    })).toThrow(/out of range/);
  });
});

describe("searchPageTexts", () => {
  it("finds literal matches with page-numbered snippets", () => {
    const results = searchPageTexts([
      { page: 1, text: "This agreement includes indemnification and survival clauses." },
      { page: 2, text: "No governing law clause appears here." },
      { page: 3, text: "Mutual indemnification obligations apply after termination." },
    ], "indemnification", {
      maxResults: 5,
      contextChars: 20,
    });

    expect(results.matchCount).toBe(2);
    expect(results.truncated).toBe(false);
    expect(results.matches[0]).toMatchObject({
      page: 1,
      match_text: "indemnification",
    });
    expect(results.matches[0].snippet).toContain("indemnification");
    expect(results.matches[1]).toMatchObject({
      page: 3,
      match_text: "indemnification",
    });
  });

  it("caps the number of returned matches", () => {
    const results = searchPageTexts([
      { page: 1, text: "fee fee fee fee" },
    ], "fee", {
      maxResults: 2,
      contextChars: 10,
    });

    expect(results.matchCount).toBe(2);
    expect(results.truncated).toBe(true);
  });
});
