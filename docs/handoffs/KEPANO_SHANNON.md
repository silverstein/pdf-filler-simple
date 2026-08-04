# Kepano / Shannon current handoff

Updated 2026-08-04 (America/Los_Angeles).

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
  `/Users/silverbook/Sites/pdf-tools-worktrees/codex-shannon-simple-fraction`
- Active branch: `codex/shannon-simple-fraction`
- Exact current implementation and clean-suite checkpoint:
  `a6a2f79aaeb292d9dc8f65433feaf00ca7ea3705`
- Later commits on the branch update evidence and this handoff only; use
  `git rev-parse HEAD` for the current published branch tip.
- The documentation tip is intentionally resolved live rather than written
  into this file, because committing a self-referenced hash would immediately
  create a different tip. The tested runtime checkpoint above is immutable.
- Publication status: draft PR #64, stacked directly on PR #63.
- Current draft stack, reviewed from bottom to top:

| PR | Draft outcome | Direct base |
| ---: | --- | --- |
| #55 | Evaluate Shannon Markdown candidates and fix invalid line grouping | `master` |
| #56 | Reject malformed heading candidates | PR #55 |
| #57 | Recover strongly supported document headings | PR #56 |
| #58 | Improve narrowly supported paragraph continuity | PR #57 |
| #59 | Restore proven mathematical operator spacing | PR #58 |
| #60 | Recover bounded ruled table topology | PR #59 |
| #61 | Recover the first qualified legacy Type-3 glyph batch | PR #60 |
| #62 | Recover the primary vetted Type-3 glyph batch | PR #61 |
| #63 | Restore narrowly supported prose/math spacing | PR #62 |
| #64 | Render explicitly barred prose fractions | PR #63 |

All ten local branch tips through PR #64 match their live GitHub PR heads.
Each draft was open and mergeable during its live review. PR #64 is open,
draft, mergeable, and clean with no comments, reviews, or reported checks. The
cumulative top branch passed the complete verification described below.

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

PR #62 adds 1,021 exact recoveries from nine primary glyph groups: 345
periods, 315 commas, 216 minuses, 55 pi characters, 27 rho
characters, 27 square roots, 22 greater-or-equal characters, 8 slashes, and 6
omega characters. The tested draft implementation totals 1,052 exact
characters from 13 registered groups. Replacement characters fall from 831 to
511 while all sampled structural scores remain unchanged.

The complete two-lane census observes all 4,437 Type-3 occurrences. It safely
links 4,427 and explicitly abstains on 10 ambiguous raw-font links. Of 1,240
officially named occurrences, 1,052 are strictly recovered and 188 remain
visible and unchanged. In particular, 60 alpha occurrences remain unresolved
because the source control character interfered with an existing exact
recovery during an experiment, and a 64-occurrence minus variant lacks two
qualified witness glyphs. Do not register either by guess.

PR #63 restores exactly two source-supported spaces: `storeN bits` becomes
`store N bits`, and `capacityC of a discrete channel` becomes `capacity C of a
discrete channel`. It requires a matching nearby compact equation, exact font
identity, same column, tight geometry, and a prose-font sandwich. The sampled
reading-order score improves from 23/24 across 5/6 complete groups to 24/24
across 6/6 groups. The evaluator also stops treating the legitimate prose
reference `In Table I` as a duplicated standalone table label, improving that
sampled score from 6/7 to 7/7 without changing table output. Paragraph
continuity remains 2/4.

PR #64 converts one explicitly barred, single-digit stacked fraction from the
split output `31` / `3` into `3 1/3`. It requires exact surrounding source
whitespace, aligned same-font digits, same-line prose on both sides, and one
matching thin source-painted bar. Missing, shifted, thick, or competing bars
abstain. This improves sampled paragraph continuity from 2/4 to 3/4. It is not
general formula or fraction reconstruction.

The active clean full repository run passed 1,889 tests with 80 intentional
skips and zero failures. The separate native Mac safety suite passed 62 with 9
intentional skips and zero failures. The PR #64 Shannon evaluation ran three
fresh repetitions with byte-identical Markdown. Its report SHA-256 is
`e5339902bd55b9aabe2a1a2f60ccc76844323f0db83935bd641e0f43fddb8ccd`,
stored outside the repository at:

`/Users/silverbook/Sites/pdf-tools-extraction-sidecars/shannon-simple-fraction-final3-20260804-0924`

