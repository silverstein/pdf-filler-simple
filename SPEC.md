# SPEC — Verified vision B5: integration and truthful evidence

Bead: `pdf-toolkit-mcp-14o.6`
Branch: `codex/verified-vision-b5`
Stack base: B4 exact SHA `3eb889c` (local B0-B4 plus ruling-evidence prerequisite).

## Objective

Integrate the complete verified-vision workflow into the public contract and maintainer evidence. Document the opt-in proposal packet, deterministic verifier, source-backed GFM projection, fail-closed behavior, and exact claim boundary. Keep runtime and share-package contracts byte-aligned and leave release, push, merge, and public claim approval at the B6 human gate.

## Public contract

- `convert_pdf_to_markdown` remains default-off and byte-identical unless `emit_table_proposals` is explicitly enabled. Typed abstention gaps remain present.
- Each bounded proposal packet is tied to the fresh source bytes, renderer IR version, and region identity. Document-level truncation counts prevent silent omission at the region cap.
- `verify_table_proposal` reparses the source and treats every caller-supplied assignment as untrusted. Acceptance requires B2 coverage, one-cell, order, and independent-header checks plus B3 rectangular-grid, cut consistency, ruling agreement, and ambiguity refusal.
- Accepted cell content is rebuilt only from the source text layer. The caller cannot provide content, geometry, Markdown, or confidence.
- Accepted structures include deterministic GFM Markdown. Structured spans remain authoritative; GFM uses anchor text with empty continuation cells because GFM cannot encode spans.
- Rejected proposals return no cells or Markdown.
- The verifier proves that accepted content is present in the source and that the proposed topology is consistent with the available replayed evidence. It does not prove that the topology is unique or semantically correct.

## Evidence contract

- Report source-content accuracy and proposal outcomes on the committed authored fixture suite, including the exact denominator.
- Separate seeded known-wrong proposals from deliberately ambiguous proposals and from the authored recoverable control.
- Report the contribution of B3 grid-consistency checks against the B2-only counterfactual.
- Repeat Claude's aggregate-only, deterministic 90-document local frequency probe without retaining file names or document content. Treat it as a private, selection-biased operational check rather than a benchmark.
- Keep `benchmark_claim_ready`, `calibration_claim_ready`, and `production_claim_ready` false. No model, OCR system, or real-world benchmark is evaluated in this tranche.

## Documentation and packaging

Update `README.md`, both manifests, `docs/OUTPUT_SCHEMAS.md`, `docs/MCP_CONTRACT.md`, maintainer guidance, and a dated integration evidence note. Verify tool registration, all four MCP annotations, output schemas, source/share byte parity, package counts, and generated contract artifacts.

## Acceptance

Focused integration tests and the aggregate `npm run test:all` gate run on the exact committed tree. Any inherited host-timing failures are classified with baseline evidence rather than concealed. The B5 lane is locally committed and clean. B6 remains the explicit maintainer gate for claim language, landing, and the single milestone push; release and publication are not authorized.
