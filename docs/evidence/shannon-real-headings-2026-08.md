# Shannon real-heading recovery — 2026-08

## Outcome

PDF Tools now recognizes conservative, source-backed document structure for at
most one strongest first-page title, `INTRODUCTION`, numbered or Roman-numeral
`APPENDIX` markers, and uppercase `PART` markers with titles. The renderer identity is now
`pdf-tools.layout-markdown-renderer` version `1.4.0`.

On the same hash-bound 55-page Shannon document used by the preceding runs,
expected heading recovery improved from 0 of 14 to 14 of 14. All headings used
the expected level. Malformed, fragmentary, and equation-like false headings
remained at zero. The sampled reading-order, continuity, equation, footnote,
table, omission, and evidence results did not regress.

The rules are document-generic and source-preserving. They do not contain
Shannon-specific title text, repair extracted text, call a model, or add an
external dependency.

## Clean run

- Evaluated commit: `9b56f0b`
- Source PDF SHA-256:
  `6e4e3411984f3edf99dbfe8b941cb5e8a321379ff0cae6ae5c1f592ad8882ca8`
- Heading-guardrail report SHA-256:
  `4489c23f5c19d17e93f8a4d689cc6106e26390082b945fb7b2cebb42ea2a03fd`
- Real-heading report SHA-256:
  `4a6bdad3000026603f47cb6c1146cde0481d572fc950259957d46d8cef049a68`
- Repetitions: three fresh processes per candidate
- PDF Tools Markdown deterministic across repetitions: `true`
- Median PDF Tools elapsed time: 4426.301 ms
- Median PDF Tools maximum RSS: 295,993,344 bytes

## Metric comparison

| Sampled PDF Tools metric | Before | After |
| --- | ---: | ---: |
| Intended headings found | 0 / 14 | 14 / 14 |
| Wrong-level intended headings | 0 | 0 |
| Malformed or fragmentary false headings | 0 | 0 |
| Equation-like false headings | 0 | 0 |
| Ordered anchors retained | 22 / 24 | 22 / 24 |
| Complete ordered-anchor groups | 4 / 6 | 4 / 6 |
| Paragraph-continuity anchors | 1 / 4 | 1 / 4 |
| Equation anchors | 2 / 4 | 2 / 4 |
| Footnote anchors | 4 / 4 | 4 / 4 |
| Sampled Table I topology | absent | absent |

This is a sampled adversarial evaluation, not a complete transcript ground
truth, public benchmark, release qualification, or claim that all PDF heading
styles are recognized. Paragraph continuity, equation fidelity, and table
topology remain separate product targets.
