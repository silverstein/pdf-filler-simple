import { describe, expect, it } from "vitest";
import { rasterizeFidelityRegions } from "./fidelity-observations.js";

const POLICY = { intended_region_halo_pixels: 0 };

function count(mask) {
  return mask.reduce((sum, value) => sum + value, 0);
}

describe("fidelity region viewport transforms", () => {
  it("maps top-left MediaBox coordinates through a nonzero CropBox viewport", () => {
    const mask = rasterizeFidelityRegions(200, 300, [[5, 10, 20, 30]], POLICY, {
      media_box: [10, 20, 100, 150],
      viewport_transform: [2, 0, 0, -2, -20, 340],
    });
    expect(count(mask)).toBe(40 * 60);
    expect(mask[20 * 200 + 10]).toBe(1);
    expect(mask[79 * 200 + 49]).toBe(1);
    expect(mask[19 * 200 + 10]).toBe(0);
    expect(mask[80 * 200 + 50]).toBe(0);
  });

  it("maps all four corners through a 90-degree viewport", () => {
    const mask = rasterizeFidelityRegions(100, 200, [[10, 5, 20, 10]], POLICY, {
      media_box: [0, 0, 100, 50],
      viewport_transform: [0, 2, 2, 0, 0, 0],
    });
    expect(count(mask)).toBe(20 * 40);
    expect(mask[20 * 100 + 70]).toBe(1);
    expect(mask[59 * 100 + 89]).toBe(1);
    expect(mask[19 * 100 + 70]).toBe(0);
    expect(mask[60 * 100 + 90]).toBe(0);
  });

  it("fails closed without an exact viewport transform", () => {
    expect(() => rasterizeFidelityRegions(100, 100, [[0, 0, 10, 10]], POLICY, {
      media_box: [0, 0, 50, 50],
    })).toThrow(/viewport transform/);
  });
});
