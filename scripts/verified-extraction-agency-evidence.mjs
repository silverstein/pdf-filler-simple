const TITLE_PAGE = 1;

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

export const VERIFIED_AGENCY_EVIDENCE_POLICY = Object.freeze({
  name: "pdf-tools.verified-agency-evidence",
  version: "1.0.0-experimental",
  boundary: "Agency is proposed only from a single exact title-page signature containing the literal parent organization, agency, and publication series. Corpus identity and body-page mentions are not evidence.",
});
