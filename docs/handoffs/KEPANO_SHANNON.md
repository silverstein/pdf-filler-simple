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

- Worktree:
  `/Users/silverbook/Sites/pdf-tools-worktrees/codex-shannon-type3-glyphs`
- Branch: `codex/shannon-type3-glyphs`
- Published tip before this handoff:
  `8490db5e51a6c52babacad2a89d79a1cb9ad97cb`
- Current draft stack, reviewed from bottom to top:
  - PR #59, `Restore proven mathematical operator spacing`
  - PR #60, `Recover bounded ruled table topology`
  - PR #61, `Recover qualified legacy Type-3 glyphs`

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

The clean full repository run passed 1,883 tests with 79 intentional skips and
zero failures. The clean Shannon evaluation ran three fresh repetitions with
byte-identical Markdown. Its report SHA-256 is
`f6502c3312b69cf0eb997817da59a536fe56a0189f9a5d5f54453dc653bc6b69`,
stored outside the repository at:

`/Users/silverbook/Sites/pdf-tools-extraction-sidecars/shannon-type3-final-20260803-clean-7851bb4`

The final MCPB passed its packed smoke test and grew by only 23,395 bytes
(0.032%) over PR #60. Documentation, tests, scripts, and private evaluation
outputs are excluded from the distributable package.

As of this handoff, PRs #60 and #61 are open, mergeable drafts with no reviewer
comments and no GitHub checks reported. Local verification is the available
evidence; do not silently upgrade that into host, release, or cross-platform
proof.

## Current decision boundary

PR #61 is the current review target. Do not wander off to locate a different
Kepano PDF. First recover the exact state above from Git and the evidence
record, inspect the draft, and preserve its narrow safety claim.

The feature honestly proves four exact recoveries from a narrowly qualified
class of legacy Computer Modern Type-3 fonts. It does not prove general Type-3
decoding, formula reconstruction, OCR, or faithful mathematical notation
throughout the paper.

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
npm test -- --run test/convert-pdf-to-markdown.test.js test/markdown-conversion.test.js test/mcp-contract.test.js test/pdfjs-worker-contract.test.js test/read-pdf-layout.test.js test/eval/markdown-bakeoff.test.js test/eval/extraction-phase1-layout-evidence.test.js
```

The clean Shannon runner command is:

```sh
node scripts/eval-run-shannon-markdown-bakeoff.mjs --source /Users/silverbook/Sites/pdf-tools-extraction-sidecars/shannon-entropy.pdf --pdf-inspector-root /Users/silverbook/Sites/pdf-tools-extraction-sidecars/pdf-inspector-1c32e4bd691b --output-dir /absolute/new/output-directory-outside-the-repository
```

Use a new output directory for every run. The detailed evidence record is
`docs/evidence/shannon-qualified-type3-glyphs-2026-08.md`.

## Working with Mat

Use plain, nontechnical language in user-facing updates. Review drafts
yourself; do not hand them to Mat for routine proofreading. Progress updates
are informational and are not a reason to stop an authorized tranche. State
clearly what is shipped, what is only a draft, and what still needs a human
decision.
