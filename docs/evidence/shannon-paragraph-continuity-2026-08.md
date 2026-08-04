# Shannon paragraph continuity — 2026-08

## Outcome

PDF Tools now performs one bounded, source-backed paragraph-flow repair: a
large initial capital can join an overlapping uppercase word remainder when it
opens a sufficiently long left-to-right paragraph after a structural boundary.

Headings, lists, links, tables, different columns, and ambiguous geometry remain
separate. Ordinary printed line-end hyphens are deliberately preserved because
the source geometry cannot distinguish a split word from an intentional compound.
The original lines remain available in the Extraction IR. The Markdown renderer
identity is now `pdf-tools.layout-markdown-renderer` version `1.5.0`.

On the hash-bound 55-page Shannon document, sampled paragraph-continuity
recovery improved from 1 of 4 anchors to 2 of 4. Sampled ordered anchors also
improved from 22 of 24 to 23 of 24. Heading recovery remained 14 of 14 with
zero malformed, fragmentary, or equation-like false headings. The sampled
equation, footnote, table, omission, and evidence results did not regress.

The remaining continuity misses are an ordinary printed hyphen whose intended
meaning is ambiguous and a vertically stacked printed fraction. Neither is
silently rewritten; the fraction remains for a separate math-layout evaluation.

## Clean run

- Evaluated commit: `56f45fac4fb300339e8831c8a353ea9d6903ab9b`
- Source PDF SHA-256:
  `6e4e3411984f3edf99dbfe8b941cb5e8a321379ff0cae6ae5c1f592ad8882ca8`
- Real-heading report SHA-256:
  `63efa43f8cb6ba2f0198c74b00e4b21a34622fc0cb814b92f86c8e0306653a53`
- Paragraph-continuity report SHA-256:
  `0dcc8284d18b960b1a63bdeba6f91f4cf28ae7ab5aad0b20f9b623f34961fc06`
- Repetitions: three fresh processes per candidate
- PDF Tools Markdown deterministic across repetitions: `true`
- Median PDF Tools elapsed time: 3699.092 ms
- Median PDF Tools maximum RSS: 291,241,984 bytes

## Metric comparison

| Sampled PDF Tools metric | Before | After |
| --- | ---: | ---: |
| Paragraph-continuity anchors | 1 / 4 | 2 / 4 |
| Ordered anchors retained | 22 / 24 | 23 / 24 |
| Complete ordered-anchor groups | 4 / 6 | 5 / 6 |
| Intended headings found | 14 / 14 | 14 / 14 |
| Malformed or fragmentary false headings | 0 | 0 |
| Equation-like false headings | 0 | 0 |
| Page-local equation anchors | 2 / 4 | 2 / 4 |
| Footnote anchors | 4 / 4 | 4 / 4 |
| Sampled Table I topology | absent | absent |

The rules use no dictionary, model, Shannon-specific replacement, external
dependency, hidden OCR, or silent hard-hyphen deletion. This remains a sampled
adversarial evaluation rather than a complete transcript ground truth, public
benchmark, or release claim.
