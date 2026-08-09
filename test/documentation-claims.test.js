import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { TOOL_OUTPUT_SCHEMAS } from "../server/output-schemas.js";
import {
  DISPLAY_NAME_CANDIDATES,
  computeToolIdentifierBudget,
} from "../scripts/tool-identifier-budget.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CURRENT_PRODUCT_SURFACES = [
  "README.md",
  "CLAUDE.md",
  "AGENTS.md",
  "docs/MAINTAINERS.md",
  "docs/SUPPORT.md",
  // The normative MCP contract went a full cycle asserting a prompt-argument
  // isolation boundary that had been deleted, because this list did not
  // include it.
  "docs/MCP_CONTRACT.md",
  "docs/releases/v0.9.5.md",
  "pdf-toolkit-mcp-share/README.md",
  "manifest.json",
  "manifest.mcpb.json",
  "server/index.js",
  "pdf-toolkit-mcp-share/server/index.js",
];
const POSITIVE_OCR_PATTERNS = [
  /\bOCR\s*(?:\/\s*image\s*)?(?:support|fallback|extraction|engine|capabilit(?:y|ies)|pipeline)\b/i,
  /\b(?:automatic|built[- ]in|bundled|integrated|native|local)\s+OCR\b/i,
  /\b(?:includes?|runs?|performs?|provides?|supports?|uses?|ships?|offers?|handles?)\b[^.!?;\n]{0,60}\bOCR\b/i,
  /\bwith\s+(?:(?:automatic|built[- ]in|integrated|local)\s+)?OCR\b/i,
  /\bOCR\s+is\s+(?:not\s+)?(?:supported|included|available|enabled|bundled|built[ -]in)\b/i,
  /\b(?:has|have|features?|contains?)\b[^.!?;\n]{0,40}\bOCR\b/i,
  /\bOCR[ -]enabled\b/i,
  /\bOCR\b[^.!?;\n]{0,40}\bbuilt[ -]in\b/i,
];
const EXPLICIT_OCR_BOUNDARIES = [
  /\b(?:does not|do not|doesn't|don't|cannot|can't|never)\s+(?:currently\s+)?(?:bundle|include|run|perform|provide|support|use|ship|offer|have)\b[^.!?;\n]{0,80}\bOCR\b/i,
  /\bdoes not\s+render\s+pages,\s+run\s+OCR(?:\s*,|\s+or\b)/i,
  /\bno\s+(?:(?:built[- ]in|bundled|integrated|local|automatic)\s+)?OCR\s+(?:support|fallback|extraction|engine|capabilit(?:y|ies)|pipeline)\b/i,
  /\bwithout\s+(?:(?:built[- ]in|bundled|integrated|local|automatic)\s+)?OCR\b/i,
  /\b(?:future|planned|proposed|candidate|experimental|optional)\s+(?:(?:local|bundled|integrated)\s+)?OCR\b/i,
  /\bOCR\b[^.!?;\n]{0,100}\b(?:unavailable|unsupported|unshipped|planned|proposed|future|candidate|evaluation|benchmark)\b/i,
  /\bOCR\b[^.!?;\n]{0,100}\bnot\s+(?:shipped|included|available|supported|bundled|implemented|enabled)\b/i,
  /\bOCR\s+is\s+not\s+(?:supported|included|available|enabled|bundled|built[ -]in)\b/i,
  /\b(?:has|have|features?|contains?)\s+no\s+OCR\b/i,
  /\bOCR\b[^.!?;\n]{0,40}\bdoes not come built[ -]in\b/i,
  /\bnot\s+OCR[ -]enabled\b/i,
];
const POSITIVE_SCANNED_TEXT_PATTERNS = [
  /\b(?:recognizes?|extracts?|reads?|transcribes?)\s+(?:all\s+)?scanned\s+text\b/i,
  /\b(?:recognizes?|extracts?|reads?|transcribes?)\s+(?:all\s+)?text\s+(?:from|in)\s+scanned\s+(?:PDFs?|documents?|pages?)\b/i,
  /\bscanned\s+(?:PDFs?|text|documents?|pages?)\s+(?:is|are)\s+(?:not\s+)?(?:automatically\s+)?(?:recognized|extracted|read|transcribed)\b/i,
  /\btext\s+(?:in|from)\s+scanned\s+(?:PDFs?|documents?|pages?)\s+(?:is|are)\s+(?:not\s+)?(?:automatically\s+)?(?:recognized|extracted|read|transcribed)\b/i,
];
const EXPLICIT_SCANNED_TEXT_BOUNDARIES = [
  /\b(?:does not|do not|doesn't|don't|cannot|can't|never)\s+(?:currently\s+)?(?:recognize|extract|read|transcribe)\b[^.!?;\n]{0,80}\bscanned\s+(?:text|PDFs?|documents?|pages?)\b/i,
  /\bscanned\s+(?:text|PDFs?|documents?|pages?)\b[^.!?;\n]{0,80}\b(?:not recognized|not extracted|unrecognized|unsupported|planned|future)\b/i,
  /\btext\s+(?:in|from)\s+scanned\s+(?:PDFs?|documents?|pages?)\s+(?:is|are)\s+not\s+(?:recognized|extracted|read|transcribed)\b/i,
];
const POSITIVE_PDF_PARSE_PATTERNS = [
  /\b(?:uses?|includes?|requires?|bundles?)\b[^.!?;\n]{0,50}\bpdf-parse\b/i,
  /\bdepends?\s+on\b[^.!?;\n]{0,50}\bpdf-parse\b/i,
  /\bships?\s+with\b[^.!?;\n]{0,50}\bpdf-parse\b/i,
  /\bpdf-parse\s+is\s+(?:not\s+)?(?:used|included|required|bundled|installed)\b/i,
];
const EXPLICIT_PDF_PARSE_BOUNDARIES = [
  /\b(?:does not|do not|doesn't|don't|never)\s+(?:currently\s+)?(?:use|include|require|bundle)\b[^.!?;\n]{0,50}\bpdf-parse\b/i,
  /\b(?:does not|do not|doesn't|don't|never)\s+(?:currently\s+)?depend\s+on\b[^.!?;\n]{0,50}\bpdf-parse\b/i,
  /\b(?:does not|do not|doesn't|don't|never)\s+(?:currently\s+)?ship\s+with\b[^.!?;\n]{0,50}\bpdf-parse\b/i,
  /\bpdf-parse\s+is\s+not\s+(?:used|included|required|bundled|installed)\b/i,
];

async function readRepositoryFile(relativePath) {
  return fs.readFile(path.join(REPO_ROOT, relativePath), "utf8");
}

function findMatches(contents, pattern) {
  return contents
    .split("\n")
    .flatMap((line, index) => pattern.test(line) ? [`${index + 1}: ${line.trim()}`] : []);
}

function collectJsonStrings(value, strings = []) {
  if (typeof value === "string") {
    strings.push(value);
  } else if (Array.isArray(value)) {
    value.forEach(item => collectJsonStrings(item, strings));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach(item => collectJsonStrings(item, strings));
  }
  return strings;
}

function splitClaimUnits(text, { sourceCode = false } = {}) {
  if (sourceCode) {
    return text.split("\n").map(line => line.trim()).filter(Boolean);
  }

  return text
    .replaceAll("\r\n", "\n")
    .split(/\n\s*\n/)
    .flatMap(paragraph => {
      const lines = paragraph.split("\n").map(line => line.trim()).filter(Boolean);
      const hasListItems = lines.some(line => /^(?:[-*•]|\d+[.)])\s+/.test(line));
      const units = hasListItems ? lines : [lines.join(" ")];
      return units.flatMap(unit => unit.split(/(?<=[.!?;])\s+/));
    })
    .map(unit => unit.trim())
    .filter(Boolean);
}

function claimUnits(relativePath, contents) {
  if (relativePath.endsWith(".json")) {
    return collectJsonStrings(JSON.parse(contents)).flatMap(value => splitClaimUnits(value));
  }
  return splitClaimUnits(contents, { sourceCode: relativePath.endsWith(".js") });
}

function findOcrClaimViolations(units) {
  return units.filter(unit => {
    const positiveOcr = POSITIVE_OCR_PATTERNS.some(pattern => pattern.test(unit));
    const boundedOcr = EXPLICIT_OCR_BOUNDARIES.some(pattern => pattern.test(unit));
    const positiveScannedText = POSITIVE_SCANNED_TEXT_PATTERNS.some(pattern => pattern.test(unit));
    const boundedScannedText = EXPLICIT_SCANNED_TEXT_BOUNDARIES.some(pattern => pattern.test(unit));
    return (positiveOcr && !boundedOcr) || (positiveScannedText && !boundedScannedText);
  });
}

function findPdfParseClaimViolations(units) {
  return units.filter(unit =>
    POSITIVE_PDF_PARSE_PATTERNS.some(pattern => pattern.test(unit)) &&
    !EXPLICIT_PDF_PARSE_BOUNDARIES.some(pattern => pattern.test(unit))
  );
}

describe("documentation capability claims", () => {
  it("does not advertise absent PDF or OCR dependencies on current product surfaces", async () => {
    const violations = [];

    for (const relativePath of CURRENT_PRODUCT_SURFACES) {
      const contents = await readRepositoryFile(relativePath);
      const units = claimUnits(relativePath, contents);
      for (const unit of findPdfParseClaimViolations(units)) {
        violations.push(`${relativePath}: ${unit}`);
      }
      for (const unit of findOcrClaimViolations(units)) {
        violations.push(`${relativePath}: ${unit}`);
      }
      if (relativePath.endsWith("server/index.js")) {
        expect(contents, relativePath).toContain("No text was found in the PDF.js text layer.");
        expect(contents, relativePath).toContain(
          "Rendering page 1 as an image for host/model visual inspection...",
        );
        expect(contents, relativePath).not.toMatch(/OCR fallback/i);
      }
    }

    expect(CURRENT_PRODUCT_SURFACES).toContain("docs/releases/v0.9.5.md");
    expect(CURRENT_PRODUCT_SURFACES.some(relativePath => /evaluation/i.test(relativePath))).toBe(false);

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

  it.each([
    "PDF Tools does not include OCR support.",
    "A future OCR fallback is planned but not shipped.",
    "OCR support is unavailable in the current runtime.",
    "Optional local OCR remains a candidate for evaluation.",
    "The current package has no built-in OCR engine.",
    "OCR is not supported by the current runtime.",
    "The package has no OCR.",
    "OCR does not come built in.",
    "The runtime is not OCR-enabled.",
    "This tool does not render pages, run OCR, infer tables, or fill an arbitrary schema.",
    "PDF Tools renders scanned PDF pages for host/model visual inspection.",
    "The runtime does not recognize scanned text; it returns raster images for visual inspection.",
    "Scanned PDFs are not recognized as text.",
    "Text in scanned PDFs is not extracted by the runtime.",
  ])("allows explicitly qualified OCR boundary: %s", phrase => {
    expect(findOcrClaimViolations(splitClaimUnits(phrase))).toEqual([]);
  });

  it.each([
    "OCR fallback handles scanned PDFs.",
    "Built-in OCR reads scans.",
    "PDF Tools includes OCR for invoices.",
    "The runtime runs OCR locally.",
    "PDF Tools performs OCR automatically.",
    "Scans work with OCR.",
    "Automatic OCR is available.",
    "No text layer is required, and PDF Tools includes OCR.",
    "The runtime has no upload step but performs OCR.",
    "OCR support is included. Future improvements are planned.",
    "PDF Tools includes OCR, although no separate service is used.",
    "No OCR errors occur because built-in OCR reads scans.",
    "PDF Tools does not fail when it includes OCR.",
    "Future UI polish includes OCR support today.",
    "PDF Tools recognizes scanned text.",
    "PDF Tools extracts text from scanned PDFs.",
    "PDF Tools reads scanned text automatically.",
    "OCR is supported.",
    "OCR is included.",
    "OCR is available.",
    "OCR is enabled.",
    "OCR is bundled.",
    "OCR is built in.",
    "PDF Tools has OCR.",
    "PDF Tools features OCR.",
    "PDF Tools contains OCR.",
    "This is an OCR-enabled runtime.",
    "This tool does not render pages, but it runs OCR.",
    "This tool does not render pages and does run OCR.",
    "Scanned PDFs are recognized as text.",
    "Scanned text is extracted automatically.",
    "Scanned documents are read by the runtime.",
    "Scanned pages are transcribed.",
    "Text in scanned PDFs is recognized.",
    "Text from scanned PDFs is extracted automatically.",
  ])("rejects positive or qualification-bypass OCR claim: %s", phrase => {
    expect(findOcrClaimViolations(splitClaimUnits(phrase))).not.toEqual([]);
  });

  it.each([
    "PDF Tools does not use pdf-parse.",
    "The current runtime does not depend on pdf-parse.",
    "The package does not include pdf-parse.",
    "pdf-parse is not installed.",
  ])("allows explicitly negative pdf-parse boundary: %s", phrase => {
    expect(findPdfParseClaimViolations(splitClaimUnits(phrase))).toEqual([]);
  });

  it.each([
    "PDF Tools uses pdf-parse.",
    "The package includes pdf-parse.",
    "The runtime depends on pdf-parse.",
    "PDF Tools ships with pdf-parse.",
    "pdf-parse is installed.",
    "PDF Tools does not upload files but uses pdf-parse.",
  ])("rejects positive pdf-parse dependency claim: %s", phrase => {
    expect(findPdfParseClaimViolations(splitClaimUnits(phrase))).not.toEqual([]);
  });

  it("allows historical and evaluation files to describe former or candidate dependencies", () => {
    const historicalText =
      "Version 0.2 used pdf-parse. A candidate OCR engine was evaluated and removed.";

    expect(CURRENT_PRODUCT_SURFACES).not.toContain("docs/releases/v0.2.0.md");
    expect(CURRENT_PRODUCT_SURFACES).not.toContain("docs/EXTRACTION_EVALUATION.md");
    expect(historicalText).toContain("pdf-parse");
    expect(findOcrClaimViolations(splitClaimUnits(historicalText))).toEqual([]);
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
    const violations = [];

    for (const relativePath of CURRENT_PRODUCT_SURFACES) {
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

/*
 * Tool-count claims in the normative docs.
 *
 * These numbers had drifted twice before this suite existed. `MCP_CONTRACT.md`
 * advertised 42 runtime tools and 41 packed tools against a live 43/42, and
 * `MAINTAINERS.md` and `scripts/tool-identifier-budget.mjs` disagreed with each
 * other about the identifier-budget figures (41/14 versus 40/13, live 42/15).
 * Nothing could have caught any of it: the docs stated the counts as prose and
 * no test read them, so adding a tool left every gate green while the published
 * contract became false.
 *
 * The binding below derives every figure from the artifact that owns it - the
 * two manifests, `TOOL_OUTPUT_SCHEMAS`, and the budget module - and asserts the
 * doc sentence built from it. Adding or removing a tool now fails these tests
 * with the exact sentence to update.
 *
 * The sweep that follows is the part that generalizes. Asserting the sentences
 * we happen to know about only pins those sentences; a newly written count
 * elsewhere in the same doc would drift silently, which is precisely how the
 * two instances above arrived. So every numeric tool- or prompt-count phrase in
 * those docs must use a live count unless its context explicitly marks it as
 * frozen v1/v2 evidence.
 */
const COUNT_CLAIM_SURFACES = ["docs/MCP_CONTRACT.md", "docs/MAINTAINERS.md"];

/**
 * Qualifiers that may sit between a number and the counted noun. Deliberately a
 * whitelist rather than a wildcard: `A 30-character tool name` is a length, not
 * a count, and a wildcard reads it as one.
 */
const COUNT_QUALIFIERS =
  "(?:uniquely named|unique|packed|normal|model-workflow|structured|current|live|runtime|manifest)";
const TOOL_COUNT_PHRASE = new RegExp(
  `\\b(\\d{2,3})(?:-|\\s+)(?:${COUNT_QUALIFIERS}(?:-|\\s+))*tools?\\b`,
  "gi",
);
const PROMPT_COUNT_PHRASE = new RegExp(
  `\\b(\\d{1,3})(?:-|\\s+)(?:${COUNT_QUALIFIERS}(?:-|\\s+))*prompts?\\b`,
  "gi",
);

/**
 * A count is allowed to be stale only where the surrounding sentence says it
 * describes a frozen evidence generation rather than the shipped surface.
 */
const FROZEN_EVIDENCE_MARKERS = /\b(?:frozen|historical|tool-contracts\.v[12]|v1|v2)\b/i;

const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
];
const TENS_WORDS = [
  "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
];

function spellNumber(value) {
  if (value < 20) {
    return NUMBER_WORDS[value];
  }
  const tens = TENS_WORDS[Math.floor(value / 10)];
  const ones = value % 10;
  return ones === 0 ? tens : `${tens}-${NUMBER_WORDS[ones]}`;
}

/** Collapses the docs' hard wrapping so a claim can be matched as one sentence. */
function normalizeWhitespace(text) {
  return text.replaceAll("\r\n", "\n").replace(/\s+/g, " ").trim();
}

function findStaleCountPhrases(normalized, pattern, liveCounts) {
  const violations = [];
  for (const match of normalized.matchAll(pattern)) {
    const value = Number(match[1]);
    if (liveCounts.includes(value)) {
      continue;
    }
    const context = normalized.slice(
      Math.max(0, match.index - 120),
      match.index + match[0].length + 120,
    );
    if (FROZEN_EVIDENCE_MARKERS.test(context)) {
      continue;
    }
    violations.push(`${match[0]} (context: ...${context}...)`);
  }
  return violations;
}

describe("documentation tool-count claims", () => {
  it("states the live tool, prompt, and identifier-budget counts", async () => {
    const sourceManifest = JSON.parse(await readRepositoryFile("manifest.json"));
    const packedManifest = JSON.parse(await readRepositoryFile("manifest.mcpb.json"));
    const sourceToolCount = sourceManifest.tools.length;
    const packedToolCount = packedManifest.tools.length;
    const promptCount = sourceManifest.prompts.length;
    const structuredToolCount = Object.keys(TOOL_OUTPUT_SCHEMAS).length;

    const contract = normalizeWhitespace(await readRepositoryFile("docs/MCP_CONTRACT.md"));
    expect(contract).toContain(`The runtime returns ${sourceToolCount} uniquely named tools.`);
    expect(contract).toContain(`The source manifest lists all ${sourceToolCount} tools.`);
    expect(contract).toContain(
      `The packed MCPB manifest lists the ${packedToolCount} normal model-workflow tools`,
    );
    expect(contract).toContain(`behavioral trajectory coverage of all ${sourceToolCount} tools.`);
    expect(contract).toContain(`Identical ${promptCount}-prompt arrays in both manifests`);
    expect(contract.toLowerCase()).toContain(
      `${spellNumber(structuredToolCount)} tool handlers advertise strict \`outputschema\` contracts`,
    );

    const packedToolNames = packedManifest.tools.map(tool => tool.name);
    const shipped = computeToolIdentifierBudget(DISPLAY_NAME_CANDIDATES.shipped, packedToolNames);
    const fallback = computeToolIdentifierBudget(DISPLAY_NAME_CANDIDATES.fallback, packedToolNames);
    const rejected = computeToolIdentifierBudget(DISPLAY_NAME_CANDIDATES.rejected, packedToolNames);

    const maintainers = normalizeWhitespace(await readRepositoryFile("docs/MAINTAINERS.md"));
    expect(maintainers).toContain(
      `pushes ${rejected.overLimit.length} of the current ${packedToolCount} packed tool identifiers past the ceiling.`,
    );
    expect(maintainers).toContain(
      `(\`${shipped.longestToolName}\`, ${shipped.longestToolName.length} characters)`,
    );
    expect(maintainers).toContain(
      `- \`${DISPLAY_NAME_CANDIDATES.shipped}\`: longest identifier ${shipped.longestIdentifierLength}, headroom ${shipped.headroom}`,
    );
    expect(maintainers).toContain(
      `- \`${DISPLAY_NAME_CANDIDATES.fallback}\`: longest identifier ${fallback.longestIdentifierLength}, headroom ${fallback.headroom}`,
    );
    expect(maintainers).toContain(
      `- Original long title: longest identifier ${rejected.longestIdentifierLength}, ${rejected.overLimit.length} identifiers over the limit`,
    );
  });

  it("carries no stale tool or prompt count anywhere in the normative docs", async () => {
    const sourceManifest = JSON.parse(await readRepositoryFile("manifest.json"));
    const packedManifest = JSON.parse(await readRepositoryFile("manifest.mcpb.json"));
    const liveToolCounts = [
      sourceManifest.tools.length,
      packedManifest.tools.length,
      Object.keys(TOOL_OUTPUT_SCHEMAS).length,
      computeToolIdentifierBudget(
        DISPLAY_NAME_CANDIDATES.rejected,
        packedManifest.tools.map(tool => tool.name),
      ).overLimit.length,
    ];
    const livePromptCounts = [sourceManifest.prompts.length, packedManifest.prompts.length];

    const violations = [];
    for (const relativePath of [...COUNT_CLAIM_SURFACES, "scripts/tool-identifier-budget.mjs"]) {
      const normalized = normalizeWhitespace(await readRepositoryFile(relativePath));
      for (const phrase of findStaleCountPhrases(normalized, TOOL_COUNT_PHRASE, liveToolCounts)) {
        violations.push(`${relativePath}: ${phrase}`);
      }
      for (const phrase of findStaleCountPhrases(normalized, PROMPT_COUNT_PHRASE, livePromptCounts)) {
        violations.push(`${relativePath}: ${phrase}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("never presents a frozen evaluation count as the live runtime surface", async () => {
    // `docs/EVALUATION.md` is deliberately absent from CURRENT_PRODUCT_SURFACES
    // because it exists to describe superseded evidence generations, and its v1
    // and v2 counts must stay at 39 and 40 forever. What it may not do is call
    // one of them the runtime, which is what "the complete 40-tool runtime
    // contract" did while the runtime carried 43.
    const liveRuntimeClaims = [
      /\b(?:current|live|latest)\s+(?:\w+[\s-]+){0,3}\d{2,3}-tool\b/i,
      /\b\d{2,3}-tool\s+(?:runtime|live|current)\b/i,
    ];
    const violations = [];
    for (const relativePath of ["docs/EVALUATION.md", ...COUNT_CLAIM_SURFACES]) {
      const normalized = normalizeWhitespace(await readRepositoryFile(relativePath));
      for (const pattern of liveRuntimeClaims) {
        const match = normalized.match(pattern);
        if (match) {
          violations.push(`${relativePath}: ${match[0]}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it.each([
    ["A 30-character tool name drops the fallback to 2 characters.", []],
    ["The runtime returns 43 uniquely named tools.", []],
    ["The packed MCPB manifest lists the 42 normal model-workflow tools.", []],
    ["The v2 jobs remain bound to the reviewed v2 40-tool projection.", []],
    ["The v1 trust stack remains unchanged for the frozen 39-tool evidence.", []],
    ["The runtime returns 41 uniquely named tools.", ["41 uniquely named tools"]],
    ["The source manifest lists all 44 tools.", ["44 tools"]],
    ["A reviewed 40-tool projection is the shipped surface.", ["40-tool"]],
  ])("classifies %s", (sentence, expected) => {
    const found = findStaleCountPhrases(
      normalizeWhitespace(sentence),
      TOOL_COUNT_PHRASE,
      [42, 43, 39, 15],
    ).map(entry => entry.split(" (context:")[0]);
    expect(found).toEqual(expected);
  });
});
