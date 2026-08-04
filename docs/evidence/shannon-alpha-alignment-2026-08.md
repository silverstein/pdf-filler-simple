# Shannon alpha alignment — 2026-08

## Outcome

This tranche safely restores 49 alpha characters (`α`) in Shannon's 55-page
paper. PDF.js exposes these legacy Computer Modern Type-3 glyphs as ordinary
space items, so recovery requires both exact glyph identity and exact operator
position evidence.

The implementation remains fail closed. It requires the existing raw-font,
official character position, target digest, two companion digests, font metric,
and full-page sequence checks. In addition, a collapsed alpha must bind to one
isolated source space between two visible anchors on the same reconstructed
baseline. Its operator-derived advance and position must fit those anchors.

Three cross-line candidates are deliberately left unchanged. One candidate in
a raised equation position is retained because both visible anchors remain on
the same baseline and the operator origin remains inside that line's vertical
extent. Empty end-of-line items, a bundled control run, and an unqualified
font variant remain unchanged.

## Full-paper evidence

- Source SHA-256:
  `6e4e3411984f3edf99dbfe8b941cb5e8a321379ff0cae6ae5c1f592ad8882ca8`.
- Three fresh PDF Tools runs produced byte-identical Markdown:
  `2e7e4fb71d0ea116a352eb1aa1ed1b06c089969643073394d82e23eb5f6ffee3`.
- Each output is 182,565 bytes with exactly 49 restored alpha characters, 498
  replacement characters, and the same 68 explicit gaps as v0.9.1.
- Structural scores remain unchanged: headings 14/14, reading order 24/24,
  paragraphs 3/4, equations 4/4, footnotes 4/4, one qualifying table, and zero
  false equation headings.
- Report SHA-256:
  `4d89be75a3fbae231f8cd46926c7540039867762e7281c2e3281663895113ba9`.
- Private report directory:
  `/Users/silverbook/Sites/pdf-tools-extraction-sidecars/shannon-alpha-final2-2kGgeR/run`.

The operator-derived glyph boxes are used for text placement, but a glyph that
was collapsed to whitespace does not independently create table-structure
evidence. This preserves the existing Shannon table and prevents equation
symbols from creating a false table gap.

The focused contract suite, Markdown renderer suite, live Shannon count test,
and full-paper deterministic evaluation pass. This evidence is source-bound to
the named Shannon PDF. It does not claim general Type-3 decoding or qualify the
remaining minus and comma groups.
