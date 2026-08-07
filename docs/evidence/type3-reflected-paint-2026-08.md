# Reflected Type-3 paint — defect, fix and measurement, 2026-08

## The defect

Moving the Type-3 recovery key onto the stored image-mask grid made it
producer-independent, which is what it exists to be. It also made it blind to
reflection, and in Computer Modern reflection is usually a **different
enrolled character**, not a different view of the same one.

**16 of the shipped registry digests — eight mirror pairs — are the exact
horizontal mirror of another shipped digest.** They are the parenthesis and
bracket pairs of the two enrolled cmex fonts: five pairs in one, three in the
other. Each pair honestly stores two separate rasters, one the mirror of the
other, and each recovers correctly. But a CharProc that stores the `]` raster
and paints it reflected paints a `[`, and the stored grid alone cannot tell
those two apart.

Measured, not assumed: the registry holds 71 entries over 69 distinct primary
digests, 68 of which the reference document resolves to an actual grid. Every
one of those 68 grids was mirrored horizontally, vertically and by 180° and
the result looked back up in the registry. Horizontal mirroring hit another
registry digest 16 times; 180° rotation hit the same 16, these glyphs being
vertically symmetric; vertical mirroring hit nothing. An earlier review note
put this at 32 by counting each digest once per transform that hits — the
figure is 16 digests.

### Reproduced on the reference document

Edited exactly one number in `shannon-entropy.pdf`: the CharProc of CMEX code
3 (`]`, glyph `/#2303` of font `23 0 R`). Mask bytes left byte-identical; only
the x scale of the glyph's own placement `cm` negated, with the matching
translation so the reflected ink lands in the same box.

```
17 0 0 98 1.1 -95.1 cm     →     -17 0 0 98 18.1 -95.1 cm
```

A control document was built the same way — same decompression, same
re-encode, same object rewrite — with the `cm` left alone, so the measurement
separates the mutation from the repackaging.

| Strict recoveries, all 55 pages | pristine | control (re-encoded, upright) | mutated (reflected) |
| --- | ---: | ---: | ---: |
| master `241a8dd` | 1,864 | 1,864 | **1,853** |
| this branch, before the fix | 1,872 | 1,872 | **1,872** |
| this branch, after the fix | 1,872 | 1,872 | **1,775** |

Master abstains on the tampered glyph: `cmex-pk-raster-big-right-bracket-a23d3c-v1`
goes from 11 occurrences to 0, because master's key was the CharProc operator
list and the edited `cm` is inside it. The grid-keyed branch **kept emitting
`]` eleven times for ink that now paints `[`, and reported no gap.** That is
the regression.

## What was rejected, and why

Two fixes were considered first and are recorded here so they are not retried.

- **Fold the CharProc-local determinant sign into the key.** Producer-
  dependent, and therefore a reintroduction of the exact defect the grid key
  removed. Shannon carries its flip in `FontMatrix [1 0 0 -1]` and every one
  of its 24 Type-3 fonts composes to sign −1; other dvips-era producers leave
  the FontMatrix upright and come out uniformly +1. The same painted glyph
  would key two ways.
- **Abstain whenever one font holds two enrolled codes that are mirrors of
  each other.** Kills every legitimate Shannon parenthesis and bracket
  recovery, where each code honestly stores its own raster.

**Shape-code injectivity does not catch this**, and both the previous
docstring at the canonical-mask helper and the commit message of *"Key Type-3
recovery on the stored grid, not a painted orientation"* asserted that it
does. Both were wrong. Injectivity asks whether one shape stands at two
enrolled codes of one font. The reflected glyph stands at one code holding one
raster; its mirror image lives at a *different* code holding a different,
genuinely mirrored raster. Both codes are injective and both recover, one of
them as the wrong character. The docstring has been corrected in place; this
record is the correction for the commit message, which is already in history.

## The fix: per-font paint orientation

`type3FontPaintOrientation(font, ops)` returns the single sign of the
CharProc-local determinant — FontMatrix composed with the glyph's own `cm` —
that every mask-lane glyph of one embedded font agrees on, or `null` when the
font has no such agreement. The mask lane then requires a glyph's own sign to
equal its font's. A glyph that disagrees with its siblings is reflected
relative to them and falls to the placement-bearing operator digest, which is
domain-separated from every mask-keyed registry entry and so recovers nothing.

Three properties make this admissible where the rejected options were not.

1. **It is producer-independent.** The sign is only ever compared between two
   glyphs of the same embedded font. No absolute convention is asserted, so
   the dvipdfmx-shaped and Ghostscript-shaped documents that split the y-flip
   differently are unaffected — each is internally unanimous at its own sign.
   Verified on the two-producer fixture pair: one document unanimous at −1,
   the other unanimous at +1, identical keys.
