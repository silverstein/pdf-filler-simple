import { describe, expect, it } from "vitest";

import { SHARE_FILES } from "../package-for-friend.js";
import { SERVER_FILES } from "../scripts/build-mcpb.mjs";
import {
  deriveSourceSupportedAgencyProposal,
  VERIFIED_AGENCY_EVIDENCE_POLICY,
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

  it("remains an internal experimental helper", () => {
    expect(SERVER_FILES).not.toContain("verified-extraction-agency-evidence.mjs");
    expect(SHARE_FILES).not.toContain("scripts/verified-extraction-agency-evidence.mjs");
  });
});
