import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  classifySourceBoundBatch,
  validateNormalizedSourcePageBundle,
} from "./verified-extraction-response-admission.mjs";

export const VERIFIED_EXTRACTION_EVIDENCE_ROUTER_IDENTITY = Object.freeze({
  name: "pdf-tools.schema-directed-evidence-router",
  version: "1.0.0-experimental",
});

const CHUNK_ID = /^chunk\.[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_CANONICAL_CITATION_CHARACTERS = 600;
const MAX_CANONICAL_TABLE_ANCHOR_CHARACTERS = 360;

const canonicalJson = value => Array.isArray(value) ? `[${value.map(canonicalJson).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const sha256 = value => createHash("sha256").update(value).digest("hex");

function assertion(condition, message) {
  if (!condition) throw new Error(`Invalid schema-directed evidence plan: ${message}`);
}

function withoutKey(value, key) {
  const copy = structuredClone(value);
  delete copy[key];
  return copy;
}

function exactKeys(value, expected, label) {
  assertion(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assertion(canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort()),
    `${label} keys are invalid`);
}

function validateChunks(documentChunks, documentId) {
  assertion(Array.isArray(documentChunks) && documentChunks.length > 0,
    "documentChunks must be a non-empty array");
  let previousPage = 0;
  const seen = new Set();
  for (const [index, chunk] of documentChunks.entries()) {
    exactKeys(chunk, ["chunk_id", "content", "content_sha256", "document_id", "page_range",
      "starts_at_heading"], `documentChunks[${index}]`);
    assertion(chunk.document_id === documentId, `documentChunks[${index}] belongs to another document`);
    assertion(CHUNK_ID.test(chunk.chunk_id) && !seen.has(chunk.chunk_id),
      `documentChunks[${index}] identity is invalid or duplicated`);
    seen.add(chunk.chunk_id);
    assertion(chunk.page_range && Number.isSafeInteger(chunk.page_range.start_page)
      && chunk.page_range.start_page >= 1
      && chunk.page_range.start_page === chunk.page_range.end_page
      && chunk.page_range.start_page >= previousPage,
    `documentChunks[${index}] page range is invalid`);
    previousPage = chunk.page_range.start_page;
    assertion(typeof chunk.content === "string" && chunk.content.length > 0
      && SHA256.test(chunk.content_sha256)
      && chunk.content_sha256 === sha256(Buffer.from(chunk.content, "utf8")),
    `documentChunks[${index}] content binding is invalid`);
    assertion(typeof chunk.starts_at_heading === "boolean",
      `documentChunks[${index}].starts_at_heading is invalid`);
  }
}

function pageContainingSuggestedCitation(pages) {
  return pages.find(page => page.normalized_text.includes("Suggested citation:")) ?? null;
}

function pageContainingCitationFallback(pages) {
  return pages.find(page => /(?:https:\/\/doi\.org\/|\bdoi:)/iu.test(page.normalized_text)
    && /U\.S\. Geological Survey/iu.test(page.normalized_text)) ?? null;
}

function pageContainingByline(pages, citationPage, surnames) {
  const eligible = pages.filter(page => page.page_one_based <= citationPage.page_one_based);
  const explicit = eligible.find(page => /\bBy\s+[\p{Lu}]/u.test(page.normalized_text));
  if (explicit) return explicit;
  const escaped = surnames.map(surname => surname.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  return eligible.filter(page => page.page_one_based < citationPage.page_one_based)
    .reverse().find(page => escaped.every(surname => new RegExp(`\\b${surname}\\b`, "iu")
      .test(page.normalized_text))) ?? null;
}

function canonicalCitationExcerpt(pageText, proposedExcerpt = null) {
  let start = pageText.indexOf("Suggested citation:");
  if (start < 0 && typeof proposedExcerpt === "string" && proposedExcerpt.length > 0) {
    start = pageText.indexOf(proposedExcerpt);
  }
  if (start < 0) {
    const candidateStart = /(?:^|[.!?]\s+)([\p{Lu}][\p{L}’'-]+,\s+(?:[\p{Lu}]\.){1,3})/gu;
    for (const match of pageText.matchAll(candidateStart)) {
      const offset = match.index + match[0].length - match[1].length;
      const candidate = pageText.slice(offset, Math.min(pageText.length,
        offset + MAX_CANONICAL_CITATION_CHARACTERS));
      if (/,(?:\s+)(?:19|20)[0-9]{2},/u.test(candidate)
        && /https:\/\/doi\.org\//iu.test(candidate)) {
        start = offset;
        break;
      }
    }
  }
  assertion(start >= 0, "the citation page has no deterministic citation start");
  return pageText.slice(start, Math.min(pageText.length,
    start + MAX_CANONICAL_CITATION_CHARACTERS)).trimEnd();
}

function canonicalTableAnchor(pageText) {
  const match = /\b(?:Table|TABLE)\s+1(?:\.[0-9]+)?\.\s+\S/gu.exec(pageText);
  assertion(match, "the first-table page has no canonical Table 1 heading");
  return pageText.slice(match.index, Math.min(pageText.length,
    match.index + MAX_CANONICAL_TABLE_ANCHOR_CHARACTERS)).trimEnd();
}

function citationSurnames(citationExcerpt) {
  const prefix = citationExcerpt.startsWith("Suggested citation:")
    ? citationExcerpt.slice("Suggested citation:".length).trimStart()
    : citationExcerpt;
  const year = /,\s+(?:19|20)[0-9]{2},/u.exec(prefix);
  assertion(year, "the canonical citation has no author/year boundary");
  const authorTokens = prefix.slice(0, year.index).split(",").map(token => token.trim());
  assertion(authorTokens.length >= 2 && authorTokens.length % 2 === 0,
    "the canonical citation author list is not surname/credit pairs");
  const surnames = [];
  for (let index = 0; index < authorTokens.length; index += 2) {
    const surname = authorTokens[index].replace(/^and\s+/iu, "").trim();
    const credit = authorTokens[index + 1];
    assertion(surname.length > 0 && credit.length > 0,
      "the canonical citation contains an empty surname or credit");
    surnames.push(surname);
  }
  assertion(new Set(surnames).size === surnames.length,
    "the canonical citation contains duplicate contributor surnames");
  return surnames;
}

function candidateSupportsSurname(candidateName, surname) {
  return candidateName === surname || candidateName.endsWith(` ${surname}`);
}

function sourceWindowAround(pageText, value, before = 120, after = 240) {
  const at = pageText.indexOf(value);
  assertion(at >= 0, `source value ${JSON.stringify(value)} is absent from its evidence page`);
  return pageText.slice(Math.max(0, at - before), Math.min(pageText.length,
    at + value.length + after)).trim();
}

export function buildSchemaDirectedEvidencePlan({
  documentId,
  documentMapSha256,
  sourceSha256,
  documentChunks,
  documentTableRegions,
  documentSourcePages,
}) {
  assertion(typeof documentId === "string" && documentId.length > 0,
    "documentId must be a non-empty string");
  assertion(SHA256.test(documentMapSha256 ?? "") && SHA256.test(sourceSha256 ?? ""),
    "document or source identity is invalid");
  validateChunks(documentChunks, documentId);
  const sourcePages = validateNormalizedSourcePageBundle(documentSourcePages, {
    documentId,
    sourceSha256,
  });
  const allChunkIds = documentChunks.map(chunk => chunk.chunk_id);
  const fullPolicy = classifySourceBoundBatch({
    documentId,
    documentMapSha256,
    sourceSha256,
    documentChunks,
    documentTableRegions,
    documentSourcePages,
    batchChunkIds: allChunkIds,
  });
  const citationPage = pageContainingSuggestedCitation([...sourcePages.pagesByNumber.values()])
    ?? pageContainingCitationFallback([...sourcePages.pagesByNumber.values()]);
  assertion(citationPage, "no source-bound publication citation page was found");
  const citationExcerpt = canonicalCitationExcerpt(citationPage.normalized_text);
  const bylinePage = pageContainingByline([...sourcePages.pagesByNumber.values()], citationPage,
    citationSurnames(citationExcerpt));
  assertion(bylinePage, "no source-bound credited-name page was found before the publication citation");
  const firstTable = fullPolicy.first_actual_table;
  assertion(firstTable, "no deterministic first actual table was found");
  const firstTablePage = sourcePages.pagesByNumber.get(firstTable.page_one_based);
  assertion(firstTablePage, "the first-table page is absent from canonical source pages");

  const reasonsByPage = new Map();
  const addReason = (page, reason) => {
    const reasons = reasonsByPage.get(page) ?? [];
    if (!reasons.includes(reason)) reasons.push(reason);
    reasonsByPage.set(page, reasons);
  };
  addReason(citationPage.page_one_based, "publication_citation_and_contributors");
  addReason(bylinePage.page_one_based, "credited_byline_cross_check");
  addReason(firstTable.page_one_based, "first_actual_table");

  const forbidden = new Set(fullPolicy.chunk_policies
    .filter(item => item.evidence_admission === "forbidden_reference_section")
    .map(item => item.chunk_id));
  const selectedPages = [...reasonsByPage].sort((left, right) => left[0] - right[0])
    .map(([pageOneBased, reasons]) => {
      const chunkIds = documentChunks.filter(chunk => chunk.page_range.start_page === pageOneBased
        && !forbidden.has(chunk.chunk_id)).map(chunk => chunk.chunk_id);
      assertion(chunkIds.length > 0, `selected page ${pageOneBased} has no admissible source chunk`);
      return { page_one_based: pageOneBased, reasons, chunk_ids: chunkIds };
    });
  const selectedChunkIds = selectedPages.flatMap(page => page.chunk_ids);
  assertion(new Set(selectedChunkIds).size === selectedChunkIds.length,
    "selected pages contain duplicate chunk identities");
  const body = {
    contract: structuredClone(VERIFIED_EXTRACTION_EVIDENCE_ROUTER_IDENTITY),
    document_id: documentId,
    document_map_sha256: documentMapSha256,
    source_sha256: sourceSha256,
    source_page_text_bundle_sha256: sourcePages.sha256,
    document_chunk_scope_sha256: fullPolicy.document_chunk_scope_sha256,
    document_table_regions_sha256: fullPolicy.document_table_regions_sha256,
    selected_pages: selectedPages,
    selected_chunk_ids: selectedChunkIds,
    selected_chunk_count: selectedChunkIds.length,
    total_chunk_count: documentChunks.length,
    maximum_model_calls_after_context_splitting: selectedChunkIds.length,
    first_actual_table: {
      ...structuredClone(firstTable),
      canonical_anchor_excerpt: canonicalTableAnchor(firstTablePage.normalized_text),
    },
    citation_page_one_based: citationPage.page_one_based,
    byline_page_one_based: bylinePage.page_one_based,
    model_or_provider_calls_made: 0,
    oracle_accessed: false,
    benchmark_claim_ready: false,
  };
  return { ...body, plan_sha256: sha256(Buffer.from(canonicalJson(body), "utf8")) };
}

export function validateSchemaDirectedEvidencePlan({
  plan,
  documentChunks,
  documentTableRegions,
  documentSourcePages,
}) {
  exactKeys(plan, ["benchmark_claim_ready", "byline_page_one_based", "citation_page_one_based",
    "contract", "document_chunk_scope_sha256", "document_id", "document_map_sha256",
    "document_table_regions_sha256", "first_actual_table", "maximum_model_calls_after_context_splitting",
    "model_or_provider_calls_made", "oracle_accessed", "plan_sha256", "selected_chunk_count",
    "selected_chunk_ids", "selected_pages", "source_page_text_bundle_sha256", "source_sha256",
    "total_chunk_count"], "plan");
  const rebuilt = buildSchemaDirectedEvidencePlan({
    documentId: plan.document_id,
    documentMapSha256: plan.document_map_sha256,
    sourceSha256: plan.source_sha256,
    documentChunks,
    documentTableRegions,
    documentSourcePages,
  });
  assertion(canonicalJson(plan) === canonicalJson(rebuilt),
    "plan does not replay from the retained source evidence");
  return plan;
}

export function canonicalizeSchemaDirectedExtraction({
  plan,
  documentChunks,
  documentTableRegions,
  documentSourcePages,
  result,
}) {
  validateSchemaDirectedEvidencePlan({
    plan,
    documentChunks,
    documentTableRegions,
    documentSourcePages,
  });
  exactKeys(result, ["contributors", "publication", "summary"], "result");
  exactKeys(result.publication, ["agency", "publication_citation_excerpt"], "result.publication");
  exactKeys(result.summary, ["contributor_count", "first_table"], "result.summary");
  assertion(typeof result.publication.agency === "string" && result.publication.agency.length > 0,
    "result publication agency is invalid");
  assertion(Array.isArray(result.contributors), "result contributors is invalid");

  const sourcePages = validateNormalizedSourcePageBundle(documentSourcePages, {
    documentId: plan.document_id,
    sourceSha256: plan.source_sha256,
  });
  const citationPage = sourcePages.pagesByNumber.get(plan.citation_page_one_based);
  const bylinePage = sourcePages.pagesByNumber.get(plan.byline_page_one_based);
  const tablePage = sourcePages.pagesByNumber.get(plan.first_actual_table.page_one_based);
  assertion(citationPage && bylinePage && tablePage, "canonical source page is absent");
  assertion(citationPage.normalized_text.includes(result.publication.agency),
    "the proposed agency is absent from the schema-directed citation page");
  const publicationCitationExcerpt = canonicalCitationExcerpt(citationPage.normalized_text,
    result.publication.publication_citation_excerpt);
  const surnames = citationSurnames(publicationCitationExcerpt);
  const submittedNames = result.contributors.map((contributor, index) => {
    exactKeys(contributor, ["name"], `result.contributors[${index}]`);
    assertion(typeof contributor.name === "string" && contributor.name.length > 0,
      `result.contributors[${index}].name is invalid`);
    return contributor.name;
  });
  const contributors = surnames.map(surname => {
    const candidates = submittedNames.filter(candidate => candidate !== surname
      && candidateSupportsSurname(candidate, surname)
      && bylinePage.normalized_text.includes(candidate))
      .sort((left, right) => right.length - left.length || left.localeCompare(right));
    assertion(candidates.length > 0,
      `no complete source-bound display name supports citation contributor ${surname}`);
    assertion(candidates.length === 1 || candidates[0].length !== candidates[1].length,
      `citation contributor ${surname} has ambiguous complete display names`);
    return { name: candidates[0] };
  });
  assertion(new Set(contributors.map(contributor => contributor.name)).size === contributors.length,
    "credited citation contributors resolve to duplicate display names");
  const firstTable = {
    page_one_based: plan.first_actual_table.page_one_based,
    anchor_excerpt: plan.first_actual_table.canonical_anchor_excerpt,
  };
  const canonicalResult = {
    publication: {
      agency: result.publication.agency,
      publication_citation_excerpt: publicationCitationExcerpt,
    },
    contributors,
    summary: {
      contributor_count: contributors.length,
      first_table: firstTable,
    },
  };
  const citations = {
    "publication.agency": {
      page: bylinePage.page_one_based,
      quote: sourceWindowAround(bylinePage.normalized_text, result.publication.agency),
    },
    "publication.publication_citation_excerpt": {
      page: citationPage.page_one_based,
      quote: publicationCitationExcerpt,
    },
    ...Object.fromEntries(contributors.map(contributor => ([
      `contributors[name=${contributor.name}]`,
      {
        page: bylinePage.page_one_based,
        quote: sourceWindowAround(bylinePage.normalized_text, contributor.name),
      },
    ]))),
    "summary.first_table": {
      page: tablePage.page_one_based,
      quote: firstTable.anchor_excerpt,
    },
  };
  for (const [path, citation] of Object.entries(citations)) {
    const page = sourcePages.pagesByNumber.get(citation.page);
    assertion(page?.normalized_text.includes(citation.quote),
      `citation ${path} does not replay from its canonical source page`);
  }
  const body = {
    contract: { name: "pdf-tools.schema-directed-canonical-projection", version: 1 },
    evidence_plan_sha256: plan.plan_sha256,
    result: canonicalResult,
    citations,
    diagnostics: {
      proposed_contributors: submittedNames.length,
      citation_contributors: surnames.length,
      retained_contributors: contributors.length,
      dropped_proposed_contributors: submittedNames.filter(name => (
        !contributors.some(contributor => contributor.name === name)
      )),
      model_or_provider_calls_made: 0,
      oracle_accessed: false,
    },
    benchmark_claim_ready: false,
  };
  return { ...body, projection_sha256: sha256(Buffer.from(canonicalJson(body), "utf8")) };
}

export function verifySchemaDirectedCanonicalProjection(args) {
  const projection = canonicalizeSchemaDirectedExtraction(args);
  assertion(canonicalJson(args.projection) === canonicalJson(projection),
    "projection does not replay from retained evidence and result");
  return projection;
}

export const __test = Object.freeze({
  canonicalCitationExcerpt,
  canonicalTableAnchor,
  citationSurnames,
  sourceWindowAround,
});
