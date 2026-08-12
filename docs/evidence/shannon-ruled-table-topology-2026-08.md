# Shannon ruled-table topology — 2026-08

## Outcome

PDF Tools now reconstructs Shannon's Table I as one four-column Markdown table
with its header and five data rows. The Extraction IR retains a bounded set of
axis-aligned solid-mask rectangles with their exact source operation,
transformation, and page geometry. The Markdown renderer accepts those neutral
paint observations only when they form one unambiguous complete closed grid,
every retained text item fits exactly one cell, an isolated `TABLE I` caption
is directly above it, and the shallow first row supplies independent uppercase
header evidence.

The renderer fails closed when the observed rules do not form one unambiguous
complete grid, when aligned partial dividers evidence merged or spanning cells,
or when text crosses the inferred cells. It also refuses multiple candidate
grids, absent captions, weak headers, tiny bands, and overlarge grids. It does
not interpret stroked paths, cell artwork, formulas, or mini-graphs.
Several mathematical symbols within the Shannon table therefore remain
damaged even though their row and column membership is now useful. The
Markdown renderer identity is `pdf-tools.layout-markdown-renderer` version
`1.7.0`; the Extraction IR identity is `pdf-tools.extraction-ir` version
`1.2.0`.

## Clean run

- Evaluated commit: `0274bd84ca950f83d7fbd7b620527b7d4345b39d`
- Source PDF SHA-256:
  `6e4e3411984f3edf99dbfe8b941cb5e8a321379ff0cae6ae5c1f592ad8882ca8`
- Previous math-spacing report SHA-256:
  `2074f1b1a0d0856c523d827b9fb27e387623713db0273f1c37d30fab24c1cf3e`
- Ruled-table report SHA-256:
  `ed5a8d7c2ad7bdde748ae15fb755056bae14bd9ab27c048fd912de637566e8e6`
- Private report directory:
  `/Users/silverbook/Sites/pdf-tools-extraction-sidecars/shannon-table-topology-hardened-final-20260803-clean-0274bd8`
- Repetitions: three fresh processes per candidate
- PDF Tools Markdown deterministic across repetitions: `true`
- PDF Tools output SHA-256 for all three repetitions:
  `7405d8516b47ed0ec4bef4b63aabc58e973b2d1b475e4dff542d2d06d57d497f`
- Median PDF Tools elapsed time: 3465.582 ms
- Median PDF Tools maximum RSS: 310,116,352 bytes

## Metric comparison

| Sampled PDF Tools metric | Before | After |
| --- | ---: | ---: |
| Qualifying Table I topology | 0 | 1 |
| Markdown tables | 0 | 1 |
| Table I data rows | 0 | 5 |
| Intended headings found | 14 / 14 | 14 / 14 |
| Malformed or fragmentary false headings | 0 | 0 |
| Equation-like false headings | 0 | 0 |
| Ordered anchors retained | 23 / 24 | 23 / 24 |
| Complete ordered-anchor groups | 5 / 6 | 5 / 6 |
| Paragraph-continuity anchors | 2 / 4 | 2 / 4 |
| Page-local equation anchors | 4 / 4 | 4 / 4 |
| Footnote anchors | 4 / 4 | 4 / 4 |

The run emitted no other Markdown tables in the 55-page paper. The automatic
judge was corrected to use the source-faithful four header phrases and to
treat safe `<br>` line breaks as spaces while scoring the header. The original
PDF page, not the candidate output, determined those phrases.

Independent review found and the final commit closes three pre-publication
issues: aligned partial dividers can no longer flatten a merged or spanning
table into a coarser ordinary table; painted transforms retain their full
finite precision before large `UserUnit` scaling; and ruled-table work is
bounded before cell allocation and uses one indexed pass over retained lines.
Adversarial tests also cover multiple grids and interleaved source item order.
The final focused run passed 162 tests, the native platform run passed 62 with
9 intentional skips, the phase-one layout oracle regenerated exactly, and the
reproducible share-package contract passed.

This is a sampled adversarial evaluation, not complete transcript ground truth,
public benchmark, packed-MCPB qualification, or a claim that mathematical
notation inside ruled cells is reconstructed faithfully.
