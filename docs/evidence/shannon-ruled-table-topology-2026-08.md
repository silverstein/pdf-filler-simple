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

The renderer fails closed for missing rules, crossing text, multiple candidate
grids, absent captions, weak headers, tiny bands, and merged or spanning cells.
It does not interpret stroked paths, cell artwork, formulas, or mini-graphs.
Several mathematical symbols within the Shannon table therefore remain
damaged even though their row and column membership is now useful. The
Markdown renderer identity is `pdf-tools.layout-markdown-renderer` version
`1.7.0`; the Extraction IR identity is `pdf-tools.extraction-ir` version
`1.2.0`.

## Clean run

- Evaluated commit: `0511ab213137a669248ec611d4a4a4bb256717b5`
- Source PDF SHA-256:
  `6e4e3411984f3edf99dbfe8b941cb5e8a321379ff0cae6ae5c1f592ad8882ca8`
- Previous math-spacing report SHA-256:
  `2074f1b1a0d0856c523d827b9fb27e387623713db0273f1c37d30fab24c1cf3e`
- Ruled-table report SHA-256:
  `d9aaf1e482d3fdf81b4486797875e2397ce5e9e99e4b464d9c938a1b6cfd6a56`
- Private report directory:
  `/Users/silverbook/Sites/pdf-tools-extraction-sidecars/shannon-table-topology-final-review-20260803-clean-0511ab2`
- Repetitions: three fresh processes per candidate
- PDF Tools Markdown deterministic across repetitions: `true`
- PDF Tools output SHA-256 for all three repetitions:
  `3237ca7d3734b84ec42dc2e237a2d2e03d28715eeef7814747fd653996ba843d`
- Median PDF Tools elapsed time: 3441.557 ms
- Median PDF Tools maximum RSS: 316,440,576 bytes

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

This is a sampled adversarial evaluation, not complete transcript ground truth,
public benchmark, packed-MCPB qualification, or a claim that mathematical
notation inside ruled cells is reconstructed faithfully.
