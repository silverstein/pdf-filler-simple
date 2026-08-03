# Extraction-intelligence epic evidence — 2026-08-03

Epic `pdf-toolkit-mcp-zyx` on branch `epic/extraction-intelligence`
(head `a546ce48623d2cfb3229319041115a51d337e7a7`), per
`docs/EXTRACTION_INTELLIGENCE_PLAN_2026-08-03.md`. Local direct-tool
observations on silvercloud (Linux x64) against the deterministic
`test/fixtures/eval/extraction/intelligence/` corpus. This is not a public
benchmark or calibration claim: `benchmark_claim_ready: false` and
`calibration_claim_ready: false` remain the standing boundary per
`docs/EXTRACTION_EVALUATION.md`.

## Before / after, per frozen-baseline fixture

| Fixture | Baseline (frozen pre-epic) | After the epic |
| --- | --- | --- |
| `table-ruled-grid.pdf` | Plain reading-order text; `TABLE_TOPOLOGY_UNKNOWN` + `VECTOR_CONTENT_NOT_INTERPRETED`; status partial | Exact GFM table reconstructed from cell-rect grid evidence (all 12 cells, header row); requalified vector gap only |
| `table-ruled-merged-negative.pdf` | Abstention (typed gaps) | Abstention preserved — **never-flip contract held** |
| `table-ruled-lines.pdf` (boundary, added in-epic) | n/a | Truthful abstention: line-segment rulings yield no closed-rect evidence; typed gaps, no table (`zyx.17` tracks line synthesis) |
| `text-integrity-pua.pdf` | Silent `complete` conversion of PUA/replacement-dense text — the bug | `TEXT_INTEGRITY_SUSPECT` gap with per-signal counts, `suspected_text_integrity` routing, text still emitted verbatim, status partial |
| `routing-mixed.pdf` | No routing surface (field absent) | `pages_needing_vision: [2]` with typed reasons across `get_page_analysis`, `read_pdf_content` (`read_pages_without_text`), and `convert_pdf_to_markdown` |
| `compact-toc.pdf` | Verbatim dot-leader TOC | Default mode byte-identical; `compact: true` collapses 10 dot leaders, removes 2 isolated page numbers, preserves the exactly-three-dot leader, exact counts in `normalizations` |

## Verification ledger

- Cross-lane suite on the integrated branch: **203/203** (serialized;
  parallel runs on silvercloud are memory-killed — recorded limitation of
  this host, aggregate gate runs on Silverbook).
- Per-lane acceptance at close: zyx.1 156/156 · zyx.2 118/118 + share
  contract · zyx.3 129/129 · zyx.4 142/142 · zyx.5 136/136 · zyx.6 18/18
  with byte-identical double regeneration.
- Share-package parity: byte-identical mirrors verified per lane and at
  each integration.
- IR v1.2.0 evidence (ruled rects, text integrity, operator counts) is
  replay-proven: `validatePdfLayoutSourceEvidence` re-derives all three
  blocks from a second parse; forgery mutations are rejected by test.
- Renderer 1.3.0 non-rect delta is pinned: committed full-output literals
  (`nonrect-differential-expected.v1_3_0/v1_3_1.json`) with a deep-diff
  whitelist proving the only 1.3.1-era additions are `options.compact` and
  `normalizations`.

## Independent-review receipts (fresh-context codex, recorded per lane)

| Lane | Rounds | Outcome |
| --- | --- | --- |
| zyx.1 | control-tower fix (null Form XObject matrix) → REJECT (3 findings: restore-underflow semantics, stale Phase 1 oracle, boundary matrix) → fixes verified | closed |
| zyx.6 | REJECT (5 findings: 3-dot material, cell truth, snapshot exactness, executable manifest truth, provenance) → fixes verified | closed |
| zyx.2 | REJECT (4) → fix round → re-review REJECT (2 residuals) → control-tower escape-hatch fixes | closed |
| zyx.3 | REJECT (7, incl. 3 critical fail-closed violations) → fix round → re-review 5/7 PASS, 2 residuals → control-tower fixes (material-overlap gate, independent pin) | closed |
| zyx.4 | REJECT (2: routing divergence, digest audit note) → control-tower fixes with MCP-level consistency test | closed |
| zyx.5 | REJECT (2: page-granular isolation data loss, repointed pin) → fix round verified | closed |

Every REJECT finding above is either fixed with a regression test or
explicitly tracked (backlog beads zyx.9–zyx.15, zyx.17; pre-existing host
failures in `pdf-toolkit-mcp-wvu`).

