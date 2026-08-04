# Shannon primary Type-3 glyph batch — 2026-08

## Outcome

PDF Tools now recovers 1,021 additional exact characters from nine repeatedly
used legacy Computer Modern Type-3 glyph groups in Shannon's 55-page paper.
Together with the preceding qualified batch, the tested draft production path
recovers 1,052 exact characters from 13 registered groups. PR #62 remains an
unmerged draft; this is verified implementation behavior, not a shipped claim.

This remains a fail-closed character recovery. A replacement is accepted only
when the raw PDF font link, official Computer Modern character position, target
glyph digest, two witness glyph digests, font metrics, and complete page token
sequence agree. Missing, ambiguous, or altered evidence is left unchanged.

## Exact new batch

Ranges below are inclusive. The target digest identifies the reviewed custom-
drawn glyph program; every group also has two independently matched witness
digests in `server/layout-extraction.js`.

| Character | Count | Target digest | Shannon pages |
| --- | ---: | --- | --- |
| period (`.`) | 345 | `2df559091df37cc5da5c1ce3e05eebc1075c4c041b83d96a1904d2c2f21edab0` | 1, 3-4, 6-14, 16-21, 24-32, 34-55 |
| comma (`,`) | 315 | `42b5ebf435945b75e1dc1bc271bfbb4aa2dc02b8adc93cd26b4bb64dec9fde8a` | 1-6, 8-12, 14-15, 18-19, 21, 25-26, 28-29, 31-33, 35-44, 46, 48-52, 54-55 |
| minus (`−`) | 216 | `fb1f6bf10138511bcefade47467b3e2f9ae691ab3dab097914be1f0f66305470` | 3-4, 9, 11-14, 16-31, 34-47, 49, 51, 53 |
| pi (`π`) | 55 | `780b04fa47830ca782211b86dbedfe0adec0445bdf94d538bfe7adde08ed9445` | 18, 32-34, 36-40, 43-47, 51, 53 |
| rho (`ρ`) | 27 | `1500df39391626d02f9e98132f991f71899612069298e52340e12fb65590836f` | 48-51, 54 |
| square root (`√`) | 27 | `772f491fc17e6bb3bc37c17ace6be704244ab121c7180d59319726e0af4b0efc` | 24, 35-39, 45-47, 51 |
| greater-or-equal (`≥`) | 22 | `05b4a9d88c1df64b3ac339ae6bb7ed82383b93bb08512842452db43453a28970` | 12-13, 15, 17, 21, 30, 36, 42, 44-46 |
| slash (`/`) | 8 | `55447dde50a97970297d189788eb154c675c41e6d2eca2836949aefadd0b1780` | 1, 13-14, 16, 35, 40 |
| omega (`ω`) | 6 | `81b41121b5e19a2aebd37331ab3584fe08221ca1afcda83f4ce8b76997177074` | 32, 40 |

The four control-character groups account for the reduction from 831 to 511
replacement characters in the deterministic Markdown. Punctuation and other
printable source substitutions are exact improvements but do not change that
replacement-character count.

## Complete census and abstentions

The maintenance census walks both the page operators and text tokens through
the production PDF.js loader. It includes whitespace-like controls that the
strict recovery path must normally discard. Three fresh census runs were byte-
identical with SHA-256
`2f46417aac09ff1241d03bdbcc844f9273f75bcae054175d0f9084f6fcb93ae6`.

- Type-3 occurrences observed: 4,437.
- Safely linked to raw fonts: 4,427.
- Explicitly omitted: 10 on pages 33 and 52 because the raw font link was
  ambiguous or unavailable.
- Classified by an official Computer Modern family/position: 2,039.
- Unclassified because the family was ambiguous or unavailable: 2,388.
- Officially named characters: 1,240.
- Strictly recovered: 1,052.
- Officially named but not strictly recovered: 188.

