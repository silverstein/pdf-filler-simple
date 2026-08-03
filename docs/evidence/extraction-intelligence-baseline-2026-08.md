# Extraction-intelligence baseline evidence — 2026-08-03

This is the frozen W5/B6 baseline for the five synthetic fixtures described by
`SPEC.md` and §7 of `docs/EXTRACTION_INTELLIGENCE_PLAN_2026-08-03.md`. It is a
local direct-tool observation only; it is not a public benchmark or calibration
claim. The Phase 0 manifest and its digests are outside this corpus and remain
untouched.

Generator provenance

- Generator: `scripts/eval-generate-extraction-intelligence-fixtures.mjs`
- The generator, mini-manifest, fixtures, and this document are committed together
  in one change on branch `codex/eval-fixtures`.
- PDF library: `pdf-lib 1.17.1`; parser baseline: `pdfjs-dist 5.4.624`
- Content: anonymized synthetic text, geometry, raster, and character-class
  stress data only
- Mini-manifest: `test/fixtures/eval/extraction/intelligence/manifest.v1.json`
- Routing truth sidecar: `test/fixtures/eval/extraction/intelligence/routing-truth.json`

Fixture identities

| Fixture | SHA-256 |
| --- | --- |
| `table-ruled-grid.pdf` | `f434b0be353c4e1aea0614393b90f7e4517d9d6d73c8815ff523bdc513ee6235` |
| `table-ruled-merged-negative.pdf` | `abca089a1f67c7d0cfbd6c5345f8a80e006452dddec630295ee356bab59f6d70` |
| `text-integrity-pua.pdf` | `f67dda2257e91f221714bf019188def5559b5bf7ada4822bc53c7af241b63085` |
| `routing-mixed.pdf` | `d9afa9f168e825f0f3cfcfff9afb5f73a468c8c214450f7330aa5da3a4b96086` |
| `compact-toc.pdf` | `a1a136035987782a7c47886694649672b336ddeb8e1095bd153d9665fbcef936` |

Baseline observations against current code

- `table-ruled-grid`: `convert_pdf_to_markdown` returns `partial`, leaves the
  four rows as reading-order text, and emits `TABLE_TOPOLOGY_UNKNOWN` plus
  `VECTOR_CONTENT_NOT_INTERPRETED`; no Markdown table is emitted.
- `table-ruled-merged-negative`: the two-column merged-span fixture remains
  plain reading-order text with `TABLE_TOPOLOGY_UNKNOWN` plus
  `VECTOR_CONTENT_NOT_INTERPRETED`; no table is reconstructed. This is the
  permanent fail-closed negative guard.
- `text-integrity-pua`: `read_pdf_layout` and `convert_pdf_to_markdown` both
  report `complete`; the PUA/U+FFFD-dense text is emitted unchanged, with no
  integrity field or conversion gap.
- `routing-mixed`: the exact future routing truth is `pages_needing_vision: [2]`
  with reason `no_text_layer`. Current `read_pdf_layout` and
  `convert_pdf_to_markdown` expose no `pages_needing_vision` field; conversion
  of both pages is `partial` with the existing image/OCR gaps on page 2.
- `compact-toc`: default conversion is `complete` and preserves all eleven
  dot-leader lines, including the exactly-three-dot `Preface ... ii` case, and
  both isolated page-number lines verbatim. No normalization-count field is
  present.

Verification commands

```sh
node scripts/eval-generate-extraction-intelligence-fixtures.mjs
npm test -- test/extraction-intelligence-baseline.test.js
npm test -- test/eval/extraction-phase0.test.js
npm test
```

The baseline test regenerates into two independent temporary directories and
compares each output byte-for-byte with the committed fixture and with the
second regeneration.