## Provenance

Algorithm designs ported from firecrawl/pdf-inspector (MIT, Copyright
Firecrawl) per the plan's attribution contract; no pdf-inspector code ships
in the MCPB. Silverbook aggregate `npm run test:all` result is recorded in
the zyx.7 bead notes with host, commit, and command.

## Addendum 2026-08-03: head reconciliation and the aggregate gate

Everything above was written at head `a546ce4`. The branch then advanced:
`5c9f7ed` (docs only), `77e1af9` and `0d5e091` (tracker bytes only), and
`65a49cf` (merge of reviewed `f75ef53`, which changes only
`test/fixtures/eval/extraction/phase1/layout-occurrence-oracle.v1.json`).
No `server/` or shipped runtime file changed after `a546ce4`, so the
functional evidence above speaks unchanged for `65a49cf`.

Corrections to the text above, recorded rather than rewritten:

- The claim that the Silverbook aggregate result "is recorded in the zyx.7
  bead notes" did not survive: the Beads backend regression tracked by
  `pdf-toolkit-mcp-cnh` reverted that persist (commit `77e1af9` captured
  note updates but no closure, and commit `a546ce4` persisted only the
  zyx.4 closure despite its subject line). Committed Git bytes and the
  receipts below are the authority.
- The first Silverbook aggregate at `a546ce4` was RED, not green: vitest
  10 failed / 1885 passed / 81 skipped, and the native partition never ran
  because `run-all-test-suites.mjs` short-circuits on a failing vitest
  partition. Exact receipt and full log: private vault
  `evidence/ei-aggregate-a546ce4-2026-08-03/` (log sha256 `c8a9a312…`).
  All ten failures were the retained layout-occurrence oracle failing
  closed on validator-source identity drift — pre-existing on clean master
  (bead `pdf-toolkit-mcp-wvu`: master commit `0da18ea` changed
  `server/layout-extraction.js` after the last master oracle regen) and
  reproduced on the epic branch for the sources zyx.3/4/5 legitimately
  advanced. Fix: reviewed regeneration `f75ef53` (adversarial review PASS;
  cases byte-equal, identity entries only).
- Aggregate at merged `65a49cf` on Silverbook (macOS 26.6 arm64, node
  v26.3.1, fresh bundle clone + npm ci, stock `npm run test:all`): RED,
  exit 1 — vitest 1 failed / 1894 passed / 81 skipped; native partition
  short-circuited. The ten wvu failures are gone; the single remaining
  failure is candidate-owned: `5c9f7ed`'s CLAUDE.md boundary rewrite
  dropped the explicit later-raster-pages limitation that
  `test/documentation-claims.test.js:277` enforces. Recorded as a
  truthful-documentation regression; the claims contract is not weakened
  or waived. Receipt: vault `evidence/ei-aggregate-65a49cf-2026-08-03/`
  (log sha256 `aa5592fe…`).
- Repair `55ce2e5` plus `77945ce` (worktree claude-docs-boundary-claims,
  CLAUDE.md only) restores the explicit boundary: routing metadata
  identifies pages needing vision but does not recognize their scanned
  text, including later raster pages in mixed documents. The
  `pages_needing_vision` routing description is preserved unweakened.
  Fresh-context adversarial review PASS, including verification of the
  new wording against the runtime (the page-1 image fallback is gated on
  a fully textless read; no recognition path exists) and independent
  re-application of all four claims regexes to all four product surfaces.
  Merged as `76846ef`.
- **Aggregate gate MET at `76846ef`**: Silverbook (macOS 26.6 arm64,
  node v26.3.1), fresh bundle clone + `npm ci`, stock `npm run test:all`,
  exit 0. Vitest 119 files / 1895 passed / 81 skipped / 0 failed; native
  partition 71 tests / 62 passed / 0 failed / 9 skipped. This is the
  first complete `test:all` of the cycle: both earlier aggregates
  short-circuited before the native partition, so that partition had
  never actually run against this epic. Receipt and full log: private
  vault `evidence/ei-aggregate-76846ef-2026-08-03/` (log sha256
  `7017c998…`).

This qualifies the integrated epic at source level on darwin/arm64 only.
No packaged artifact, no Windows or darwin/x64 host, and no live-host
conversation is qualified by it. Release remains HOLD, and the epic's
milestone push is an unmet human gate, so `pdf-toolkit-mcp-zyx.7` and the
parent epic stay open rather than being closed or amended on the strength
of a green suite.
