# Shannon paragraph continuity — 2026-08

## Outcome

PDF Tools now performs two bounded, source-backed paragraph-flow repairs:

- a large initial capital can join an overlapping uppercase word remainder;
- a lowercase word split across consecutive same-column body lines by a
  line-end hyphen can be dehyphenated.

Headings, lists, links, tables, different columns, and ambiguous geometry remain
separate. The original lines remain available in the Extraction IR. The
Markdown renderer identity is now `pdf-tools.layout-markdown-renderer` version
`1.5.0`.

On the hash-bound 55-page Shannon document, sampled paragraph-continuity
recovery improved from 1 of 4 anchors to 3 of 4. Sampled ordered anchors also
improved from 22 of 24 to 23 of 24. Heading recovery remained 14 of 14 with
zero malformed, fragmentary, or equation-like false headings. The sampled
equation, footnote, table, omission, and evidence results did not regress.

The remaining continuity miss is a vertically stacked printed fraction. It is
not treated as ordinary paragraph joining and remains for a separate math-layout
evaluation.

## Clean run

- Evaluated commit: `060979c`
- Source PDF SHA-256:
  `6e4e3411984f3edf99dbfe8b941cb5e8a321379ff0cae6ae5c1f592ad8882ca8`
- Real-heading report SHA-256:
  `dee4bc622597c6036a0293eed93094715f0af2bb26c74ee86fb1e6f15b5d7e63`
- Paragraph-continuity report SHA-256:
  `c521e6701cfb64a2758827a878b13457f86801a3fc02c23ce42254883e5aa5db`
- Repetitions: three fresh processes per candidate
- PDF Tools Markdown deterministic across repetitions: `true`
- Median PDF Tools elapsed time: 3727.857 ms
- Median PDF Tools maximum RSS: 294,158,336 bytes

## Metric comparison

| Sampled PDF Tools metric | Before | After |
| --- | ---: | ---: |
| Paragraph-continuity anchors | 1 / 4 | 3 / 4 |
| Ordered anchors retained | 22 / 24 | 23 / 24 |
| Complete ordered-anchor groups | 4 / 6 | 5 / 6 |
| Intended headings found | 14 / 14 | 14 / 14 |
| Malformed or fragmentary false headings | 0 | 0 |
| Equation-like false headings | 0 | 0 |
| Equation anchors | 2 / 4 | 2 / 4 |
| Footnote anchors | 4 / 4 | 4 / 4 |
| Sampled Table I topology | absent | absent |

The rules use no dictionary, model, Shannon-specific replacement, external
dependency, or hidden OCR. This remains a sampled adversarial evaluation rather
than a complete transcript ground truth, public benchmark, or release claim.
