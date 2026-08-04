# Shannon qualified Type-3 glyph recovery — 2026-08

## Outcome

PDF Tools now recovers four exact characters from a narrowly qualified class of
legacy Computer Modern Type-3 fonts: omega, period, slash, and minus. The
recovery uses official CTAN Computer Modern metrics plus reviewed glyph-shape
references. It is accepted only when the target glyph, two independent witness
glyphs, the font metrics, every page text token, and the raw PDF font binding
all agree. Any missing, ambiguous, oversized, altered, or replay-inconsistent
evidence makes the extractor refuse the recovery rather than guess.

The generated reference module is reproducible from pinned CTAN archives and
is mirrored byte-for-byte into the share package. The fixture visually labels
the reference characters so a reviewer can compare its expected text to its
rendered page. The Extraction IR identity is `pdf-tools.extraction-ir` version
`1.3.0`; the Markdown renderer identity is
`pdf-tools.layout-markdown-renderer` version `1.8.0`.

This is not general Type-3 decoding, formula reconstruction, OCR, or a claim
that Shannon's mathematical notation is now faithful. Unqualified characters
remain unchanged and the existing typed coverage gaps remain visible.

## Clean run

- Evaluated commit: `7851bb49051997422a65def6e4311e817760d604`
- Source PDF SHA-256:
  `6e4e3411984f3edf99dbfe8b941cb5e8a321379ff0cae6ae5c1f592ad8882ca8`
- Report SHA-256:
  `f6502c3312b69cf0eb997817da59a536fe56a0189f9a5d5f54453dc653bc6b69`
- Private report directory:
  `/Users/silverbook/Sites/pdf-tools-extraction-sidecars/shannon-type3-final-20260803-clean-7851bb4`
- Repetitions: three fresh processes per candidate
- PDF Tools Markdown deterministic across repetitions: `true`
- PDF Tools output SHA-256 for all three repetitions:
  `d2807f994c6d0ba28c44a8953a2d51436d077130b4e7229cb3d6e0418562bd33`
- Median PDF Tools elapsed time: 3590.361 ms
- Median PDF Tools maximum RSS: 341,573,632 bytes

## Exact output change

The qualified feature changes 31 codepoint positions in the 55-page Markdown
without changing its total codepoint length:

| Previous extraction | Recovered character | Count |
| --- | --- | ---: |
| replacement character | minus (`−`) | 14 |
| exclamation mark (`!`) | omega (`ω`) | 9 |
| colon (`:`) | period (`.`) | 6 |
| equals sign (`=`) | slash (`/`) | 2 |

Examples now include `−8.69`, `0.411`, `t/2`, and `ω`. Every sampled
structural metric is identical before and after: intended headings 14/14,
ordered anchors 23/24, complete ordered-anchor groups 5/6, paragraph anchors
2/4, equation anchors 4/4, footnote anchors 4/4, and one qualifying Table I
topology. This establishes the bounded character changes, not full formula
correctness.

## Verification and package impact

- Full repository suite: 1,883 passed, 79 intentionally skipped, zero failed.
- Focused extraction, worker, Markdown, MCP, and evaluation suite: 169 passed,
  6 intentionally skipped, zero failed.
- Transactional share contract: 40 tools, 14 prompts, 112 SBOM components;
  SHA-256
  `990e9a046df394955f97618602b15675dda6c079183dc647f099e9f172acf68d`.
- Reproducible MCPB: two isolated builds were byte-identical; 3,000 files,
  73,640,801 bytes; SHA-256
  `d0f2bacfa90d062a02b6d5a121e28ce4b48174fb7555e21aea8a8f4791e1dc58`.
- MCPB growth over the parent branch: 23,395 bytes, or 0.032%.
- Packed MCPB smoke test passed on macOS arm64 with 40 tools, 14 prompts,
  canonical resources, a verified PDF mutation, and a native raster image.

The packed check is local macOS evidence. It is not Claude Desktop host
testing, cross-platform native execution, release authorization, or a public
benchmark claim.
