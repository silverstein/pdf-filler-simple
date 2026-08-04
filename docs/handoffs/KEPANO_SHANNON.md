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

PDF Tools v0.9.1 is public:
`https://github.com/Open-Document-Alliance/PDF-Tools/releases/tag/v0.9.1`.
It includes the cumulative Shannon extraction work, the PDF comparison product,
and the 59-character remaining qualified Type-3 batch.

- v0.9.1 release commit:
  `da82eca8ae36f2013ff1871421991167cd80df03`.
- The release MCPB was downloaded, hash-checked, installed in Claude Desktop,
  loaded successfully, and tested from the installed copy.
- Exactly one current PDF Tools identity remained enabled after installation.
- Installed Shannon conversion: 55 pages, 498 replacement characters, 68
  explicit gaps, exact reviewed Markdown SHA-256.
- Current sampled quality: headings 14/14, reading order 24/24, paragraphs
  3/4, equations 4/4, footnotes 4/4, one qualifying table, and zero false
  equation headings.

PR #68 landed the 59-character batch and PR #69 prepared v0.9.1. The old
stacked PRs #55 through #64 remain closed as superseded. Do not resume them.

## Alpha candidate ready for integration

- Candidate branch: `agent/shannon-alpha-alignment` in the collision-free
  `pdf-tools-shannon-alpha` worktree, based on public `master` commit
  `cb585b9e158e9b76feada053ca36511e40d62a55`.
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

Before this candidate is merged, the released v0.9.1 census strictly recovers
1,111 of 1,240 officially named Type-3 occurrences. Its 129 remaining
occurrences are:

- 64 minuses with a target fingerprint but no two qualified companion glyphs;
- 60 alpha symbols across three variants whose source control characters are
  collapsed into ordinary-looking whitespace by PDF.js;
- 5 commas without two qualified companion glyphs.

Do not register any remaining group by guess. Alpha now has a reviewed,
source-bound alignment design; the minus and comma groups still lack sufficient
companion evidence.

## Current gates

The alpha implementation, independent review, merge, reproducible package,
packed smoke, Claude installation, host discovery, installed-copy smoke, and
installed Shannon proof are complete. PR #71 merged as
`cce500f693df597160ae21f332ec1292dd9ee5c6`. The public release and Kepano
reply remain the next decisions. The 64-minus and 5-comma groups remain blocked
on missing companion evidence.

Mat has authorized routine merge and installation. A new public release should
still be based on the complete checks above. No public reply to Kepano has been
sent. A reply is worthwhile only when the remaining paper-wide issue is
honestly solved enough to help him; progress alone is not a reason to ping him.

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
