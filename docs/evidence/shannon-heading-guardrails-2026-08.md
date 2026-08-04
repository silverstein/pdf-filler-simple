# Shannon heading guardrails — 2026-08

## Outcome

PDF Tools no longer promotes unreadable glyphs, lone characters, or obvious
equation fragments into Markdown headings. Their source text remains present as
escaped body text. The renderer identity is now
`pdf-tools.layout-markdown-renderer` version `1.3.0`.

On the same hash-bound 55-page Shannon document used by the preceding bakeoff,
malformed or fragmentary false headings fell from 227 to 0. The sampled reading
order, paragraph continuity, equation, footnote, table, omission, and evidence
results did not regress.

This is a precision fix, not a complete hierarchy fix. PDF Tools still finds
0 of the 14 sampled intended major headings. Recovering real headings without
promoting equations is separate follow-up work.

## Clean run

- Evaluated commit: `c96ecbd064ff815c88eae5acb0a78f68e428fa23`
- Source PDF SHA-256:
  `6e4e3411984f3edf99dbfe8b941cb5e8a321379ff0cae6ae5c1f592ad8882ca8`
- Baseline report SHA-256:
  `0c4b7caa8bbb7b60ef88fb644dae6a563c0dee3b51a0a47e14331de831b26d01`
- Guardrail report SHA-256:
  `04d1af01c27a6f76d4db3fdcb6c21f3614598aed590db32bccf3abcab8bff2c1`
- Repetitions: three fresh processes per candidate
- PDF Tools Markdown deterministic across repetitions: `true`
- Median PDF Tools elapsed time: 3502.845 ms
- Median PDF Tools maximum RSS: 317,407,232 bytes

## Metric comparison

| Sampled PDF Tools metric | Before | After |
| --- | ---: | ---: |
| Malformed or fragmentary false headings | 227 | 0 |
| Intended headings found | 0 / 14 | 0 / 14 |
| Ordered anchors retained | 22 / 24 | 22 / 24 |
| Complete ordered-anchor groups | 4 / 6 | 4 / 6 |
| Paragraph-continuity anchors | 1 / 4 | 1 / 4 |
| Equation anchors | 2 / 4 | 2 / 4 |
| Footnote anchors | 4 / 4 | 4 / 4 |
| Sampled Table I topology | absent | absent |

The report remains a sampled adversarial evaluation, not a complete transcript
ground truth, public benchmark, release qualification, or claim that the
reported extraction problem is solved.
