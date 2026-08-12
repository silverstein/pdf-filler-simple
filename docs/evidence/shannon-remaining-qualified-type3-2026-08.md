# Shannon remaining qualified Type-3 batch — 2026-08

## Outcome

This tranche recovers 59 additional exact characters from nine legacy
Computer Modern Type-3 raster groups in Shannon's 55-page paper. It extends
the released v0.9.0 recovery from 1,052 to 1,111 officially named Type-3
occurrences. It remains fail closed: the raw font link, official character
position, target glyph digest, two companion glyph digests, font metrics, and
complete page text sequence must all agree.

| Character | Count |
| --- | ---: |
| comma (`,`) | 26 |
| slash (`/`) | 13 |
| rho (`ρ`) | 9 |
| period (`.`) | 6 |
| pi (`π`) | 3 |
| greater-or-equal (`≥`) | 1 |
| square root (`√`) | 1 |

The fresh census observes 4,437 Type-3 occurrences, safely links 4,427, and
continues to omit 10 ambiguous raw-font links. Of 1,240 officially named
occurrences, 1,111 are now strictly recovered and 129 remain visible and
unchanged. The remaining groups are 64 minuses without two qualified companion
glyphs, 60 alphas whose source characters are collapsed into whitespace by
PDF.js, and 5 commas without two companion glyphs.

## Full-paper evidence

- Source SHA-256:
  `6e4e3411984f3edf99dbfe8b941cb5e8a321379ff0cae6ae5c1f592ad8882ca8`.
- Three fresh PDF Tools runs produced byte-identical Markdown:
  `1f1abbc9a6d652c40b7295dc67a0640218d6287aa212a9f0743fd618ff18bd82`.
- Each output is 182,488 bytes with 498 replacement characters and 68
  explicit gaps. The released v0.9.0 baseline had 511 replacement characters.
- Structural scores remain at the current best: headings 14/14, reading order
  24/24, paragraphs 3/4, equations 4/4, footnotes 4/4, one qualifying table,
  and zero equation-like false headings.
- Report SHA-256:
  `811766852b606b390da57b17d04187a82b6ba5a462d9d629bfc0628d1a6a52bf`.
- Private report directory:
  `/Users/silverbook/Sites/pdf-tools-extraction-sidecars/shannon-remaining-type3-20260804-1357`.
- Fresh inventory SHA-256:
  `e70da556a231789445a6f8a7b5e135613d4a6b4b1b8ce07cf430e3c66592a820`.

Focused live and inventory tests pass with the exact 59 new group counts. The
root and shared runtime copies are byte-identical. The retained extraction
oracle changed only its exact runtime file size and hashes; all fixture cases
and approved observations stayed byte-identical.

The clean full suite passed 1,983 tests with 80 intentional skips except for
one timing-sensitive process-lifecycle assertion; the exact 22-test lifecycle
file then passed three consecutive reruns. The separate native Mac suite passed
62 tests with 9 intentional skips and zero failures.

The transactional share contract passed with 41 tools, 14 prompts, 112 SBOM
components, native raster rendering, and SHA-256
`e1381a5dbb418f05378b5f1c0e44cdbe5f0349b2c093702955c96c600e5a8dff`.
Two isolated MCPB builds were byte-identical: 2,996 files, 73,685,458 bytes,
SHA-256
`6b1853f5bd1e5f0557ae5d1fcfe21da280c83613b605c524ed9b070b7f0af6ff`.
The packed MCPB smoke passed on macOS arm64 with all 41 tools, all 14 prompts,
canonical resources, PDF mutation, source-bound comparison, and native raster
rendering.

The public v0.9.1 artifact was subsequently installed in Claude Desktop. Its
registry hash matches the public MCPB, Claude's host log records successful
server launch and discovery, the installed-copy smoke passed, and the installed
55-page Shannon conversion exactly reproduced the reviewed 498-character
output. See `docs/evidence/v0.9.1-installed-proof-2026-08.md`.

This evidence does not qualify the remaining minus, alpha, or comma groups and
does not prove general Type-3 decoding, OCR, or complete mathematical fidelity.
