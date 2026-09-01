import { describe, expect, it } from "vitest";

import { SHARE_FILES } from "../package-for-friend.js";
import { SERVER_FILES } from "../scripts/build-mcpb.mjs";
import {
  deriveSourceSupportedAgencyProposal,
  deriveSourceSupportedFrontMatterProposals,
  deriveSourceSupportedPublicationCitationProposal,
  VERIFIED_AGENCY_EVIDENCE_POLICY,
  VERIFIED_PUBLICATION_CITATION_EVIDENCE_POLICY,
} from "../scripts/verified-extraction-agency-evidence.mjs";

const chunk = (content, page = 1, id = "chunk." + "a".repeat(64)) => ({
  chunk_id: id,
  page_range: { start_page: page, end_page: page },
  content,
});

const title = [
  "U.S. Department of the Interior",
  "U.S. Geological Survey",
  "Circular 1561",
  "A Source-Bound Report",
].join("\n");
const disclaimer = [
  "Although this information product, for the most part, is in the public domain, it also may contain copyrighted materials",
  "as noted in the text. Permission to reproduce copyrighted items must be secured from the copyright owner.",
].join("\n");
const citation = [
  "River, A.B., and Stone, C.D., 2025, A source-bound report: U.S. Geological Survey",
  "Scientific Investigations Report 2025–5000, 42 p., https://doi.org/10.3133/sir20255000.",
].join("\n");
const publicationChunk = (body, page = 4, id = "chunk." + "c".repeat(64)) => chunk(body, page, id);

