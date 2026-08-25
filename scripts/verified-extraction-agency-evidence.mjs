const TITLE_PAGE = 1;
const MAX_PUBLICATION_PAGE = 4;

const PUBLICATION_DISCLAIMER = [
  "Although this information product, for the most part, is in the public domain, it also may contain copyrighted materials",
  "as noted in the text. Permission to reproduce copyrighted items must be secured from the copyright owner.",
].join("\n");
const SUGGESTED_CITATION_MARKER = "Suggested citation:\n";
const PUBLICATION_SERIES_MENTION = /(?:Circular|Open-File[ \t\n]+Report|Professional[ \t\n]+Paper|Scientific[ \t\n]+Investigations[ \t\n]+(?:Map|Report)|Techniques[ \t\n]+and[ \t\n]+Methods)[^\n]*/gu;

const AGENCY_SIGNATURES = Object.freeze([
  Object.freeze({
    agency: "U.S. Geological Survey",
    parent: "U.S. Department of the Interior",
    series: /^(?:Circular|Open-File Report|Professional Paper|Scientific Investigations Map|Scientific Investigations Report|Techniques and Methods)\s+[A-Za-z0-9][A-Za-z0-9.–—-]*$/u,
  }),
]);

function exactLines(content) {
  return content.split(/\r?\n/u).filter(line => line.length > 0);
}

function titlePageChunk(chunk) {
  return chunk
    && typeof chunk === "object"
    && typeof chunk.chunk_id === "string"
    && /^chunk\.[a-f0-9]{64}$/u.test(chunk.chunk_id)
    && chunk.page_range?.start_page === TITLE_PAGE
    && chunk.page_range?.end_page === TITLE_PAGE
    && typeof chunk.content === "string"
    && chunk.content.length > 0;
}

function frontMatterChunk(chunk) {
  return chunk
    && typeof chunk === "object"
    && typeof chunk.chunk_id === "string"
    && /^chunk\.[a-f0-9]{64}$/u.test(chunk.chunk_id)
    && Number.isInteger(chunk.page_range?.start_page)
    && chunk.page_range.start_page === chunk.page_range?.end_page
    && chunk.page_range.start_page >= TITLE_PAGE
    && chunk.page_range.start_page <= MAX_PUBLICATION_PAGE
    && typeof chunk.content === "string"
    && chunk.content.length > 0;
}

function publicationCitationExcerpt(content) {
  const disclaimerPositions = [];
  for (let offset = content.indexOf(PUBLICATION_DISCLAIMER); offset >= 0;
    offset = content.indexOf(PUBLICATION_DISCLAIMER, offset + PUBLICATION_DISCLAIMER.length)) {
    disclaimerPositions.push(offset);
  }
  if (disclaimerPositions.length === 0) return null;
  const disclaimerAt = disclaimerPositions[disclaimerPositions.length - 1];
  const afterDisclaimer = disclaimerAt + PUBLICATION_DISCLAIMER.length;
  if (content[afterDisclaimer] !== "\n") return null;
  const markerAt = content.indexOf(SUGGESTED_CITATION_MARKER, afterDisclaimer + 1);
  if (markerAt >= 0 && content.indexOf(SUGGESTED_CITATION_MARKER, markerAt + 1) >= 0) return null;
  const start = markerAt >= 0 ? markerAt + SUGGESTED_CITATION_MARKER.length : afterDisclaimer + 1;
  if (markerAt >= 0 && markerAt !== afterDisclaimer + 1) return null;
  // Some source text layers repeat the standard disclaimer verbatim before
  // one labelled citation. That is still unambiguous because the sole marker
  // must immediately follow the final exact disclaimer. Multiple unlabelled
  // disclaimer blocks cannot identify which following block governs.
  if (markerAt < 0 && disclaimerPositions.length !== 1) return null;
  const citationBody = content.slice(start);
  const lines = citationBody.split("\n");
  if (markerAt < 0 && /^Suggested citation:/iu.test(lines[0])) return null;
  const yearLeadLine = lines.slice(0, 5)
    .findIndex((line, index) => /, (?:19|20)\d{2},/u.test(line)
      || (index > 0 && lines[index - 1].endsWith(",") && /^(?:19|20)\d{2},/u.test(line)));
  if (yearLeadLine < 0) return null;
  const authorLead = lines.slice(0, yearLeadLine + 1).join("\n");
  if (Buffer.byteLength(authorLead, "utf8") > 1200
    || !/^\p{L}/u.test(authorLead)
    || Array.from(authorLead.matchAll(/,(?: |\n)(?:19|20)\d{2},/gu)).length !== 1) return null;
  const doiAt = citationBody.indexOf("https://doi.org/");
  if (doiAt < 0) return null;
  const doiSentence = /^https:\/\/doi\.org\/[ \t\n]*10\.[0-9]{4,9}\/[A-Za-z0-9._;()/: \t–—-]*(?:\n[A-Za-z0-9._;()/: \t–—-]+)?[A-Za-z0-9)]\./u
    .exec(citationBody.slice(doiAt));
  if (!doiSentence) return null;
  const excerpt = citationBody.slice(0, doiAt + doiSentence[0].length);
  if (!excerpt || Buffer.byteLength(excerpt, "utf8") > 2000
    || !excerpt.includes("U.S. Geological Survey")
    || !AGENCY_SIGNATURES.some(signature => excerpt.split("\n").some(line => line.includes(signature.agency))
      && Array.from(excerpt.matchAll(PUBLICATION_SERIES_MENTION)).length === 1)
    || excerpt.includes("Associated data for this publication:")) return null;
  return { excerpt, marker: markerAt >= 0 ? "suggested_citation" : "standard_unlabelled_citation" };
}

