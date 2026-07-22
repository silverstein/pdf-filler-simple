import { execFileSync } from "child_process";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function trackedDocumentationPaths() {
  return execFileSync(
    "git",
    ["ls-files", "-z", "--", "*.md", "manifest.json", "manifest.mcpb.json"],
    { cwd: REPO_ROOT },
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function claimBearingPaths() {
  return [
    ...trackedDocumentationPaths(),
    "server/index.js",
    "pdf-toolkit-mcp-share/server/index.js",
  ];
}

async function readRepositoryFile(relativePath) {
  return fs.readFile(path.join(REPO_ROOT, relativePath), "utf8");
}

function findMatches(contents, pattern) {
  return contents
    .split("\n")
    .flatMap((line, index) => pattern.test(line) ? [`${index + 1}: ${line.trim()}`] : []);
}

describe("documentation capability claims", () => {
  it("does not advertise absent PDF or OCR dependencies", async () => {
    const falseCapabilityPatterns = [
      /\bOCR support\b/i,
      /\bautomatic OCR\b/i,
      /\bOCR\/image extraction\b/i,
      /\bwith OCR\b/i,
      /\bperform(?:s|ed|ing)? OCR\b/i,
    ];
    const allowedBoundaryContext =
      /\b(?:does not|do not|not|no|future|planned|proposal|candidate|evaluation|benchmark|unsupported|unavailable)\b/i;
    const violations = [];

    for (const relativePath of claimBearingPaths()) {
      const contents = await readRepositoryFile(relativePath);
      for (const match of findMatches(contents, /pdf-parse/i)) {
        violations.push(`${relativePath}:${match}`);
      }
      for (const pattern of falseCapabilityPatterns) {
        const globalPattern = new RegExp(pattern.source, `${pattern.flags}g`);
        for (const match of contents.matchAll(globalPattern)) {
          const context = contents.slice(
            Math.max(0, match.index - 100),
            Math.min(contents.length, match.index + match[0].length + 100),
          );
          if (!allowedBoundaryContext.test(context)) {
            const lineNumber = contents.slice(0, match.index).split("\n").length;
            violations.push(`${relativePath}:${lineNumber}: ${match[0]}`);
          }
        }
      }
    }

    for (const relativePath of ["package.json", "pdf-toolkit-mcp-share/package.json"]) {
      const packageJson = JSON.parse(await readRepositoryFile(relativePath));
      const dependencyNames = Object.keys({
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      });
      expect(dependencyNames, relativePath).not.toContain("pdf-parse");
      expect(
        dependencyNames.some(name => /(?:^|[-_/])ocr(?:$|[-_/])/i.test(name)),
        `${relativePath} must not silently add an OCR package while docs describe OCR as unshipped`,
      ).toBe(false);
    }

    expect(violations).toEqual([]);
  });

  it("keeps extraction limitations explicit on current product surfaces", async () => {
    const readme = await readRepositoryFile("README.md");
    const developmentGuide = await readRepositoryFile("CLAUDE.md");
    const maintainerGuide = await readRepositoryFile("docs/MAINTAINERS.md");
    const shareReadme = await readRepositoryFile("pdf-toolkit-mcp-share/README.md");
    const sourceManifest = JSON.parse(await readRepositoryFile("manifest.json"));
    const packedManifest = JSON.parse(await readRepositoryFile("manifest.mcpb.json"));

    for (const [name, contents] of [
      ["README.md", readme],
      ["CLAUDE.md", developmentGuide],
      ["docs/MAINTAINERS.md", maintainerGuide],
      ["pdf-toolkit-mcp-share/README.md", shareReadme],
    ]) {
      expect(contents, name).toMatch(/does not (?:currently )?bundle an OCR engine/i);
      expect(contents, name).toMatch(/selected\s+(?:`read_pdf_content`\s+)?(?:result|extraction)[\s\S]{0,180}no text[\s\S]{0,180}page 1/i);
      expect(contents, name).toMatch(/(?:raster images?|rasterization)[\s\S]{0,120}(?:not|do not|rather than)[\s\S]{0,80}(?:recognized text|produce recognized text)/i);
      expect(contents, name).toMatch(/mixed\s+text\/raster[\s\S]{0,180}(?:pages? after page 1|later raster pages?)/i);
    }

    expect(sourceManifest.long_description).toMatch(/does not currently bundle OCR/i);
    expect(sourceManifest.long_description).toMatch(/selected `read_pdf_content` extraction has no text[\s\S]{0,100}page 1/i);
    expect(sourceManifest.long_description).toMatch(/raster images, not OCR text/i);
    expect(sourceManifest.long_description).toMatch(/mixed text\/raster documents and raster pages after page 1/i);
    expect(packedManifest.long_description).toBe(sourceManifest.long_description);
  });

  it("does not promise zero egress for host or model content", async () => {
    const zeroEgressPatterns = [
      /nothing is uploaded/i,
      /all processing happens locally/i,
      /analy(?:ze|sis) document content locally/i,
      /(?:files|PDFs).{0,80}stay on (?:your|the user's) machine/i,
      /without (?:sending|uploading)(?: files| PDFs?)?(?: to a web app)?/i,
    ];
    const currentProductPaths = [
      "README.md",
      "CLAUDE.md",
      "docs/MAINTAINERS.md",
      "docs/releases/v0.8.6.md",
      "pdf-toolkit-mcp-share/README.md",
      "manifest.json",
      "manifest.mcpb.json",
      "server/index.js",
      "pdf-toolkit-mcp-share/server/index.js",
    ];
    const violations = [];

    for (const relativePath of currentProductPaths) {
      const contents = await readRepositoryFile(relativePath);
      for (const pattern of zeroEgressPatterns) {
        for (const match of findMatches(contents, pattern)) {
          violations.push(`${relativePath}:${match}`);
        }
      }
    }

    const readme = await readRepositoryFile("README.md");
    const shareReadme = await readRepositoryFile("pdf-toolkit-mcp-share/README.md");
    const sourceManifest = JSON.parse(await readRepositoryFile("manifest.json"));
    expect(readme).toMatch(/complete workflow is not necessarily zero egress/i);
    expect(shareReadme).toMatch(/complete workflow is not necessarily[\s\n]+zero egress/i);
    expect(sourceManifest.long_description).toMatch(/returned through MCP may be processed under the selected host or model provider's data terms/i);
    expect(violations).toEqual([]);
  });
});
