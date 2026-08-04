# Shannon math-operator spacing — 2026-08

## Outcome

PDF Tools now restores a missing visible space after a separate source text
item that is exactly the mathematical operator `log`, but only in a short,
compact left-to-right math run. The following item must be a single-letter
variable from a different embedded-font resource on the same baseline,
separated by a small positive gap, with independent local math-layout evidence.
The original Extraction IR remains unchanged. The Markdown renderer identity is
now `pdf-tools.layout-markdown-renderer` version `1.6.0`.

On the hash-bound 55-page Shannon document, the sampled page-local equation
anchors improved from 2 of 4 to 4 of 4. All three PDF Tools repetitions were
byte-identical. The source-text diff contained 19 restored `log` operator
boundaries across 18 changed lines and no other source-text changes; the new
limitation also appears in each bounded output chunk. Sampled headings, reading
order, paragraph continuity, footnotes, table topology, omission/duplication,
and evidence did not regress.

The 4-of-4 sample result does **not** mean equation extraction is solved. The
paper still contains damaged or flattened arrows, minus signs, subscripts,
summation limits, and fractions. The renderer does not guess replacements for
those structures. In particular, it does not turn vertically stacked digits
into a fraction because the current IR does not locate the printed fraction bar
and cannot reliably distinguish that stack from scripts, footnotes, charts, or
table cells.

## Clean run

- Evaluated commit: `b8b301ce6c2eb87d1a55aeafffff9323e25d3eba`
- Source PDF SHA-256:
  `6e4e3411984f3edf99dbfe8b941cb5e8a321379ff0cae6ae5c1f592ad8882ca8`
- Previous paragraph-continuity report SHA-256:
  `0dcc8284d18b960b1a63bdeba6f91f4cf28ae7ab5aad0b20f9b623f34961fc06`
- Math-spacing report SHA-256:
  `6e81ae082de64650595c70b659bb82b79e04400ecc9506352d92766ae46ddb39`
- Private report directory:
  `/Users/silverbook/Sites/pdf-tools-extraction-sidecars/shannon-math-spacing-final-review-20260803-clean-b8b301c`
- Repetitions: three fresh processes per candidate
- PDF Tools Markdown deterministic across repetitions: `true`
- Median PDF Tools elapsed time: 3533.064 ms
- Median PDF Tools maximum RSS: 312,033,280 bytes

## Metric comparison

| Sampled PDF Tools metric | Before | After |
| --- | ---: | ---: |
| Page-local equation anchors | 2 / 4 | 4 / 4 |
| Intended headings found | 14 / 14 | 14 / 14 |
| Malformed or fragmentary false headings | 0 | 0 |
| Equation-like false headings | 0 | 0 |
| Ordered anchors retained | 23 / 24 | 23 / 24 |
| Complete ordered-anchor groups | 5 / 6 | 5 / 6 |
| Paragraph-continuity anchors | 2 / 4 | 2 / 4 |
| Footnote anchors | 4 / 4 | 4 / 4 |
| Sampled Table I topology | absent | absent |

This is a sampled adversarial evaluation, not a complete transcript ground
truth, public benchmark, release qualification, or claim that general
mathematical notation is reconstructed faithfully.
