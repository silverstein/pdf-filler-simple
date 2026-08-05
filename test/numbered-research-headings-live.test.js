import path from "node:path";
import { describe, expect, it } from "vitest";
import { hashBoundedPdfFileSafely } from "../server/bounded-pdf-file.js";
import { renderPdfLayoutToMarkdown } from "../server/markdown-conversion.js";
import {
  createPdfjsSubprocessRequest,
  runPdfjsSubprocess,
} from "../server/pdfjs-subprocess.js";

const ATTENTION_SOURCE = process.env.PDF_TOOLS_ATTENTION_SOURCE;
const ADAM_SOURCE = process.env.PDF_TOOLS_ADAM_SOURCE;

async function renderExternalPdf(sourcePath, expectedSha256) {
  const sourceFile = await hashBoundedPdfFileSafely(sourcePath, 250 * 1024 * 1024, {
    assertPathAllowed: candidate => candidate,
  });
  expect(sourceFile.sha256).toBe(expectedSha256);
  const source = {
    canonical_path: sourceFile.canonicalPath,
    file_identity: sourceFile.fileIdentity,
    sha256: sourceFile.sha256,
    size_bytes: sourceFile.sizeBytes,
  };
  const markdown = [];
  for (const [startPage, endPage] of [[1, 5], [6, 10], [11, 15]]) {
    const response = await runPdfjsSubprocess(createPdfjsSubprocessRequest({
      operation: "extract_layout_for_markdown",
      source,
      password: null,
      allowedDirectories: [path.dirname(sourcePath)],
      options: {
        source_path: sourcePath,
        source_file_name: path.basename(sourcePath),
        start_page: startPage,
        end_page: endPage,
        max_items: 5000,
        max_characters: 100_000,
        max_output_characters: 200_000,
      },
    }), { timeoutMs: 30_000 });
    markdown.push(renderPdfLayoutToMarkdown(response.layout, {
      includePageBoundaries: true,
      maxMarkdownBytes: 200_000,
    }).markdown);
  }
  return markdown.join("\n\n");
}

function numberedHeadings(markdown) {
  return [...markdown.matchAll(/^#{2,4}\s+(\d{1,3}(?:\.\d{1,3}){0,2}\s+.+)$/gmu)]
    .map(match => match[1]);
}

describe("external numbered research-paper headings", () => {
  it.runIf(Boolean(ATTENTION_SOURCE))("recovers the complete numbered hierarchy in Attention Is All You Need", async () => {
    const markdown = await renderExternalPdf(
      ATTENTION_SOURCE,
      "bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697",
    );
    expect(numberedHeadings(markdown)).toEqual([
      "1 Introduction",
      "2 Background",
      "3 Model Architecture",
      "3.1 Encoder and Decoder Stacks",
      "3.2 Attention",
      "3.2.1 Scaled Dot-Product Attention",
      "3.2.2 Multi-Head Attention",
      "3.2.3 Applications of Attention in our Model",
      "3.3 Position-wise Feed-Forward Networks",
      "3.4 Embeddings and Softmax",
      "3.5 Positional Encoding",
      "4 Why Self-Attention",
      "5 Training",
      "5.1 Training Data and Batching",
      "5.2 Hardware and Schedule",
      "5.3 Optimizer",
      "5.4 Regularization",
      "6 Results",
      "6.1 Machine Translation",
      "6.2 Model Variations",
      "6.3 English Constituency Parsing",
      "7 Conclusion",
    ]);
    expect(markdown).toMatch(/^# Attention Is All You Need$/mu);
    expect(markdown).not.toMatch(/^#{1,6}\s+arXiv:/gmu);
  }, 60_000);

  it.runIf(Boolean(ADAM_SOURCE))("recovers only the currently proven Adam small-caps main sections", async () => {
    const markdown = await renderExternalPdf(
      ADAM_SOURCE,
      "eab9c73ae2ceda884b94830bda99312254bac4806f6c9f045cbab90721ecda31",
    );
    expect(numberedHeadings(markdown)).toEqual([
      "1 INTRODUCTION",
      "2 ALGORITHM",
      "3 INITIALIZATION BIAS CORRECTION",
      "4 CONVERGENCE ANALYSIS",
      "5 RELATED WORK",
      "6 EXPERIMENTS",
      "7 EXTENSIONS",
      "8 CONCLUSION",
      "10 APPENDIX",
    ]);
    expect(markdown).not.toMatch(/^#{1,6}\s+arXiv:/gmu);
  }, 60_000);
});
