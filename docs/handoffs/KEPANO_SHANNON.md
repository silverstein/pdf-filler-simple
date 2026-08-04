# Kepano / Shannon current handoff

Updated 2026-08-03 (America/Los_Angeles).

## Read this first

Kepano's example is Shannon's 1948 paper, *A Mathematical Theory of
Communication*. It is the example this project has tested all day. It is not a
separate PDF, so do not search for another "Kepano example."

- Public source:
  `https://people.math.harvard.edu/~ctm/home/text/others/shannon/entropy/entropy.pdf`
- Verified local copy on Silverbook:
  `/Users/silverbook/Sites/pdf-tools-extraction-sidecars/shannon-entropy.pdf`
- SHA-256:
  `6e4e3411984f3edf99dbfe8b941cb5e8a321379ff0cae6ae5c1f592ad8882ca8`
- Pages: 55

The goal is to make PDF Tools produce better deterministic Markdown from this
real public document while refusing unsupported guesses. Kepano's suggestions
and linked resources are inputs to evaluate against this example, not a reason
to replace it with a newly invented benchmark.

## Verified current state

- Active worktree:
  `/Users/silverbook/Sites/pdf-tools-worktrees/codex-shannon-type3-next`
- Active branch: `codex/shannon-type3-next`
- Clean implementation checkpoint:
  `578f517c90f21c073673e6668421368374f7cf55`
- Publication status: draft PR #62, stacked directly on PR #61.
- Current draft stack, reviewed from bottom to top:
  - PR #59, `Restore proven mathematical operator spacing`
  - PR #60, `Recover bounded ruled table topology`
  - PR #61, `Recover qualified legacy Type-3 glyphs`
  - PR #62, `Recover the primary vetted Type-3 glyph batch`

PR #61 is stacked directly on PR #60. On the verified Shannon PDF it changes
exactly 31 intended codepoint positions without changing output length:

| Previous extraction | Recovered character | Count |
| --- | --- | ---: |
| replacement character | minus (`−`) | 14 |
| exclamation mark (`!`) | omega (`ω`) | 9 |
| colon (`:`) | period (`.`) | 6 |
| equals sign (`=`) | slash (`/`) | 2 |

Examples now include `−8.69`, `0.411`, `t/2`, and `ω`. All sampled heading,
reading-order, paragraph, equation-anchor, footnote, and table-topology metrics
remain unchanged.

The active next tranche adds 1,021 exact recoveries from nine primary glyph
groups: 345 periods, 315 commas, 216 minuses, 55 pi characters, 27 rho
characters, 27 square roots, 22 greater-or-equal characters, 8 slashes, and 6
omega characters. Production recovery now totals 1,052 exact characters from
13 registered groups. Replacement characters fall from 831 to 511 while all
sampled structural scores remain unchanged.

The complete two-lane census observes all 4,437 Type-3 occurrences. It safely
links 4,427 and explicitly abstains on 10 ambiguous raw-font links. Of 1,240
officially named occurrences, 1,052 are strictly recovered and 188 remain
visible and unchanged. In particular, 60 alpha occurrences remain unresolved
because the source control character interfered with an existing exact
recovery during an experiment, and a 64-occurrence minus variant lacks two
qualified witness glyphs. Do not register either by guess.

The active clean full repository run passed 1,886 tests with 79 intentional
skips and zero failures. The clean Shannon evaluation ran three fresh
repetitions with byte-identical Markdown. Its report SHA-256 is
`a785b07f9638be5419319330bb9102fe53b40259e3432f528aec83d6cf95d502`,
stored outside the repository at:

`/Users/silverbook/Sites/pdf-tools-extraction-sidecars/shannon-primary-type3-final-20260803-clean-578f517`

The active MCPB passed its packed smoke test and grew by only 2,075 bytes
(approximately 0.0028%) over PR #61. First-party documentation, tests, and
maintainer scripts, plus private evaluation outputs, are excluded from the
distributable package.

As of this handoff, PR #62 is an open draft stacked on PR #61. Local
verification is the available evidence; do not silently upgrade that into
host, release, or cross-platform proof.

## Current decision boundary

PR #62 is the active review target. Do not wander off to locate a different
Kepano PDF. First recover the exact state above from Git and the evidence
record, inspect the draft, and preserve its narrow safety claim.

The stack honestly proves bounded exact recoveries from qualified legacy
Computer Modern Type-3 glyph groups. It does not prove general Type-3 decoding,
formula reconstruction, OCR, or faithful mathematical notation throughout the
paper.

Do not merge, release, or reply publicly to Kepano without Mat's explicit
authorization. No Kepano reply has been sent. A reply is worthwhile only if
his actual issue is honestly solved; otherwise do not ping him.

## Fast recovery commands

Run from the worktree named above:

```sh
git status --short
git branch --show-current
git log -2 --oneline
shasum -a 256 /Users/silverbook/Sites/pdf-tools-extraction-sidecars/shannon-entropy.pdf
```

The focused feature checks are:

```sh
PDF_TOOLS_SHANNON_SOURCE=/Users/silverbook/Sites/pdf-tools-extraction-sidecars/shannon-entropy.pdf npm test -- --run test/shannon-type3-live.test.js test/type3-glyph-inventory.test.js test/pdfjs-worker-contract.test.js test/read-pdf-layout.test.js test/eval/extraction-phase1-layout-evidence.test.js
```

The clean Shannon runner command is:

```sh
node scripts/eval-run-shannon-markdown-bakeoff.mjs --source /Users/silverbook/Sites/pdf-tools-extraction-sidecars/shannon-entropy.pdf --pdf-inspector-root /Users/silverbook/Sites/pdf-tools-extraction-sidecars/pdf-inspector-1c32e4bd691b --output-dir /absolute/new/output-directory-outside-the-repository
```

Use a new output directory for every run. The active detailed evidence record
is `docs/evidence/shannon-primary-type3-glyph-batch-2026-08.md`; the preceding
record is `docs/evidence/shannon-qualified-type3-glyphs-2026-08.md`.

## Working with Mat

Use plain, nontechnical language in user-facing updates. Review drafts
yourself; do not hand them to Mat for routine proofreading. Progress updates
are informational and are not a reason to stop an authorized tranche. State
clearly what is shipped, what is only a draft, and what still needs a human
decision.
