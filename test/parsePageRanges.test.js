import { describe, it, expect } from "vitest";
import { parsePageRanges } from "../server/helpers.js";

describe("parsePageRanges", () => {
  // === Valid dash ranges ===
  it("parses a single range", () => {
    expect(parsePageRanges("1-5", 10)).toEqual([[1, 5]]);
  });

  it("parses multiple comma-separated ranges", () => {
    expect(parsePageRanges("1-5,6-10", 10)).toEqual([[1, 5], [6, 10]]);
  });

  it("parses three ranges", () => {
    expect(parsePageRanges("1-3,4-7,8-10", 10)).toEqual([[1, 3], [4, 7], [8, 10]]);
  });

  it("handles whitespace around commas and dashes", () => {
    expect(parsePageRanges(" 1 - 5 , 6 - 10 ", 10)).toEqual([[1, 5], [6, 10]]);
  });

  it("parses a single page number", () => {
    expect(parsePageRanges("3", 10)).toEqual([[3, 3]]);
  });

  it("parses mixed single pages and ranges", () => {
    expect(parsePageRanges("1,3-5,7", 10)).toEqual([[1, 1], [3, 5], [7, 7]]);
  });

  // === "every N" shorthand ===
  it("splits evenly with 'every 5' on 10 pages", () => {
    expect(parsePageRanges("every 5", 10)).toEqual([[1, 5], [6, 10]]);
  });

  it("handles remainder with 'every 5' on 13 pages", () => {
    expect(parsePageRanges("every 5", 13)).toEqual([[1, 5], [6, 10], [11, 13]]);
  });

  it("handles 'every 1' (one page per file)", () => {
    const result = parsePageRanges("every 1", 3);
    expect(result).toEqual([[1, 1], [2, 2], [3, 3]]);
  });

  it("handles 'every N' larger than total pages", () => {
    expect(parsePageRanges("every 100", 5)).toEqual([[1, 5]]);
  });

  it("is case-insensitive for 'every'", () => {
    expect(parsePageRanges("EVERY 3", 9)).toEqual([[1, 3], [4, 6], [7, 9]]);
  });

  // === Error cases ===
  it("throws on empty string", () => {
    expect(() => parsePageRanges("", 10)).toThrow("Empty page range");
  });

  it("throws on reversed range (start > end)", () => {
    expect(() => parsePageRanges("5-3", 10)).toThrow("start (5) > end (3)");
  });

  it("throws on page out of bounds", () => {
    expect(() => parsePageRanges("1-15", 10)).toThrow("out of range");
  });

  it("throws on page 0", () => {
    expect(() => parsePageRanges("0-5", 10)).toThrow("must be >= 1");
  });

  it("throws on invalid format", () => {
    expect(() => parsePageRanges("abc", 10)).toThrow("Invalid page range");
  });

  it("throws on 'every 0'", () => {
    expect(() => parsePageRanges("every 0", 10)).toThrow("N > 0");
  });

  it("throws on 'every -1' (regex rejects negative, falls through to invalid range)", () => {
    expect(() => parsePageRanges("every -1", 10)).toThrow("Invalid page range");
  });

  it("throws on single page out of bounds", () => {
    expect(() => parsePageRanges("15", 10)).toThrow("out of range");
  });
});
