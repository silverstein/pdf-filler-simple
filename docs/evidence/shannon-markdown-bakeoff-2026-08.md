# Shannon Markdown bakeoff evidence — 2026-08

## Outcome

Do not add `pdf-inspector` as a product dependency and do not claim that PDF
Tools has solved the reported Shannon extraction failures.

The exercise did find and fix a PDF Tools correctness bug: a source-order line
could pass incremental baseline checks and then fail the final Extraction IR
invariant. The regression is covered by a synthetic mixed-font-size case. At
the clean evaluated commit, PDF Tools processes all 55 pages deterministically
instead of aborting on page 3.

The remaining quality tradeoffs are material. PDF Tools retains stronger page,
gap, and canonical-coordinate evidence and more sampled reading-order anchors.
The pinned `pdf-inspector` candidate is much faster and finds nearly all sampled
major headings, but it turns many equations into headings and provides none of
PDF Tools' evidence surfaces. Neither candidate reconstructs the sampled table,
and both miss the same sampled paragraph and equation coverage.

## Bound run

- PDF Tools commit: `60e13bcb78d74126ef8310f75498e6b02fac601f`
- PDF Tools runtime source set SHA-256:
  `f0d9aad0163a2b1a055469f8c34814ea81b3b7a0def6f4a52e321ed2bd1a166a`
- Runtime files clean at execution: `true`
- Shannon source SHA-256:
  `6e4e3411984f3edf99dbfe8b941cb5e8a321379ff0cae6ae5c1f592ad8882ca8`
- Manifest SHA-256:
  `8b732875a8073f306cf67bc8532f7a4bca54cba968588d2977f3e5aae29f6fbf`
- `pdf-inspector` revision:
  `1c32e4bd691bde83778ffef235019c8feac0c0c5`
- Generated `Cargo.lock` SHA-256:
  `d976c94ada1b91ab3c2fd65f3ba24b93854d4622ad59760891be4ce26becd982`
- `pdf2md` binary SHA-256:
  `62a670b0e9bc5d47ea8f4e626540e83740b92a95d0ce0baad4426f2a5bc11cf8`
- Private report SHA-256:
  `a5d468f897dbbe9931b5b4b4e3fa6da17cd1b99bede5111fd7888e3a9a1a5a38`
- Host: macOS arm64, Node `v26.3.1`
- Repetitions: three fresh processes per candidate; Markdown was byte-identical
  within each candidate.

The source PDF, candidate checkout, generated Markdown, and full report remain
outside the repository. The source manifest declares the paper
`external_only`; no source or extracted paper text is committed here.

## Results

| Metric | PDF Tools | `pdf-inspector` |
| --- | ---: | ---: |
| Median elapsed time | 3329.448 ms | 94.342 ms |
| Median maximum RSS | 279,592,960 bytes | 26,804,224 bytes |
| Markdown bytes | 169,490 | 156,449 |
| Expected headings found | 0 / 14 | 13 / 14 |
| Wrong-level expected headings | 0 | 7 |
| Equation-like false headings | 0 | 28 |
| Malformed or fragmentary false headings | 227 | 0 |
| Complete ordered-anchor groups | 4 / 6 | 1 / 6 |
| Ordered anchors retained | 22 / 24 | 19 / 24 |
| Paragraph-continuity anchors | 1 / 4 | 1 / 4 |
| Equation anchors | 2 / 4 | 2 / 4 |
| Footnote anchors | 4 / 4 | 4 / 4 |
| Sampled Table I topology | absent | absent |
| Page identity evidence | present | absent |
| Typed coverage gaps | present | absent |
| Canonical coordinates | present | absent |

PDF Tools reports every ten-page chunk as `partial`, with 71 typed gaps across
the document. The `pdf-inspector` output contains 40 Markdown-shaped tables,
but none satisfies the sampled Table I topology contract. A Markdown table
count is therefore not table-reconstruction credit.

## Decision

Keep `pdf-inspector` evaluation-only. Its speed and heading heuristics are useful
design signals, especially as inputs to the existing extraction-intelligence
work, but the current output is not a fidelity reference and does not justify a
dependency or product pivot.

The next product work should be local and typed: eliminate replacement-glyph
heading promotion, recover major headings without promoting equations, improve
drop-cap and dehyphenation continuity, and add a defensible table-topology lane.
Rerun this exact harness after those changes. Add a stronger layout-reference
candidate only through a separate Shannon-specific, hash-bound handoff.

This is a sampled adversarial evaluation, not a complete 55-page transcript
ground truth, public benchmark, packed MCPB qualification, or comparative
marketing claim.
