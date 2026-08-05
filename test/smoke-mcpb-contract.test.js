import { describe, expect, it } from "vitest";
import { validatePackedDiscovery } from "../scripts/smoke-mcpb.mjs";

describe("packed MCPB discovery binding", () => {
  const currentTools = [
    ...Array.from({ length: 39 }, (_, index) => ({ name: `fixture_tool_${index}` })),
    { name: "render_pdf_page" },
    { name: "compare_pdfs" },
    { name: "inspect_pdf_accessibility" },
  ];

  it("accepts only the current 42-tool discovery", () => {
    expect(() => validatePackedDiscovery(currentTools)).not.toThrow();
    expect(() => validatePackedDiscovery(currentTools.slice(1))).toThrow(/42-tool contract/);
  });

  it("requires every smoke-critical tool", () => {
    for (const required of ["render_pdf_page", "compare_pdfs", "inspect_pdf_accessibility"]) {
      expect(() => validatePackedDiscovery(
        currentTools.map(tool => tool.name === required ? { name: "stale_tool" } : tool),
      )).toThrow(/42-tool contract/);
    }
  });
});
