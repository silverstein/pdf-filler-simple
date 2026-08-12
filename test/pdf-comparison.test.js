import { describe, expect, it } from "vitest";
import {
  PDF_COMPARISON_COVERAGE_REASONS,
  PDF_COMPARISON_SIDES,
  alignComparisonPages,
  derivePdfComparisonCoverage,
  diffComparisonRgba,
  normalizeComparisonText,
} from "../server/pdf-comparison.js";
import { PDF_OBSERVATION_COVERAGE_REASONS } from "../server/pdf-observations.js";

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

function render(width, height, fill = 0, options = {}) {
  const scale = options.scale ?? 1.5;
  const logicalWidth = options.logicalWidth ?? width / scale;
  const logicalHeight = options.logicalHeight ?? height / scale;
  const exactLogicalWidth = options.exactLogicalWidth ?? logicalWidth;
  const exactLogicalHeight = options.exactLogicalHeight ?? logicalHeight;
  const rawWidth = options.rawWidth ?? exactLogicalWidth * scale;
  const rawHeight = options.rawHeight ?? exactLogicalHeight * scale;
  const rotation = options.rotation ?? 0;
  const userUnit = options.userUnit ?? 1;
  const nativeWidth = (rotation % 180 === 0 ? logicalWidth : logicalHeight) / userUnit;
  const nativeHeight = (rotation % 180 === 0 ? logicalHeight : logicalWidth) / userUnit;
  return {
    width,
    height,
    scale,
    renderer: "native-canvas",
    comparison_view: {
      raw_width_pixels: rawWidth,
      raw_height_pixels: rawHeight,
    },
    page_view: {
      view_box: [0, 0, nativeWidth, nativeHeight],
      width_points: logicalWidth,
      height_points: logicalHeight,
      rotation,
      user_unit: userUnit,
      coordinate_space: "pdfjs_viewport_top_left_points",
    },
    requested_region: { x: 0, y: 0, width: logicalWidth, height: logicalHeight },
    rendered_region: { x: 0, y: 0, width, height },
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

  it("uses exact page points instead of rounded raster dimensions at right and bottom edges", () => {
    const options = { logicalWidth: 8.1, logicalHeight: 4.1 };
    const cases = [
      { region: [8.2, 1, 0.2, 1], pixel: [12, 3] },
      { region: [2, 4.2, 1, 0.2], pixel: [4, 6] },
    ];
    for (const { region, pixel: [x, y] } of cases) {
      const before = render(13, 7, 0, options);
      const after = render(13, 7, 0, options);
      after.binary[(y * 13 + x) * 4] = 20;
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

  it("disables masking when equal pixel canvases bind different logical render mappings", () => {
    const before = render(151, 76, 0, {
      logicalWidth: 100.2,
      logicalHeight: 50.2,
    });
    const after = render(151, 76, 0, {
      logicalWidth: 100.4,
      logicalHeight: 50.4,
    });
    after.binary[(15 * 151 + 150) * 4] = 20;
    const baseline = diffComparisonRgba(before, after);
    expect(diffComparisonRgba(before, after, [[100.3, 10, 0.05, 1]]))
      .toEqual(baseline);

    const rotatedAfter = render(151, 76, 0, {
      logicalWidth: 100.2,
      logicalHeight: 50.2,
    });
    rotatedAfter.page_view.rotation = 90;
    rotatedAfter.binary[(15 * 151 + 150) * 4] = 20;
    const rotatedBaseline = diffComparisonRgba(before, rotatedAfter);
    expect(diffComparisonRgba(before, rotatedAfter, [[99, 9, 2, 2]]))
      .toEqual(rotatedBaseline);
  });

  it("fails closed when both render mappings share the same invalid metadata", () => {
    const mutations = [
      ["wrong coordinate space", value => { value.page_view.coordinate_space = "pdf_user_space_bottom_left_points"; }],
      ["missing coordinate space", value => { delete value.page_view.coordinate_space; }],
      ["non-finite view box", value => { value.page_view.view_box = [Number.NaN, 0, 8, 4]; }],
      ["missing view box", value => { delete value.page_view.view_box; }],
      ["degenerate view box", value => { value.page_view.view_box = [0, 0, 0, 4]; }],
      ["inconsistent view box", value => { value.page_view.view_box = [0, 0, 1, 1]; }],
      ["invalid rotation", value => { value.page_view.rotation = 45; }],
      ["missing rotation", value => { delete value.page_view.rotation; }],
      ["negative UserUnit", value => { value.page_view.user_unit = -1; }],
      ["missing UserUnit", value => { delete value.page_view.user_unit; }],
      ["wrong renderer", value => { value.renderer = "macos-quicklook"; }],
      ["missing exact viewport", value => { delete value.comparison_view; }],
      ["non-finite exact viewport", value => { value.comparison_view.raw_width_pixels = Number.NaN; }],
      ["unbound exact viewport", value => { value.comparison_view.raw_width_pixels -= 0.000001; }],
      ["shifted requested region", value => { value.requested_region.x = 1; }],
      ["cropped requested region", value => { value.requested_region.width -= 1; }],
      ["missing rendered region", value => { delete value.rendered_region; }],
      ["shifted rendered region", value => { value.rendered_region.x = 1; }],
      ["cropped rendered region", value => { value.rendered_region.width -= 1; }],
    ];
    for (const [label, mutate] of mutations) {
      const before = render(12, 6);
      const after = render(12, 6);
      mutate(before);
      mutate(after);
      after.binary[(2 * 12 + 2) * 4] = 20;
      const baseline = diffComparisonRgba(before, after);
      expect(diffComparisonRgba(before, after, [[0, 0, 3, 3]]), label).toEqual(baseline);
    }
  });

  it("fails closed when both renders drift from the frozen comparison scale", () => {
    const before = render(16, 8, 0, { scale: 2 });
    const after = render(16, 8, 0, { scale: 2 });
    after.binary[(2 * 16 + 2) * 4] = 20;
    const baseline = diffComparisonRgba(before, after);
    expect(diffComparisonRgba(before, after, [[0, 0, 3, 3]])).toEqual(baseline);
  });

  it("accepts a self-consistent rotated page view with a positive UserUnit", () => {
    const options = { rotation: 90, userUnit: 2 };
    const before = render(12, 6, 0, options);
    const after = render(12, 6, 0, options);
    after.binary[(2 * 12 + 2) * 4] = 20;
    after.binary[(2 * 12 + 9) * 4] = 20;
    expect(diffComparisonRgba(before, after, [[0, 0, 3, 3]])).toMatchObject({
      raw_changed_pixels: 1,
    });
  });

  it("uses the producer's unrounded viewport at a raster ceiling boundary", () => {
    const options = {
      logicalWidth: 100,
      logicalHeight: 50.2,
      exactLogicalWidth: 100.0000001,
    };
    const before = render(151, 76, 0, options);
    const after = render(151, 76, 0, options);
    after.binary[(2 * 151 + 2) * 4] = 20;
    after.binary[(2 * 151 + 9) * 4] = 20;
    expect(diffComparisonRgba(before, after, [[0, 0, 3, 3]])).toMatchObject({
      raw_changed_pixels: 1,
    });
    const baseline = diffComparisonRgba(before, after);
    expect(diffComparisonRgba(before, after, [[100.0000002, 1, 0.1, 1]]))
      .toEqual(baseline);
  });

  it("fails closed to no masking when exact logical render metadata is unavailable", () => {
    const before = render(12, 6);
    const after = render(12, 6);
    delete before.page_view;
    after.binary[(2 * 12 + 2) * 4] = 20;
    const baseline = diffComparisonRgba(before, after);
    expect(diffComparisonRgba(before, after, [[0, 0, 3, 3]])).toEqual(baseline);
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

  /*
   * `derivePdfComparisonCoverage` copies every reason a document observation
   * carries into a comparison channel with the side's name in front, and
   * `validatePdfComparisonSemantics` then rejects any reason the comparison
   * does not recognise. So the comparison's vocabulary has to be a superset of
   * the observation's, and for three reasons it was not:
   * RAW_PAGE_GEOMETRY_UNAVAILABLE, FORM_FIELD_PAGE_GEOMETRY_PARTIAL and
   * ANNOTATION_PAGE_PARSE_PARTIAL. A document raising any of them turned a
   * valid comparison into "Internal output validation failed for compare_pdfs".
   *
   * Both sides of this are read from the modules that own them, so a reason
   * added to an observation and forgotten here fails immediately instead of
   * waiting for a document that happens to raise it.
   */
  it("recognises every reason a document observation can hand it, on both sides", () => {
    const observationReasons = Object.values(PDF_OBSERVATION_COVERAGE_REASONS).flat();
    expect(observationReasons.length).toBeGreaterThan(0);
    expect(new Set(observationReasons).size).toBe(observationReasons.length);
    expect(PDF_COMPARISON_SIDES).toEqual(["before", "after"]);
    for (const side of PDF_COMPARISON_SIDES) {
      for (const reason of observationReasons) {
        const prefixed = `${side.toUpperCase()}_${reason}`;
        expect(PDF_COMPARISON_COVERAGE_REASONS.has(prefixed), prefixed).toBe(true);
      }
    }
    // And the prefixing really is what the derivation does, so the check above
    // is testing the same strings the comparison will actually produce.
    const supported = { status: "supported", reason_codes: [] };
    const document = side => ({
      side,
      observation: {
        coverage: {
          pages: { status: "partial", reason_codes: [...PDF_OBSERVATION_COVERAGE_REASONS.pages] },
          metadata: supported,
          form_fields: supported,
          annotations: supported,
        },
      },
      layout: { truncation: { truncated: false }, pages: [] },
      renders: [],
    });
    const derived = derivePdfComparisonCoverage(
      [document("before"), document("after")],
      false,
    );
    expect(derived.structure.reason_codes.length)
      .toBe(PDF_OBSERVATION_COVERAGE_REASONS.pages.length * 2);
    for (const reason of derived.structure.reason_codes) {
      expect(PDF_COMPARISON_COVERAGE_REASONS.has(reason), reason).toBe(true);
    }
  });
});
