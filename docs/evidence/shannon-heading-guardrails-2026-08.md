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

- Evaluated commit: `e3f5615`
- Source PDF SHA-256:
  `6e4e3411984f3edf99dbfe8b941cb5e8a321379ff0cae6ae5c1f592ad8882ca8`
- Baseline report SHA-256:
  `a5d468f897dbbe9931b5b4b4e3fa6da17cd1b99bede5111fd7888e3a9a1a5a38`
- Guardrail report SHA-256:
  `4489c23f5c19d17e93f8a4d689cc6106e26390082b945fb7b2cebb42ea2a03fd`
- Repetitions: three fresh processes per candidate
- PDF Tools Markdown deterministic across repetitions: `true`
- Median PDF Tools elapsed time: 3415.627 ms
- Median PDF Tools maximum RSS: 284,229,632 bytes

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
