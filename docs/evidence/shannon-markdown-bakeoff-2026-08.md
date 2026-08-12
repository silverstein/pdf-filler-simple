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
gap, and canonical-coordinate evidence, more sampled reading-order anchors, and
one more page-local sampled equation. The pinned `pdf-inspector` candidate is
much faster and finds nearly all sampled major headings, but it turns many
equations into headings and provides none of PDF Tools' evidence surfaces.
Neither candidate reconstructs the sampled table, and both miss the same
sampled paragraph coverage.

## Bound run

- PDF Tools commit: `277f8a99229e54774782bf1544ab871f6a540106`
- PDF Tools runtime source set SHA-256:
  `f0d9aad0163a2b1a055469f8c34814ea81b3b7a0def6f4a52e321ed2bd1a166a`
- Runtime files clean at execution: `true`
- Shannon source SHA-256:
  `6e4e3411984f3edf99dbfe8b941cb5e8a321379ff0cae6ae5c1f592ad8882ca8`
- Manifest SHA-256:
  `0b01d892bc0e33d8ff5d9425c874cab695ac0c2c3722641d808b2edda828fff9`
- `pdf-inspector` revision:
  `1c32e4bd691bde83778ffef235019c8feac0c0c5`
- Generated `Cargo.lock` SHA-256:
  `d976c94ada1b91ab3c2fd65f3ba24b93854d4622ad59760891be4ce26becd982`
- `pdf2md` binary SHA-256:
  `62a670b0e9bc5d47ea8f4e626540e83740b92a95d0ce0baad4426f2a5bc11cf8`
- Private report SHA-256:
  `0c4b7caa8bbb7b60ef88fb644dae6a563c0dee3b51a0a47e14331de831b26d01`
- Host: macOS arm64, Node `v26.3.1`
- Repetitions: three fresh processes per candidate; Markdown was byte-identical
  within each candidate.

The source PDF, candidate checkout, generated Markdown, and full report remain
outside the repository. Candidate execution uses private verified snapshots of
the source PDF and executable, and revalidates the PDF Tools runtime files after
each repetition. The source manifest declares the paper `external_only`; no
source or extracted paper text is committed here.

## Results

| Metric | PDF Tools | `pdf-inspector` |
| --- | ---: | ---: |
| Median elapsed time | 3426.416 ms | 105.85 ms |
| Median maximum RSS | 280,117,248 bytes | 26,853,376 bytes |
| Markdown bytes | 169,490 | 156,449 |
| Expected headings found | 0 / 14 | 13 / 14 |
| Wrong-level expected headings | 0 | 7 |
| Equation-like false headings | 0 | 28 |
| Malformed or fragmentary false headings | 227 | 0 |
| Complete ordered-anchor groups | 4 / 6 | 1 / 6 |
| Ordered anchors retained | 22 / 24 | 19 / 24 |
| Paragraph-continuity anchors | 1 / 4 | 1 / 4 |
| Page-local equation anchors | 2 / 4 | 1 / 4 |
| Footnote anchors | 4 / 4 | 4 / 4 |
| Sampled Table I topology | absent | absent |
| Page identity evidence | present | absent |
| Typed coverage gaps | present | absent |
| Canonical coordinates | present | absent |

PDF Tools reports every ten-page chunk as `partial`, with 71 typed gaps across
the document. The `pdf-inspector` output contains 40 Markdown-shaped tables,
but none has the required terms in its actual header row and satisfies the
sampled Table I topology contract. A Markdown table count is therefore not
table-reconstruction credit.

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
