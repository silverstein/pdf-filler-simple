import { describe, expect, it } from "vitest";
import {
  alignComparisonPages,
  derivePdfComparisonCoverage,
  diffComparisonRgba,
  normalizeComparisonText,
} from "../server/pdf-comparison.js";

function page(pageNumber, text, { width = 100, height = 100, rotation = 0 } = {}) {
  return {
    page: pageNumber,
    flow_text: text,
    lines: [{
      text,
      x: 5,
      y: 5,
      width: 90,
      height: 10,
      source_first_index: 0,
    }],
    geometry: {
      display_width: width,
      display_height: height,
      display_rotation: rotation,
    },
  };
}

function render(width, height, fill = 0) {
  return {
    width,
    height,
    scale: 1.5,
    binary: Buffer.alloc(width * height * 4, fill),
  };
}

describe("PDF comparison primitives", () => {
  it("normalizes Unicode and whitespace without changing case", () => {
    expect(normalizeComparisonText("  Cafe\u0301\n\tVALUE  ")).toBe("Café VALUE");
    expect(normalizeComparisonText("VALUE")).not.toBe(normalizeComparisonText("value"));
  });

  it("aligns unique exact pages across moves", () => {
    const alignments = alignComparisonPages(
      [page(1, "Alpha"), page(2, "Beta")],
      [page(1, "Beta"), page(2, "Alpha")],
    );
    expect(alignments.map(item => [item.before_page, item.after_page, item.relation]))
      .toEqual([[1, 2, "moved"], [2, 1, "moved"]]);
    expect(alignments.every(item => item.match_basis === "exact_composite_anchor"
      && item.score === 1 && item.ambiguity_group === null)).toBe(true);
  });

  it("uses weighted assignment only above fixed score and runner-up margins", () => {
    const [alignment] = alignComparisonPages(
      [page(1, "alpha beta gamma delta")],
      [page(1, "alpha beta gamma changed")],
    );
    expect(alignment).toMatchObject({
      before_page: 1,
      after_page: 1,
      relation: "same",
      match_basis: "weighted_assignment",
      ambiguity_group: null,
    });
    expect(alignment.score).toBeGreaterThanOrEqual(0.55);
  });

  it("emits one-sided inserted and deleted alignments without inventing a pair", () => {
    const alignments = alignComparisonPages(
      [page(1, "retained"), page(2, "deleted unique page")],
      [page(1, "retained"), page(2, "inserted different page")],
    );
    expect(alignments.map(item => [item.before_page, item.after_page, item.relation]))
      .toEqual([[1, 1, "same"], [2, null, "deleted"], [null, 2, "inserted"]]);
  });

  it("falls back to the unique text anchor when composite page observations change", () => {
    const alignments = alignComparisonPages(
      [page(1, "same logical page")],
      [page(1, "same logical page")],
      {
        beforeCompositeAnchors: new Map([[1, "a".repeat(64)]]),
        afterCompositeAnchors: new Map([[1, "b".repeat(64)]]),
      },
    );
    expect(alignments).toEqual([expect.objectContaining({
      relation: "same",
      match_basis: "unique_normalized_text",
      score: 1,
    })]);
  });

  it("never resolves repeated-page ambiguity by page index", () => {
    const alignments = alignComparisonPages(
      [page(1, "duplicate"), page(2, "duplicate")],
      [page(1, "duplicate"), page(2, "duplicate")],
    );
    expect(alignments).toHaveLength(4);
    expect(alignments.every(item => item.match_basis === "repeated_ambiguous"
      && item.score === 0 && item.ambiguity_group)).toBe(true);
    expect(alignments.every(item => item.before_page === null || item.after_page === null)).toBe(true);
    expect(new Set(alignments.map(item => item.ambiguity_group)).size).toBe(1);
  });

  it("applies maximum-channel threshold, one-pixel Chebyshev dilation, and area filtering", () => {
    const before = render(3, 3);
    const atThreshold = render(3, 3);
    atThreshold.binary[4 * 4] = 8;
    expect(diffComparisonRgba(before, atThreshold)).toMatchObject({
      raw_changed_pixels: 0,
      changed_pixels: 0,
      components: [],
    });

    const overThreshold = render(3, 3);
    overThreshold.binary[4 * 4] = 9;
    const difference = diffComparisonRgba(before, overThreshold);
    expect(difference).toMatchObject({
      dimension_mismatch: false,
      raw_changed_pixels: 1,
      changed_pixels: 9,
      changed_fraction: 1,
    });
    expect(difference.components).toEqual([{ area_pixels: 9, bounds: [0, 0, 2, 2] }]);
  });

  it("reports dimension mismatch without resizing either source", () => {
    expect(diffComparisonRgba(render(2, 2), render(3, 2))).toEqual({
      dimension_mismatch: true,
      raw_changed_pixels: null,
      changed_pixels: null,
      changed_fraction: null,
      bounds: null,
      components: [],
    });
  });

  it("masks only explained regions while retaining independent residual pixels", () => {
    const before = render(12, 6);
    const after = render(12, 6);
    after.binary[(2 * 12 + 2) * 4] = 20;
    after.binary[(2 * 12 + 9) * 4] = 20;
    const difference = diffComparisonRgba(before, after, [[0, 0, 3, 3]]);
    expect(difference.raw_changed_pixels).toBe(1);
    expect(difference.components).toEqual([expect.objectContaining({
      bounds: [8 / 1.5, 1 / 1.5, 2, 2],
    })]);
  });

  it("clips fully off-page ignored regions on all four sides without masking visible residuals", () => {
    const before = render(12, 6);
    const after = render(12, 6);
    after.binary[(2 * 12 + 9) * 4] = 20;
    const baseline = diffComparisonRgba(before, after);
    expect(baseline).toMatchObject({
      raw_changed_pixels: 1,
      changed_pixels: 9,
    });
    for (const region of [
      [-10, 0, 3, 3],
      [10, 0, 3, 3],
      [0, -10, 3, 3],
      [0, 10, 3, 3],
    ]) {
      expect(diffComparisonRgba(before, after, [region]), JSON.stringify(region)).toEqual(baseline);
    }
  });

  it("rejects fractional off-page regions before applying the one-pixel mask border", () => {
    const cases = [
      { region: [-0.5, 1, 0.25, 1], pixel: [0, 2] },
      { region: [8.25, 1, 0.25, 1], pixel: [11, 2] },
      { region: [2, -0.5, 1, 0.25], pixel: [4, 0] },
      { region: [2, 4.25, 1, 0.25], pixel: [4, 5] },
      { region: [-0.5, -0.5, 0.25, 0.25], pixel: [0, 0] },
      { region: [8.25, -0.5, 0.25, 0.25], pixel: [11, 0] },
      { region: [-0.5, 4.25, 0.25, 0.25], pixel: [0, 5] },
      { region: [8.25, 4.25, 0.25, 0.25], pixel: [11, 5] },
    ];
    for (const { region, pixel: [x, y] } of cases) {
      const before = render(12, 6);
      const after = render(12, 6);
      after.binary[(y * 12 + x) * 4] = 20;
      const baseline = diffComparisonRgba(before, after);
      expect(diffComparisonRgba(before, after, [region]), JSON.stringify(region))
        .toEqual(baseline);
    }
  });

  it("pads fractional partially intersecting regions without masking disjoint edge residuals", () => {
    const cases = [
      { region: [-0.25, 1, 0.5, 1], masked: [0, 2], visible: [4, 2] },
      { region: [7.75, 1, 0.5, 1], masked: [11, 2], visible: [7, 2] },
      { region: [2, -0.25, 1, 0.5], masked: [4, 0], visible: [4, 4] },
      { region: [2, 3.75, 1, 0.5], masked: [4, 5], visible: [4, 1] },
    ];
    for (const { region, masked, visible } of cases) {
      const before = render(12, 6);
      const after = render(12, 6);
      for (const [x, y] of [masked, visible]) after.binary[(y * 12 + x) * 4] = 20;
      expect(diffComparisonRgba(before, after, [region]), JSON.stringify(region))
        .toMatchObject({ raw_changed_pixels: 1 });
    }
  });

  it("ignores malformed, degenerate, and wholly off-page extreme regions", () => {
    const before = render(12, 6);
    const after = render(12, 6);
    after.binary[(3 * 12 + 6) * 4] = 20;
    const baseline = diffComparisonRgba(before, after);
    for (const region of [
      null,
      [],
      [Number.NaN, 0, 1, 1],
      [0, Number.POSITIVE_INFINITY, 1, 1],
      [0, 0, 0, 1],
      [0, 0, 1, -1],
      [Number.MAX_VALUE, 0, Number.MAX_VALUE, 1],
      [-Number.MAX_VALUE, 0, 1, 1],
    ]) {
      expect(diffComparisonRgba(before, after, [region]), JSON.stringify(region))
        .toEqual(baseline);
    }
  });

  it("marks visual coverage unavailable when any requested native render is unavailable", () => {
    const supported = { status: "supported", reason_codes: [] };
    const document = side => ({
      side,
      observation: { coverage: {
        pages: supported,
        metadata: supported,
        form_fields: supported,
        annotations: supported,
      } },
      layout: { truncation: { truncated: false }, pages: [] },
      renders: [null],
    });
    expect(derivePdfComparisonCoverage([document("before"), document("after")], true).visual)
      .toEqual({ status: "unavailable", reason_codes: ["VISUAL_RENDERER_UNAVAILABLE"] });
    expect(derivePdfComparisonCoverage([document("before"), document("after")], false).visual)
      .toEqual({ status: "unavailable", reason_codes: ["VISUAL_NOT_REQUESTED"] });
  });
});