The exact PR #62 MCPB passed its packed smoke test and grew by only 2,075 bytes
(approximately 0.0028%) over PR #61. First-party documentation, tests, and
maintainer scripts, plus private evaluation outputs, are excluded from the
distributable package.

On 2026-08-04, the exact MCPB was installed in Claude Desktop. The installation
registry SHA-256 matches the artifact, the Claude host log records successful
startup and tool discovery, and the older PDF Tools identity was removed. One
enabled current installation remains. Its installed directory passed the
synthetic installed-server smoke and converted all 55 Shannon pages to the
exact reviewed Markdown SHA-256
`8b1d2520e4fdbbb1ec3aa1b9fa3ee3604f72712c0b0a37b53a4e4c9d3962ca94`,
with 511 replacement characters and 68 explicit gaps. A verified pre-install
backup remains at
`/Users/silverbook/Library/Application Support/Claude/PDF Tools Host Validation Backups/20260804T141500Z-pre-pr62`.
A Shannon conversion initiated inside a Claude chat remains an unrun UI-level
check; do not silently claim that narrower proof.

PR #63 remains an open draft stacked on PR #62. It has clean source-checkout,
deterministic Shannon, native Mac safety, and transactional share-contract
proof. Its two isolated MCPB builds were byte-identical: 3,000 files,
73,643,660 bytes, SHA-256
`23ba42f4c9f9c2949021c5b098748cd54e0f46145b6346d6478c9fe0dd118f18`.
The packed copy passed its macOS arm64 smoke with all 40 tools, but has not been
installed. The native installation, Claude host-loading, and installed-bundle
server proof belongs only to the exact PR #62 artifact; do not silently
transfer it to PR #63 or a later draft, or upgrade either result into release, cross-platform,
or Claude-chat proof.

PR #64's two isolated MCPB builds were byte-identical: 3,000 files, 73,645,475
bytes, SHA-256
`fa4431ca17894413484a5e940283b99ec6458e35031dee083a96b6fb4898287d`.
The packed copy passed its macOS arm64 smoke with all 40 tools, all 14 prompts,
PDF mutation, and native raster rendering. It has not been installed.

## Current decision boundary

PR #64 is the active review target. Do not wander off to locate a different
Kepano PDF. First recover the exact state above from Git and the evidence
record, inspect the draft, and preserve its narrow safety claim.

The stack honestly proves bounded exact recoveries from qualified legacy
Computer Modern Type-3 glyph groups. It does not prove general Type-3 decoding,
formula reconstruction, OCR, or faithful mathematical notation throughout the
paper.

Do not merge, release, or reply publicly to Kepano without Mat's explicit
authorization. No Kepano reply has been sent. A reply is worthwhile only if
his actual issue is honestly solved; otherwise do not ping him.

If Mat later authorizes landing, preserve the order above. Merge PR #55 first,
retarget PR #56 to `master`, verify its diff, and continue one PR at a time
through #64. Never merge a higher draft while its direct base is still an
unmerged feature branch. Re-run the cumulative tests and package proof after
the final landing; any repack has a new artifact identity. Installed Claude
Desktop proof must be repeated for that new artifact identity after the code
lands.

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
npx vitest run test/test-runner-contract.test.js test/mcp-contract.test.js test/eval/markdown-bakeoff.test.js test/convert-pdf-to-markdown.test.js test/markdown-conversion.test.js
```

The clean Shannon runner command is:

```sh
node scripts/eval-run-shannon-markdown-bakeoff.mjs --source /Users/silverbook/Sites/pdf-tools-extraction-sidecars/shannon-entropy.pdf --pdf-inspector-root /Users/silverbook/Sites/pdf-tools-extraction-sidecars/pdf-inspector-1c32e4bd691b --output-dir /absolute/new/output-directory-outside-the-repository
```

Use a new output directory for every run. The active detailed evidence record
is `docs/evidence/shannon-explicit-stacked-fraction-2026-08.md`; the preceding
record is `docs/evidence/shannon-prose-math-spacing-2026-08.md`.

## Working with Mat

Use plain, nontechnical language in user-facing updates. Review drafts
yourself; do not hand them to Mat for routine proofreading. Progress updates
are informational and are not a reason to stop an authorized tranche. State
clearly what is shipped, what is only a draft, and what still needs a human
decision.
