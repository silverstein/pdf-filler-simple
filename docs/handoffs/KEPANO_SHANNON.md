# Kepano / Shannon current handoff

Updated 2026-08-04 (America/Los_Angeles).

## Read this first

Kepano's example is Shannon's 1948 paper, *A Mathematical Theory of
Communication*. Do not substitute a different PDF.

- Public source:
  `https://people.math.harvard.edu/~ctm/home/text/others/shannon/entropy/entropy.pdf`
- Verified local copy:
  `/Users/silverbook/Sites/pdf-tools-extraction-sidecars/shannon-entropy.pdf`
- SHA-256:
  `6e4e3411984f3edf99dbfe8b941cb5e8a321379ff0cae6ae5c1f592ad8882ca8`
- Pages: 55

The goal is better deterministic Markdown from this real public paper while
refusing unsupported guesses.

## Shipped state

PDF Tools v0.9.4 is public:
`https://github.com/Open-Document-Alliance/PDF-Tools/releases/tag/v0.9.4`.
It includes the cumulative Shannon extraction work, the PDF comparison product,
49 source-supported alpha recoveries, the final fail-closed comparison-geometry
hardening, and safe recovery of the final 64 minus signs and five commas.

- v0.9.4 release commit:
  `50f3ccc378856611ef22d86e507bd10740edc33a`.
- The release MCPB was downloaded, hash-checked, installed in Claude Desktop,
  loaded successfully, and tested from the installed copy.
- Exactly one current PDF Tools identity remained enabled after installation.
- Installed Shannon conversion: 55 pages, 434 replacement characters, 49
  recovered alpha symbols, 68 explicit gaps, 182,565 bytes, and exact reviewed
  Markdown SHA-256
  `723ca1614c6516ee698c596aab6acb84c0437983e6f96c1f871dea9668b79985`.
- The named but unrecovered Type-3 census is now 11, down from 80 in v0.9.3.
- Current sampled quality: headings 14/14, reading order 24/24, paragraphs
  3/4, equations 4/4, footnotes 4/4, one qualifying table, and zero false
  equation headings.

PR #68 landed the 59-character batch and PR #69 prepared v0.9.1. The old
stacked PRs #55 through #64 remain closed as superseded. Do not resume them.

## Alpha recovery shipped in v0.9.2

- Historical implementation branch: `agent/shannon-alpha-alignment` in the
  collision-free `pdf-tools-shannon-alpha` worktree.
- The old `agent/shannon-remaining-type3` worktree is historical after PR #68.

The shipped v0.9.1 tranche adds 59 exact recoveries from nine already qualified
raster groups: 26 commas, 13 slashes, 9 rho characters, 6 periods, 3 pi
characters, 1 greater-or-equal character, and 1 square root.

Three full-paper runs are byte-identical. Replacement characters fall from
511 to 498, explicit gaps remain 68, and all sampled structural scores remain
at the shipped best. The detailed record is
`docs/evidence/shannon-remaining-qualified-type3-2026-08.md`.

The fresh alpha-alignment candidate restores 49 alphas without changing the
498 replacement-character count, 68 explicit gaps, sampled structural scores,
or qualifying table. Three full-paper runs are byte-identical at Markdown
SHA-256
`2e7e4fb71d0ea116a352eb1aa1ed1b06c089969643073394d82e23eb5f6ffee3`.
The detailed record is
`docs/evidence/shannon-alpha-alignment-2026-08.md`.

The design uses exact PDF operator text state to place each recovered alpha.
It accepts only one isolated source space whose visible neighbors belong to the
same reconstructed baseline. It intentionally rejects three cross-line cases,
seven empty end-of-line items, one bundled control run, and one unqualified
variant. A recovered whitespace glyph can contribute text but cannot create
new table-structure evidence by itself.

The released v0.9.2 census strictly recovers 1,160 of 1,240 officially named
Type-3 occurrences. Its 80 remaining occurrences are:

- 64 minuses with a target fingerprint but no two qualified companion glyphs;
- 11 alpha cases that fail the source-alignment rules;
- 5 commas without two qualified companion glyphs.

Do not register any remaining group by guess. At the v0.9.2 release point,
alpha had a reviewed source-bound alignment design while the minus and comma
groups still lacked sufficient companion evidence. The candidate below closes
the latter evidence gap.

## Qualified 69-character recovery shipped in v0.9.4

Implementation commit `942d80405d4949033765f7e5c49c16467c27f9f7` supplies the missing companion
evidence for all 64 minus signs and all five commas. It reduces the named but
unrecovered census from 80 to 11; the only remaining named cases are the eleven
alpha placements that deliberately fail the alignment rules.

