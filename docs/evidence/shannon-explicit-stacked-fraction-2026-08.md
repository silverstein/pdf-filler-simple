# Shannon explicit stacked fraction — 2026-08

## Outcome

The stacked draft renders one explicitly barred, single-digit stacked fraction
inside Shannon's prose as `3 1/3`. The preceding output placed it in source
reading order as:

```text
a decimal digit is about 31
3
bits.
```

The new output is:

```text
a decimal digit is about 3 1/3 bits.
```

This improves sampled paragraph continuity from 2/4 phrases to 3/4. It is a
bounded interpretation of explicit source text and one source-painted bar, not
general fraction or formula reconstruction.

## Exact source evidence

The pinned source is Shannon's 55-page paper with SHA-256
`6e4e3411984f3edf99dbfe8b941cb5e8a321379ff0cae6ae5c1f592ad8882ca8`.
On page 2, Extraction IR 1.3.0 with PDF.js 5.4.624 retains:

| Source item | Text | x | y | width | height |
| --- | --- | ---: | ---: | ---: | ---: |
| body prose | `a decimal digit is about 3` | 91.92 | 272.74 | 103.18 | 10 |
| numerator | `1` | 196.32 | 270.86 | 3.70 | 7.40 |
| denominator | `3` | 196.32 | 278.30 | 3.70 | 7.40 |
| continuation | `bits. A digit wheel…` | 204.12 | 272.74 | 315.39 | 10 |

The numerator and denominator have the same font, x coordinate, width, and
height. They are 74% of the body-text height. The body items have the same font,
height, and baseline. The raw source sequence contains explicit whitespace
immediately before and after the stack.

The page's complete, untruncated painted-rectangle evidence contains exactly
one item: a solid-color image mask at x 196.308, y 277.992, width 3.72, and
height 0.48. Its horizontal center differs from the digit centers by about
0.002 points, and it lies at the numerator/denominator boundary. This is the
printed fraction bar.

## Fail-closed rule

The renderer changes output only when all of these conditions agree:

- exactly two host-line source items, one denominator item, and one continuing
  prose item occur in the required consecutive raw-source order;
- explicit source whitespace surrounds the stack;
- the smaller numerator and denominator are one ASCII digit each, exactly
  aligned, identically sized, and use the same font as both prose sides;
- body prose on the left contains at least five words and ends in a full-size
  digit; continuing prose contains at least five words and begins lowercase;
- all text is axis-aligned, left-to-right, same-column safe text outside
  headings, links, lists, and table regions;
- both prose gaps are positive and tightly bounded; and
- complete rectangle evidence contains exactly one thin solid-mask bar whose
  width and center match both digits and whose vertical position meets their
  boundary.

Missing, shifted, thick, or competing bars abstain. So do missing source
whitespace, changed prose shape, changed prose font, and an unbarred stacked
script. The accepted projection does not mutate the Extraction IR.

## Deterministic Shannon proof

- Fresh report directory:
  `/Users/silverbook/Sites/pdf-tools-extraction-sidecars/shannon-simple-fraction-final3-20260804-0924`.
- Report SHA-256:
  `e5339902bd55b9aabe2a1a2f60ccc76844323f0db83935bd641e0f43fddb8ccd`.
- PDF Tools Markdown SHA-256 in all three repetitions:
  `bb3f7586a3268fc2ed5a1de2d57bad3ca63321720f1af4d5e62dbe46716e187e`.
- Markdown size: 181,478 bytes.
- Median elapsed time: 3,954.919 ms.
- Median maximum RSS: 330,596,352 bytes.
- Sampled scores: headings 14/14, reading order 24/24 across 6/6 groups,
  paragraphs 3/4, equations 4/4, footnotes 4/4, table topology present, and
  omissions/duplication 7/7.

All three outputs are byte-identical. Compared with PR #63, paper content
changes only at the one fraction region. The renderer limitation text also
changes to disclose the new narrow interpretation and appears once per
ten-page conversion chunk.

## Verification state

- Evaluated implementation/evidence commit:
  `a6a2f79aaeb292d9dc8f65433feaf00ca7ea3705`.
- Focused renderer, contract, bakeoff, conversion, and extraction-oracle bank:
  134 passed, 6 intentionally skipped, zero failed.
- Renderer-only suite: 46/46 passed, including eight negative fraction pages.
- Native macOS/Node safety suite: 62 passed, 9 intentionally skipped, zero
  failed.
- Transactional share contract: 40 tools, 14 prompts, 112 SBOM components,
  native raster image; SHA-256
  `33ea0d18a9bff9eb11aa0109a5c63b2169f92e6de30572c496a795091a449326`.
- Complete clean repository suite: 1,889 passed, 80 intentionally skipped,
  zero failed.
- Reproducible packed MCPB:
  `/Users/silverbook/Sites/pdf-tools-extraction-sidecars/pdf-toolkit-fraction-a6a2f79.mcpb`;
  73,645,475 bytes, 3,000 files, SHA-256
  `fa4431ca17894413484a5e940283b99ec6458e35031dee083a96b6fb4898287d`.
  Two clean isolated builds were byte-identical; peak isolated-build RSS was
  856,176 KiB.
- Packed-copy smoke on macOS arm64: 40 tools, 14 prompts, canonical resources,
  PDF-lib mutation, and native raster rendering passed.

The first complete clean attempt had one timing-sensitive macOS Docling
process-supervision assertion fail after 1,888 passes. That unrelated check
passed immediately in isolation, and the second complete clean run passed with
the counts above. No PDF conversion test failed in either run.

## Claim boundary

This work is stacked above draft PR #63. It is packed for review, but is not
merged, released, installed, or shipped. It does not prove general fraction
reconstruction, equation reconstruction, mathematical layout fidelity, OCR,
hidden/clipped text fidelity, cross-platform behavior, release readiness, or
that Kepano's complete issue is solved.

The remaining paragraph miss is an ordinary literal line-end hyphen in
`ap-` / `proximately`. The same paper contains intentional compounds with
indistinguishable geometry, so the renderer continues to preserve that source
hyphen rather than guessing.