describe("verified agency evidence", () => {
  it("derives the exact agency and citation from a complete title-page signature", () => {
    expect(deriveSourceSupportedAgencyProposal({ chunks: [chunk(title)] })).toEqual({
      proposal: {
        agency: {
          value: "U.S. Geological Survey",
          citation: {
            chunk_id: "chunk." + "a".repeat(64),
            quote: "U.S. Geological Survey",
          },
        },
        publication_citation_excerpt: null,
        contributors: [],
        first_table: null,
      },
      evidence: {
        kind: "source_supported_title_page_signature",
        page_one_based: 1,
        parent_quote: "U.S. Department of the Interior",
      },
    });
  });

  it.each([
    ["body-page mention", [chunk(title, 2)]],
    ["missing parent", [chunk("U.S. Geological Survey\nCircular 1561")]],
    ["missing series", [chunk("U.S. Department of the Interior\nU.S. Geological Survey")]],
    ["unrecognized series", [chunk("U.S. Department of the Interior\nU.S. Geological Survey\nAnnual Review 2025")]],
    ["normalized agency", [chunk("U.S. Department of the Interior\nUS Geological Survey\nCircular 1561")]],
    ["case-drifted agency", [chunk("U.S. Department of the Interior\nU.S. geological Survey\nCircular 1561")]],
    ["duplicate agency line", [chunk(`${title}\nU.S. Geological Survey`)]],
    ["unbalanced duplicated parent", [chunk(`${title}\nU.S. Department of the Interior`)]],
    ["different repeated series", [chunk(`${title}\nU.S. Department of the Interior\nU.S. Geological Survey\nOpen-File Report 2025-1037`)]],
    ["non-document-map chunk identity", [chunk(title, 1, "retained.page-one")]],
    ["ambiguous qualifying chunks", [chunk(title), chunk(title, 1, "chunk." + "b".repeat(64))]],
  ])("rejects %s", (_label, chunks) => {
    expect(deriveSourceSupportedAgencyProposal({ chunks })).toBeNull();
  });

  it("accepts a completely duplicated title block from duplicated layout flow", () => {
    const proposal = deriveSourceSupportedAgencyProposal({ chunks: [chunk(`${title}\n${title}`)] });
    expect(proposal?.proposal.agency.value).toBe("U.S. Geological Survey");
    expect(proposal?.proposal.agency.citation.quote).toBe("U.S. Geological Survey");
  });

  it("rejects invalid caller input", () => {
    expect(() => deriveSourceSupportedAgencyProposal({ chunks: null })).toThrow("chunks must be an array");
  });

  it("states the no-family-inference boundary", () => {
    expect(VERIFIED_AGENCY_EVIDENCE_POLICY.boundary).toContain("Corpus identity");
    expect(VERIFIED_AGENCY_EVIDENCE_POLICY.boundary).toContain("not evidence");
  });

  it("derives the exact suggested publication citation through its DOI sentence", () => {
    const content = `${disclaimer}\nSuggested citation:\n${citation}\nISSN 2328-0328 (online)`;
    expect(deriveSourceSupportedPublicationCitationProposal({ chunks: [publicationChunk(content)] })).toEqual({
      proposal: {
        agency: null,
        publication_citation_excerpt: {
          value: citation,
          citation: { chunk_id: "chunk." + "c".repeat(64), quote: citation },
        },
        contributors: [],
        first_table: null,
      },
      evidence: {
        kind: "source_supported_publication_citation",
        form: "suggested_citation",
        page_one_based: 4,
        disclaimer_quote: disclaimer,
      },
    });
  });

  it("accepts one labelled citation after a duplicated exact source disclaimer", () => {
    const content = `${disclaimer}\n${disclaimer}\nSuggested citation:\n${citation}\nISSN 2328-0328 (online)`;
    const derived = deriveSourceSupportedPublicationCitationProposal({ chunks: [publicationChunk(content)] });
    expect(derived?.proposal.publication_citation_excerpt.value).toBe(citation);
    expect(derived?.evidence.form).toBe("suggested_citation");
  });

  it("preserves a bounded multiline author lead before the citation year", () => {
    const multiline = [
      "River, A.B., Stone, C.D., Mountain, E.F., and Verylongname, G.H.,",
      "Other, I.J., and Final, K.L., 2025, A source-bound report: U.S. Geological Survey",
      "Scientific Investigations Report 2025–5000, 42 p., https://doi.org/10.3133/sir20255000.",
    ].join("\n");
    const content = `${disclaimer}\nSuggested citation:\n${multiline}\nISSN 2328-0328 (online)`;
    const derived = deriveSourceSupportedPublicationCitationProposal({ chunks: [publicationChunk(content)] });
    expect(derived?.proposal.publication_citation_excerpt.value).toBe(multiline);
  });

  it("preserves an exact source line break inside the recognized series name", () => {
    const splitSeries = citation.replace("Scientific Investigations Report", "Scientific\nInvestigations Report");
    const content = `${disclaimer}\nSuggested citation:\n${splitSeries}\nISSN 2328-0328 (online)`;
    const derived = deriveSourceSupportedPublicationCitationProposal({ chunks: [publicationChunk(content)] });
    expect(derived?.proposal.publication_citation_excerpt.value).toBe(splitSeries);
  });

  it("admits a source line break between the author list and year", () => {
    const splitYear = citation.replace("Stone, C.D., 2025,", "Stone, C.D.,\n2025,");
    const content = `${disclaimer}\nSuggested citation:\n${splitYear}\nISSN 2328-0328 (online)`;
    const derived = deriveSourceSupportedPublicationCitationProposal({ chunks: [publicationChunk(content)] });
    expect(derived?.proposal.publication_citation_excerpt.value).toBe(splitYear);
  });

  it("stops at the DOI-ending sentence before an exact trailing supersession note", () => {
    const noted = `${citation} [Supersedes an earlier report.]`;
    const content = `${disclaimer}\nSuggested citation:\n${noted}\nISSN 2328-0328 (online)`;
    const derived = deriveSourceSupportedPublicationCitationProposal({ chunks: [publicationChunk(content)] });
    expect(derived?.proposal.publication_citation_excerpt.value).toBe(citation);
  });

  it("preserves one exact source line break inside the DOI", () => {
    const wrappedDoi = citation.replace("https://doi.org/10.3133", "https://doi.org/\n10.3133");
    const content = `${disclaimer}\nSuggested citation:\n${wrappedDoi}\nISSN 2328-0328 (online)`;
    const derived = deriveSourceSupportedPublicationCitationProposal({ chunks: [publicationChunk(content)] });
    expect(derived?.proposal.publication_citation_excerpt.value).toBe(wrappedDoi);
  });

  it("admits the standard unlabeled form and stops before associated data", () => {
    const content = `${disclaimer}\n${citation}\nAssociated data for this publication:\nOther, A., 2025, Unrelated data release.\nISSN 2328-7055 (online)`;
    const derived = deriveSourceSupportedPublicationCitationProposal({ chunks: [publicationChunk(content)] });
    expect(derived?.proposal.publication_citation_excerpt.value).toBe(citation);
    expect(derived?.evidence.form).toBe("standard_unlabelled_citation");
  });

  it.each([
    ["later-page reference", publicationChunk(`${disclaimer}\nSuggested citation:\n${citation}`, 5)],
    ["missing disclaimer", publicationChunk(`Suggested citation:\n${citation}`)],
    ["normalized marker", publicationChunk(`${disclaimer}\nSuggested Citation:\n${citation}`)],
    ["marker separated from disclaimer", publicationChunk(`${disclaimer}\nPreface\nSuggested citation:\n${citation}`)],
    ["missing DOI", publicationChunk(`${disclaimer}\nSuggested citation:\nRiver, A.B., 2025, U.S. Geological Survey Scientific Investigations Report 2025–5000.`)],
    ["unrecognized series", publicationChunk(`${disclaimer}\nSuggested citation:\nRiver, A.B., 2025, Annual Review: U.S. Geological Survey, https://doi.org/10.3133/example.`)],
    ["duplicated marker", publicationChunk(`${disclaimer}\nSuggested citation:\nSuggested citation:\n${citation}`)],
    ["duplicated unlabelled disclaimer", publicationChunk(`${disclaimer}\n${disclaimer}\n${citation}`)],
    ["non-document-map identity", publicationChunk(`${disclaimer}\nSuggested citation:\n${citation}`, 4, "retained.front-matter")],
  ])("rejects publication evidence from %s", (_label, candidate) => {
    expect(deriveSourceSupportedPublicationCitationProposal({ chunks: [candidate] })).toBeNull();
  });

  it("rejects ambiguous qualifying publication chunks", () => {
    const content = `${disclaimer}\nSuggested citation:\n${citation}`;
    expect(deriveSourceSupportedPublicationCitationProposal({ chunks: [
      publicationChunk(content),
      publicationChunk(content, 4, "chunk." + "d".repeat(64)),
    ] })).toBeNull();
  });

  it("rejects invalid publication caller input", () => {
    expect(() => deriveSourceSupportedPublicationCitationProposal({ chunks: null })).toThrow("chunks must be an array");
  });

  it("states the publication citation evidence boundary", () => {
    expect(VERIFIED_PUBLICATION_CITATION_EVIDENCE_POLICY.boundary).toContain("exact DOI sentence");
    expect(VERIFIED_PUBLICATION_CITATION_EVIDENCE_POLICY.boundary).toContain("associated-data citations");
    expect(VERIFIED_PUBLICATION_CITATION_EVIDENCE_POLICY.boundary).toContain("not evidence");
  });

  it("returns both bounded front-matter proposals in controller merge order", () => {
    const proposals = deriveSourceSupportedFrontMatterProposals({ chunks: [
      chunk(title),
      publicationChunk(`${disclaimer}\nSuggested citation:\n${citation}`),
    ] });
    expect(proposals.map(item => item.resolver)).toEqual(["agency", "publication_citation"]);
    expect(proposals[0].proposal.agency.value).toBe("U.S. Geological Survey");
    expect(proposals[1].proposal.publication_citation_excerpt.value).toBe(citation);
  });

  it("omits unsupported front-matter proposals rather than fabricating a placeholder", () => {
    expect(deriveSourceSupportedFrontMatterProposals({ chunks: [chunk("Unrelated source text")] }))
      .toEqual([]);
  });

  it("remains an internal experimental helper", () => {
    expect(SERVER_FILES).not.toContain("verified-extraction-agency-evidence.mjs");
    expect(SHARE_FILES).not.toContain("scripts/verified-extraction-agency-evidence.mjs");
  });
});
