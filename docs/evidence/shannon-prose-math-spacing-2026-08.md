# Shannon prose/math boundary spacing — 2026-08

## Outcome

The stacked draft restores two source-supported spaces where Shannon's prose
switches into a separately embedded single-letter mathematical variable:

- `storeN bits` becomes `store N bits`.
- `capacityC of a discrete channel` becomes `capacity C of a discrete channel`.

This improves the sampled reading-order score from 23/24 anchors across 5/6
complete groups to 24/24 across 6/6 complete groups. It does not reconstruct
equations or repair general word spacing.

The same draft also corrects the Shannon evaluator's `TABLE I` duplication
check. The standalone table label is counted once; the legitimate prose
reference `In Table I` is no longer misclassified as a second label. The
sampled omission-and-duplication score therefore moves from 6/7 to 7/7 without
changing the paper's table output.

## Narrow acceptance rule

A prose boundary is changed only when all of the following evidence agrees:

- multiword prose, a separate uppercase letter, and continuing prose share one
  left-to-right baseline;
- the letter uses a different source font resource and the continuing prose
  returns to the original prose resource;
- both boundary gaps are small and positive, with the continuation gap larger;
- the same letter and font resource occur in a nearby compact equation with a
  separate equals sign on the same page and column; and
- the line is outside links, headings, unsafe text, structural rewrites, and
  ambiguous table regions.

The nearby-equation search is limited to three rows and four line heights. Its
cells must be compact mathematical items (apart from `Lim`, `Max`, or `Min`).
An adversarial prose example using a different-font uppercase letter but no
qualifying nearby equation remains unchanged.

## Deterministic Shannon proof

- Source PDF SHA-256:
  `6e4e3411984f3edf99dbfe8b941cb5e8a321379ff0cae6ae5c1f592ad8882ca8`.
- Fresh three-process report directory:
  `/Users/silverbook/Sites/pdf-tools-extraction-sidecars/shannon-prose-math-spacing-final3-20260804-0845`.
- Report SHA-256:
  `6f9ec8aac28c9b25f181cbb91809e7ca300213be72fbb6fc16771ede94930572`.
- PDF Tools Markdown SHA-256 in all three repetitions:
  `5aefe08bd0228379f0dc8a23c57bbc906899a1995baadd92c67a5aae0065e602`.
- Markdown size: 179,845 bytes.
- Median elapsed time: 4,047.805 ms.
- Median maximum RSS: 326,385,664 bytes.
- Sampled scores: headings 14/14, reading order 24/24 across 6/6 groups,
  paragraphs 2/4, equations 4/4, footnotes 4/4, table topology present, and
  omissions/duplication 7/7.

All three outputs are byte-identical. Compared with the preceding PR #62
output, the paper content changes only at the two prose/math boundaries listed
above. The renderer limitation text also changes to describe the new bounded
rule and appears once per ten-page conversion chunk.

## Verification state

- Evaluated implementation/evidence commit:
  `7208abd739f394493278996f57d514fa6f4fda58`.
- Focused Markdown conversion tests: 45/45 passed.
- Focused renderer, contract, output-schema, bakeoff, and conversion suites:
  122 passed, 6 intentionally skipped, zero failed.
- Extraction-oracle verification: 20/20 passed. Regeneration changed only the
  expected renderer/schema source fingerprints, not occurrence truth data.
- Source-identity classification check: 18/18 passed after registering the new
  installed-Shannon checker's reviewed dynamic module loads.
- Native macOS/Node safety suite: 62 passed, 9 intentionally skipped, zero
  failed.
- Transactional share contract: 40 tools, 14 prompts, 112 SBOM components,
  native raster image; SHA-256
  `63ca160a177f5f9b22db6f057714ed0f1a83968d26f41a05ac994e720d0ea80a`.
- Complete repository suite from the committed clean draft snapshot: 1,888
  passed, 80 intentionally skipped, zero failed.
- Reproducible MCPB: two isolated builds were byte-identical; 3,000 files,
  73,643,660 bytes; SHA-256
  `23ba42f4c9f9c2949021c5b098748cd54e0f46145b6346d6478c9fe0dd118f18`.
- Packed MCPB smoke passed on macOS arm64 with all 40 tools, 14 prompts,
  canonical resources, one verified PDF-lib mutation, and a native raster
  image.

## Claim boundary

This is a draft stacked above PR #62. It is not merged, released, or installed.
The prior PR #62 installed-copy proof applies only to its exact artifact and
must not be silently transferred to the new packed PR #63 artifact.

The result does not prove general formula reconstruction, mathematical layout
fidelity, OCR, general prose spacing repair, cross-platform behavior, release
readiness, or that Kepano's complete issue is solved. Paragraph continuity
remains 2/4, and the known replacement characters and explicit extraction gaps
remain visible.
