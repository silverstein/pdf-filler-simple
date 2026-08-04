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

PDF Tools v0.9.0 is public:
`https://github.com/Open-Document-Alliance/PDF-Tools/releases/tag/v0.9.0`.
The release tag and public `master` include the cumulative Shannon extraction
work through the fraction, spacing, table, heading, and first two Type-3
batches, plus the PDF comparison product.

- Final v0.9.0 master:
  `9c98bd3eaee8dbd61e1e3c9639d3263ce4147683`.
- The release MCPB was downloaded, hash-checked, installed in Claude Desktop,
  loaded successfully, and tested from the installed copy.
- Exactly one current PDF Tools identity remained enabled after installation.
- Installed Shannon conversion: 55 pages, 511 replacement characters, 68
  explicit gaps.
- Current sampled quality: headings 14/14, reading order 24/24, paragraphs
  3/4, equations 4/4, footnotes 4/4, one qualifying table, and zero false
  equation headings.

The old stacked PRs #55 through #64 are closed as superseded by the combined
release PR #66. PR #67 repaired the final installed-copy evidence. Do not try
to resume or merge the old stack.

## Active next excellence target

- Worktree:
  `/Users/silverbook/Sites/pdf-tools-worktrees/pdf-tools-shannon-remaining`
- Branch: `agent/shannon-remaining-type3`
- Exact base: released master
  `9c98bd3eaee8dbd61e1e3c9639d3263ce4147683`.

The active tranche adds 59 exact recoveries from nine already qualified raster
groups: 26 commas, 13 slashes, 9 rho characters, 6 periods, 3 pi characters,
1 greater-or-equal character, and 1 square root.

Three full-paper runs are byte-identical. Replacement characters fall from
511 to 498, explicit gaps remain 68, and all sampled structural scores remain
at the shipped best. The detailed record is
`docs/evidence/shannon-remaining-qualified-type3-2026-08.md`.

The fresh census now strictly recovers 1,111 of 1,240 officially named Type-3
occurrences. The 129 remaining occurrences are:

- 64 minuses with a target fingerprint but no two qualified companion glyphs;
- 60 alpha symbols across three variants whose source control characters are
  collapsed into ordinary-looking whitespace by PDF.js;
- 5 commas without two qualified companion glyphs.

Do not register any remaining group by guess. Alpha has strong identity
evidence, but needs a separate, carefully tested alignment design because
several symbols can collapse into one blank text run.

## Current gates

The active tranche is not shipped yet. Implementation commit
`d5b902b45084738fe7ed6a275c3dfbf8c02db3bc` has full-paper, focused,
share-contract, reproducible MCPB, packed-smoke, and native Mac evidence.
The complete suite passed 1,983 tests and hit one unrelated timing assertion;
that exact 22-test lifecycle file then passed three consecutive reruns.

Before merging or installing it:

1. Obtain an independent exact-commit review.
2. Push and merge through a reviewed PR.
3. Rebuild from public master, install that exact artifact, and repeat
   installed-copy and Shannon proof.

Mat has authorized routine merge and installation. A new public release should
still be based on the complete checks above. No public reply to Kepano has been
sent. A reply is worthwhile only when the remaining paper-wide issue is
honestly solved enough to help him; progress alone is not a reason to ping him.

## Fast recovery commands

Run from the active worktree:

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