export function deriveSourceSupportedAgencyProposal({ chunks }) {
  if (!Array.isArray(chunks)) throw new TypeError("chunks must be an array");
  const matches = [];
  for (const chunk of chunks) {
    if (!titlePageChunk(chunk)) continue;
    const lines = exactLines(chunk.content);
    for (const signature of AGENCY_SIGNATURES) {
      const parentCount = lines.filter(line => line === signature.parent).length;
      const occurrenceCount = lines.filter(line => line === signature.agency).length;
      const seriesLines = lines.filter(line => signature.series.test(line));
      if (occurrenceCount < 1 || parentCount !== occurrenceCount
        || seriesLines.length !== occurrenceCount || new Set(seriesLines).size !== 1) continue;
      matches.push({
        proposal: {
          agency: {
            value: signature.agency,
            citation: { chunk_id: chunk.chunk_id, quote: signature.agency },
          },
          publication_citation_excerpt: null,
          contributors: [],
          first_table: null,
        },
        evidence: {
          kind: "source_supported_title_page_signature",
          page_one_based: TITLE_PAGE,
          parent_quote: signature.parent,
        },
      });
    }
  }
  if (matches.length !== 1) return null;
  return matches[0];
}

export function deriveSourceSupportedPublicationCitationProposal({ chunks }) {
  if (!Array.isArray(chunks)) throw new TypeError("chunks must be an array");
  const matches = [];
  for (const chunk of chunks) {
    if (!frontMatterChunk(chunk)) continue;
    const citation = publicationCitationExcerpt(chunk.content);
    if (!citation) continue;
    matches.push({
      proposal: {
        agency: null,
        publication_citation_excerpt: {
          value: citation.excerpt,
          citation: { chunk_id: chunk.chunk_id, quote: citation.excerpt },
        },
        contributors: [],
        first_table: null,
      },
      evidence: {
        kind: "source_supported_publication_citation",
        form: citation.marker,
        page_one_based: chunk.page_range.start_page,
        disclaimer_quote: PUBLICATION_DISCLAIMER,
      },
    });
  }
  if (matches.length !== 1) return null;
  return matches[0];
}

export function deriveSourceSupportedFrontMatterProposals({ chunks }) {
  if (!Array.isArray(chunks)) throw new TypeError("chunks must be an array");
  return [
    ["agency", deriveSourceSupportedAgencyProposal({ chunks })],
    ["publication_citation", deriveSourceSupportedPublicationCitationProposal({ chunks })],
  ].flatMap(([resolver, derived]) => derived ? [{
    resolver,
    evidence: derived.evidence,
    proposal: derived.proposal,
  }] : []);
}

export const VERIFIED_AGENCY_EVIDENCE_POLICY = Object.freeze({
  name: "pdf-tools.verified-agency-evidence",
  version: "1.0.0-experimental",
  boundary: "Agency is proposed only from a single exact title-page signature containing the literal parent organization, agency, and publication series. Corpus identity and body-page mentions are not evidence.",
});

export const VERIFIED_PUBLICATION_CITATION_EVIDENCE_POLICY = Object.freeze({
  name: "pdf-tools.verified-publication-citation-evidence",
  version: "1.0.0-experimental",
  boundary: "A publication citation is proposed only from one exact early-front-matter chunk containing the literal standard USGS publication disclaimer, one bounded USGS series citation, and its exact DOI sentence. References, associated-data citations, normalized text, and ambiguous chunks are not evidence.",
});