Three clean full-paper runs are byte-identical at Markdown SHA-256
`723ca1614c6516ee698c596aab6acb84c0437983e6f96c1f871dea9668b79985`.
The candidate changes exactly 69 characters and preserves every sampled
structural score. The complete repository gate passes with zero failures, and
an independent exact-commit review accepted the fail-closed evidence. See
`docs/evidence/shannon-minus-comma-final-2026-08.md`.

## Current gates

The implementation, independent review, merge, reproducible package, public
v0.9.4 release, exact public re-download, Claude installation, registry match,
host discovery, installed-copy smoke, and installed Shannon proof are complete.
PR #78 landed the 69-character Shannon recovery. PR #79 merged the v0.9.4
release as `50f3ccc378856611ef22d86e507bd10740edc33a`.

No public reply to Kepano has been sent yet. A concise reply may now point him
to the public repository and v0.9.4 while honestly saying that the named paper
is substantially improved, not universally or mathematically reconstructed.
Eleven alpha cases intentionally abstain under the alignment rules. Do not
claim the paper or arbitrary mathematical PDFs are completely solved.

## Post-v0.9.4 cross-paper candidate

Branch `agent/general-numbered-headings`, implementation commit
`b74d110f2faad440c24915bb4f62546d6b5221da`, broadens the heading work beyond
Shannon. It merged in PR #81 as
`945c94376d5d254b8d38b7b33af29e04d5ebc703`. The follow-up branch
`agent/split-numbered-headings`, exact implementation
`fbf5db638360f2e511950ef03e5b6332a39ee972`, completes Adam's exact same-font
small-caps pattern. Across two additional public research papers the combined
candidate recovers all 39 genuinely numbered headings that v0.9.4 missed and
removes both false headings caused by vertical arXiv margin labels. Attention
is 22/22 and Adam is 17/17; Adam's References title is visibly unnumbered and
stays unnumbered. Shannon's existing sampled quality is unchanged across three
complete, byte-identical 55-page runs.

The separate chart/diagram guard branch `agent/chart-heading-guard`, exact
implementation `e90e0ed57f308e46a7ca6507c13b0d1bc7172890`, removes eleven false H1
lines from Adam's chart-heavy page 7 and three false H1 diagram labels from
Attention pages 13 through 15. It preserves both true titles and the complete
39/39 numbered-heading result. Shannon remains byte-identical with unchanged
sampled quality.
Exact compatibility repair tip `bec9fb4683aca1384391e7d8b3b43aaa7eef326d`
preserves a true first-page `CONTENTS` title after the full-suite regression
check without weakening the chart-label guard.

The detailed evidence is
`docs/evidence/general-numbered-research-headings-2026-08.md`. This is a
merge-quality candidate, not a reason on its own to publish v0.9.5. Keep the
installed and public package on exact v0.9.4 until a worthy release bundle is
ready.

Maintainer retest requests for the current v0.9.4 package are open at:

- Windows issue #42:
  `https://github.com/Open-Document-Alliance/PDF-Tools/issues/42#issuecomment-5186253739`
- macOS stable-tool exposure issue #47:
  `https://github.com/Open-Document-Alliance/PDF-Tools/issues/47#issuecomment-5186253859`

Do not reply to Kepano yet. First merge the chart/diagram guard cleanly. A
later reply should point to a tested public release, not unreleased master.

## Fast recovery commands

Run from a fresh clean worktree based on current `origin/master`:

```sh
git status --short
git branch --show-current
git log -2 --oneline
shasum -a 256 /Users/silverbook/Sites/pdf-tools-extraction-sidecars/shannon-entropy.pdf
```

Focused checks:

```sh
PDF_TOOLS_SHANNON_SOURCE=/Users/silverbook/Sites/pdf-tools-extraction-sidecars/shannon-entropy.pdf npx vitest run test/shannon-type3-live.test.js test/type3-glyph-inventory.test.js
```

Fresh census:

```sh
node scripts/inventory-type3-glyphs.mjs --source /Users/silverbook/Sites/pdf-tools-extraction-sidecars/shannon-entropy.pdf
```

Full-paper evaluation:

```sh
node scripts/eval-run-shannon-markdown-bakeoff.mjs --source /Users/silverbook/Sites/pdf-tools-extraction-sidecars/shannon-entropy.pdf --pdf-inspector-root /Users/silverbook/Sites/pdf-tools-extraction-sidecars/pdf-inspector-1c32e4bd691b --output-dir /absolute/new/output-directory-outside-the-repository
```

Use a new output directory for every run. Never call `bd`.

## Working with Mat

Use plain, nontechnical language in user-facing updates. Review drafts
yourself; do not hand them to Mat for routine proofreading. Progress updates
are informational and are not a reason to stop an authorized tranche. State
clearly what is shipped, what is under test, and what remains unresolved.