The 188 unresolved occurrences are visible future work, not silent misses.
They include 60 alpha occurrences across three raster variants. Alpha arrives
from PDF.js as the whitespace-like U+000B control; an experimental registration
made an existing exact fixture recovery disappear, so it was completely
reverted. A 64-occurrence minus variant has a target digest but lacks two
qualified witness digests. Both remain unchanged rather than guessed.

## Independent source and visual review

The reference generator pins official CTAN Computer Modern metrics, Type-3
programs, and Metafont source. The Metafont archive SHA-256 is
`b22c69034d9f3f7a9bf22673544bdeaace5656973cf7fb1a395a857148943076`.
Generation mechanically verifies the relevant definitions in `greekl.mf`,
`romms.mf`, `symbol.mf`, and `sym.mf`. The generated runtime reference module
is intentionally byte-identical to the preceding tranche; only its provenance
gained the third independently pinned source.

Rendered Shannon pages 3, 17, 37, 40, and 48 were visually reviewed against the
period, comma, minus, pi, rho, square-root, greater-or-equal, slash, and omega
claims. An independent reviewer also re-counted all nine groups and confirmed
each target plus two witness digests.

## Clean verification and package impact

- Evaluated commit: `578f517c90f21c073673e6668421368374f7cf55`.
- Source PDF SHA-256:
  `6e4e3411984f3edf99dbfe8b941cb5e8a321379ff0cae6ae5c1f592ad8882ca8`.
- Three-process report SHA-256:
  `a785b07f9638be5419319330bb9102fe53b40259e3432f528aec83d6cf95d502`.
- Private report directory:
  `/Users/silverbook/Sites/pdf-tools-extraction-sidecars/shannon-primary-type3-final-20260803-clean-578f517`.
- PDF Tools Markdown SHA-256 in all three repetitions:
  `8b1d2520e4fdbbb1ec3aa1b9fa3ee3604f72712c0b0a37b53a4e4c9d3962ca94`.
- Median elapsed time: 3,690.169 ms; median maximum RSS: 356,188,160 bytes.
- Sampled structure remained unchanged: headings 14/14, reading anchors 23/24
  across 5/6 complete groups, paragraphs 2/4, equations 4/4, footnotes 4/4,
  and one qualifying Table I topology. `TABLE I` remains duplicated.
- Full repository suite: 1,886 passed, 79 intentionally skipped, zero failed.
- Separate native macOS/Node safety suite: 62 passed, 9 intentionally skipped,
  zero failed.
- Transactional share contract: 40 tools, 14 prompts, 112 SBOM components;
  SHA-256
  `957b534b598c87555790d835f8b69fb7d40f83259ceaf119c55add79b379d4ba`.
- Reproducible MCPB: two clean isolated builds were byte-identical; 3,000
  files, 73,642,876 bytes; SHA-256
  `713a31bfa8b2386dbbf66c76dad3488cc7be00ff0ee52d40bb4bbac5e4d64f90`.
- MCPB growth over PR #61: 2,075 bytes, or approximately 0.0028%.
- Packed MCPB smoke passed on macOS arm64 with all 40 tools, 14 prompts,
  canonical resources, a verified mutation, and a native raster image.

The full suite was run in a subshell with ordinary mode-022 file creation
because Silverbook's caller uses private mode-077 creation and one existing
portable-symlink test explicitly expects the ordinary macOS mode. No machine
setting was changed.

The exact bundle has not yet been installed over Silverbook's currently enabled
older PDF Toolkit build. A verified recovery backup was created at
`/Users/silverbook/Library/Application Support/Claude/PDF Tools Host Validation Backups/20260804T141500Z-pre-pr62`,
but Claude's app-control bridge failed to start twice before any installation
action. Native Claude Desktop installation and chat-level use therefore remain
an explicit human-assisted gate.

This evidence does not prove general Type-3 decoding, formula reconstruction,
OCR, full mathematical fidelity, native Claude Desktop behavior, Windows or
Linux execution, release readiness, or that Kepano's complete issue is solved.