2. **It requires unanimity, not a majority.** A majority is a vote an
   adversary wins by flipping more glyphs, and most legacy fonts here carry
   one to four mask glyphs, where a majority is not defined. A font that
   disagrees with itself has no convention to normalise against and gets no
   grid keys at all.
3. **It is deterministic and page-independent.** PDF.js builds
   `charProcOperatorList` eagerly from the whole `/CharProcs` dictionary when
   the font is loaded, not lazily per drawn glyph, so the answer is a property
   of the font rather than of which page was extracted first. Confirmed
   against the pinned pdfjs-dist 5.4.624 source.

## Measurement

**No real font mixes signs.** Census of the CharProc-local determinant sign of
every mask-lane glyph, per embedded font:

| Document | Type-3 fonts | unanimous | mixed | font sign |
| --- | ---: | ---: | ---: | --- |
| `shannon-entropy.pdf` | 24 | 24 | **0** | all −1 |
| `astro-ph-9402001.pdf` | 22 | 22 | **0** | all −1 |
| `m3.pdf` | 20 | 20 | **0** | all +1 |
| `nfscircuit.pdf` | 12 | 12 | **0** | all +1 |
| `pippenger.pdf` | 22 | 22 | **0** | all +1 |
| `sf.pdf` | 16 | 16 | **0** | all +1 |
| two-producer fixture, dvipdfmx idiom | 1 | 1 | 0 | +1 |
| two-producer fixture, Ghostscript idiom | 1 | 1 | 0 | −1 |

116 embedded Type-3 fonts across the reference document and the full legacy
corpus; not one is mixed. Both signs occur across documents, which is why the
absolute sign cannot be keyed on and the intra-font comparison can.

Mirroring the single CMEX `cm` above makes exactly one font mixed — `g_d0_f10`,
1 glyph at +1 against 15 at −1 — and no other.

**Effect on real output: none.**

- Shannon strict recovery is **1,872**, with a per-registry-id map identical
  to the pre-fix branch, checked key by key.
- Legacy corpus recovery is **0**, unchanged, with its baseline untouched.
- The layout occurrence oracle regenerates with every measured case
  byte-identical; only its provenance block moves, recording the new
  `server/layout-extraction.js` digest.

**Effect on the attack.** The tampered font abstains entirely: 1,872 → 1,775.
The eleven wrong `]` characters are gone, and so are the other 86 recoveries
from the font that was tampered with — a font with no internal paint
convention is not trusted for any of its glyphs.

## Accepted residual

This does not detect a document in which **every** glyph of a font is
reflected. Such a font is internally unanimous and is indistinguishable from
an honest font by a different producer, which is precisely the ambiguity the
producer-independent key accepts by design; a whole-font flip is also a
different rendered document, not a targeted substitution of one character. A
targeted substitution — one glyph reflected among upright siblings — is what
the registry-mirror structure makes exploitable, and that is what is now
refused.

## Binding

`test/read-pdf-layout.test.js`, describe *"one font, one glyph reflected
relative to its siblings"*. Two PDFs are built from the same eight mask bytes
in a two-glyph Type-3 font, differing only in whether the second glyph's `cm`
is reflected.

- *"keys both glyphs on the grid when the font agrees with itself"* — the
  unanimous font resolves a sign, both glyphs reach the mask lane, and the two
  identical grids key identically. This is the producer-independent behaviour,
  asserted so the fix cannot be over-applied.
- *"refuses the grid key to a whole font that disagrees with itself"* — first
  asserts that the reflected glyph, keyed on its **own** sign, still collides
  exactly with the upright glyph's key. That is the defect, reproduced inside
  the test, so the test cannot pass vacuously. It then asserts the font
  resolves no orientation and that neither glyph is grid-keyed.

Both were verified to go red by deleting the safeguard, in each of its two
halves independently:

| Deletion | Result |
| --- | --- |
| Mask lane stops consulting `fontPaintOrientation` | 1 failed |
| `type3FontPaintOrientation` stops requiring unanimity | 1 failed |

## Reproducing

The safeguard's own tests need nothing external:

```bash
npx vitest run test/read-pdf-layout.test.js -t "reflected relative"
```

The reference-document measurement needs the licensed source and the
mutation, which is a one-line edit to a single CharProc stream: decompress
`shannon-entropy.pdf`, find the CharProc named `/#2303` in the `/CharProcs` of
font `23 0 R`, replace its `17 0 0 98 1.1 -95.1 cm` with
`-17 0 0 98 18.1 -95.1 cm`, leave every byte after `ID` untouched, and rewrite
the stream uncompressed with a corrected `/Length`. Then:

```bash
PDF_TOOLS_SHANNON_SOURCE=/path/to/shannon-entropy.pdf \
  npx vitest run test/shannon-type3-live.test.js
```

Recovery counts for the mutated document are read off
`extract_layout_for_markdown` over pages 1-55, summing `glyph_recoveries` per
`registry_id`, which is the same traversal `test/shannon-type3-live.test.js`
performs.
