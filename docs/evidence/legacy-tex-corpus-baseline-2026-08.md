# Legacy dvips-era Type-3 corpus — failing baseline, 2026-08

## Outcome

**This is still a failing baseline. Four of its five recovery figures are
zero, and every zero is a defect, not an intention.**

The Computer Modern Type-3 recovery that works on Shannon's 1948 paper does
not transfer. Five dvips-era PDFs carrying 385,766 Type-3 glyph occurrences
recover **11 characters** between them, all of them in one document. This
document binds them as a pinned, measured corpus so the gap has an executable
size instead of an anecdote, and so any later work has something it must
visibly move.

Four of the five are D. J. Bernstein papers from cr.yp.to, produced by
`GNU Ghostscript 6.52`, which repacks glyph names to `/a0 /a1 /a2…`. On these
`pdftotext` yields literal noise and PDF Tools recovers nothing — not one
character, and only one Computer Modern family across all four. The fifth is
an arXiv paper where the TeX character codes *are* preserved, and it is the
one that moved: its 11 officially mapped occurrences now recover, against the
generated Computer Modern PK reference described below.

Nothing in the recovery path was weakened to produce this record. The corpus
is measured through the shipped code exactly as it stands.

**Revision note.** The first version of this document was written before the
linker fix and before the recovery key was moved off the CharProc operator
list, and its measured table and causal account were both left stale by those
two changes. The table below and the section that follows it now match the
shipped product.

**Revision note, generated PK reference.** Obstacle 3 below — "the rasters
themselves do not match" — has since been closed for astro-ph. The missing
external labelled bitmap reference now exists: `server/type3-cm-pk-reference.js`,
built by `scripts/generate-type3-cm-pk-reference.mjs` from the pinned CTAN
`cm/mf.zip` through METAFONT and `gftopk`, enrolled under its own
qualification string `ctan-cm-metafont-generated-pk-v1`. astro-ph went from 0
to 11 strictly recovered occurrences. The four Ghostscript 6.52 papers are
unaffected and are expected to stay at zero; see "Why the generated reference
does not reach the four Ghostscript 6.52 papers".

**Route status.** Both routes past this baseline have since been investigated
to a conclusion and both are closed. Shape-to-family is ill-posed — recorded
below under "The shape-keyed family identification dead end". Every
metric-derived route is closed too, including the reconstruct-the-advance-from-
the-spacer route that this document's obstacle 2 left open in principle: see
`docs/evidence/legacy-tex-metric-routes-closed-2026-08.md`. Read that record
before attempting anything on the four Ghostscript 6.52 papers. It does not
soften the zeros here; it establishes that they are a property of what that
producer emitted.

## The corpus

The documents are third-party and are deliberately **not** committed to this
repository. They are fetched to a scratch directory and bound by digest.

| Document | URL | SHA-256 | Producer | Creator |
| --- | --- | --- | --- | --- |
| `pippenger.pdf` | https://cr.yp.to/papers/pippenger.pdf | `ec45c2193abf5acfb5adaaf71c4b4f7b487d90b21f80b7b6d48fd51fd655ccae` | `GNU Ghostscript 6.52` | *(absent)* |
| `nfscircuit.pdf` | https://cr.yp.to/papers/nfscircuit.pdf | `eee46391621b5d5d2de5de93e7c34217c5c8a6b2db517a682e52d6fb336f6f46` | `GNU Ghostscript 6.52` | *(absent)* |
| `m3.pdf` | https://cr.yp.to/papers/m3.pdf | `988189c6600a24b242c39cd617ea13307e2c3f9880bbafd4914c33ae20be5fc5` | `GNU Ghostscript 6.52` | *(absent)* |
| `sf.pdf` | https://cr.yp.to/papers/sf.pdf | `5a094ee9709d51817b1184e9c01e2e3acf9e3fdc0153a5d876c9cbb138cf34d9` | `GNU Ghostscript 6.52` | *(absent)* |
| `astro-ph-9402001.pdf` | https://arxiv.org/pdf/astro-ph/9402001 | `eb0f80aea9c3c359e3826866a9c8128d41862937f5002dbd016a6f6adbbc0041` | `GPL Ghostscript GIT PRERELEASE 9.22` | `dvips 5.518` |

## Measured baseline

Occurrence and coverage figures come from `inspectType3GlyphEvidenceForPage`
through `scripts/inventory-type3-glyphs.mjs`, the same census path
`test/type3-glyph-inventory.test.js` already uses. Font figures are a
document-level census of every Type-3 font dictionary reachable from a page's
`/Resources /Font`, deduplicated by indirect reference, asked of the shipped
`uniqueComputerModernFamily` resolver over its positive-width slots.

Every figure below is the `measured` object a real run printed, and is the
same object `test/legacy-tex-corpus-live.test.js` asserts. Nothing here is
typed by hand on both sides of an assertion.

| Metric | pippenger | nfscircuit | m3 | sf | astro-ph-9402001 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Pages | 21 | 11 | 19 | 15 | 37 |
| Bytes | 292,684 | 186,703 | 276,417 | 268,946 | 929,486 |
| Type-3 fonts | 22 | 12 | 20 | 16 | 22 |
| — admissible to the font linker | 19 | 10 | 18 | 15 | 4 |
| — resolving a Computer Modern family | 0 | 0 | 0 | **1** | **10** |
| Observed Type-3 occurrences | 78,175 | 40,704 | 92,502 | 74,271 | 100,114 |
| Linked to a raw Type-3 font | **5,440** | **7,484** | **17,335** | **22,234** | 44 |
| Omitted, unlinked | 72,735 | 33,220 | 75,167 | 52,037 | 100,070 |
| Classified into a family | 0 | 0 | 0 | **10** | 12 |
| Officially Unicode-mapped | 0 | 0 | 0 | **2** | 11 |
| Matching a registry digest | 0 | 0 | 0 | 0 | **11** |
| **Strictly recovered** | **0** | **0** | **0** | **0** | **11** |

Corpus totals: 385,766 observed Type-3 glyph occurrences, 92 Type-3 fonts,
52,537 linked occurrences, 22 classified, 13 officially Unicode-mapped, and
**11 recovered characters**. The single abstention reason reported for every
document is `raw_type3_font_link_ambiguous_or_unavailable`.

## Why nothing recovers

Two of the three original causes have been removed, and the table above
records what removing them bought. Neither bought a single character.

**Fixed: a zero-width slot no longer voids the whole font.** `rawType3Fonts`
used to build one width map with `if (width > 0) widths.set(code, width)`,
and `linkedRawType3Font` then demanded `raw.widths.get(code) === width` for
every code the page drew — including the zero-width ones, where the lookup
returned `undefined`. One drawn zero-width glyph eliminated every candidate
and abstained the entire font, and every Type-3 font in all four Ghostscript
6.52 papers declares at least one zero-width slot. There are now two width
views: `widths` keeps every declared slot for the linker, because a declared
zero is a fact about the font, and `metricWidths` keeps only the positive
slots for the TFM fingerprint, because `metricScaleInterval` cannot fit a
scale to an observed zero. The four papers went from 0 linked occurrences to
5,440 / 7,484 / 17,335 / 22,234.

**Fixed: the key no longer folds in the producer's idiom.** The recovery key
used to be the CharProc operator list, which carries the producer's operator
idiom and the per-glyph placement `cm`. It is now the decoded image mask's
stored sample grid, cropped to its ink, so the same raster keys identically
across toolchains. This is what let `sf` classify 10 occurrences and
officially name 2.

**Still open, and why every figure above is still zero.** Three obstacles
remain, and they are not the same obstacle for the two producers.

1. *Family resolution does not survive glyph repacking.*
   `uniqueComputerModernFamily` matches declared widths against TFM widths
   slot for slot, and Ghostscript 6.52 has renumbered the codes. Across the
   four Bernstein papers exactly one font — in `sf.pdf` — fingerprints a
   family at all, off just two spacer advances, and the two occurrences it
   officially names mean nothing. Only the missing shape match keeps that
   coincidence out of the output.

2. *Positive-width pinning rejects the Bernstein papers by construction.*
   Ghostscript 6.52 splits every character into two Type-3 glyphs: an inked
   glyph declaring `0 0 llx lly urx ury d1` with advance zero, and a separate
   ink-free advance glyph declaring `w 0 0 0 0 0 d1`. Read straight out of the
   bytes the split is total — 584 / 457 / 537 / 530 inked CharProcs, every one
   of them zero advance, against 98 / 99 / 102 / 106 advance-only CharProcs,
   no exceptions. The inked codes and the positive-width codes are disjoint
   sets, so a recovered code can never be an inked code in these four
   documents, and the family fingerprint can only ever see spacer advances at
   renumbered codes. This is a safeguard doing its job, not a bug: a code with
   no advance is invisible to the fingerprint that qualified the family.

   The obvious follow-up — recover each inked glyph's advance from the spacer
   that follows it, then fingerprint as usual — was investigated and is closed.
   The spacer carries an inter-glyph *displacement*, not an advance, and it is
   not a function of the inked glyph: in one fourteen-glyph show operation of
   `pippenger.pdf` the letter `t` takes displacements 33, 54, 29 and 30. Worse,
   the font object being fingerprinted is not a TeX font at all but a glyph
   cache page holding 171 / 168 / 168 / 164 inked glyphs, more than the 128
   slots any Computer Modern font has, so no font-level identification of any
   kind can work here. Full measurements in
   `docs/evidence/legacy-tex-metric-routes-closed-2026-08.md`.

3. *The rasters themselves did not match — CLOSED for astro-ph.*
   `astro-ph-9402001.pdf` is the clean case — codes preserved, 10 fonts
   fingerprinting a family, 11 occurrences officially Unicode-mapped — and it
   used to match 0 registry digests, because it rasterised Computer Modern at
   its own PK resolution (300 dpi against Shannon's 600) and no enrolled shape
   was that shape. The generated reference supplies that shape and all 11
   recover. Its remaining
   18 of 22 fonts carry their own `/ToUnicode` and are deliberately left to
   PDF.js, which is why only 4 fonts are admissible to the linker while 10
   fingerprint a family. Those 18 are not discarded: they stay in the page's
   link-uniqueness pool as competitors, so a font matching both them and a
   recoverable font is reported ambiguous rather than resolved in favour of
   recovery.

## The shape-keyed family identification dead end

Identifying the family from matched glyph *shapes*, rather than from
`widths[code]`, was the obvious way past obstacle 1. It was investigated and
measured to be a dead end. Recorded here so it is not attempted again blind.
All four findings are measured on these exact documents.

- **There was no bitmap reference to match against — now there is.** The
  pinned official CTAN `cm/ps-type3` fonts are cubic-Bézier *outline*
  programs: all 41 glyph programs of the labeled reference fixture take the
  exact-operator evidence lane and none takes the image-mask lane. `cm/mf.zip`
  is METAFONT source, and turning it into the PK rasters these documents carry
  needs a METAFONT run at a resolution and device setting no document here
  records. What was missing was the setting, not the capability, and the
  setting is findable by exhaustive search rather than by reading it out of
  the file. See "The generated Computer Modern PK reference" below. This does
  not reopen the next three findings: nothing in the generated reference is
  scored for similarity, and it does not identify a family from shapes.
- **Bridging outline to bitmap is never exact, and no threshold separates
  right from wrong.** Rasterising the official CTAN outline for cmmi alpha
  across 225,225 combinations of resolution (60–110 px/em in 0.05 steps),
  alpha threshold and sub-pixel offset reproduced the Shannon reviewed alpha
  raster's ink box 241 times and its bits **zero** times; the closest was 72
  of 1,748 pixels wrong, 4.1%. Scored against three Shannon rasters of known
  identity over every reference slot that could reproduce the target's ink
  box, the correct slot's best agreement was 4.3% wrong for alpha, 2.1% for
  omega and 14.5% for sigma, while the best *wrong* slot reached 20.1% for
  alpha and 24.5% for sigma. A threshold would have to admit 14.5% and reject
  20.1% — a 1.4x window, already that narrow against a reference holding 41 of
  Computer Modern's roughly 9,600 (font, slot) pairs. Widening the reference
  can only close it further.
- **An exact matcher would still not determine a family.** One digest in the
  shipped registry already stands at two different (family, slot) pairs: the
  same bitmap is `cmmi-pk-raster-period-2df559-v1` (math-italic slot 58, ".")
  and `cmsy-pk-raster-centered-dot-33077f-v1` (math-symbol slot 1, "⋅"). Shape
  identifies a code only once the family is known, which is the direction the
  shipped matcher already runs in and the opposite of the direction proposed.
- **There is no cross-document anchor either.** The mask key is genuinely
  producer-independent — the four cr.yp.to papers share 387 to 440 of their
  451 to 581 distinct inked shapes with each other, being one PK library at
  720 dpi — but they share exactly **one** shape with Shannon (600 dpi) and
  **none** with astro-ph (300 dpi), and that one shared shape is a 41x3 solid
  rectangle, a fraction rule rather than a character.

With the metric routes closed as well, the last theoretical route to the four
Ghostscript 6.52 papers was an external labelled bitmap reference. That
reference has since been built, and it does not reach them either; the reason
is below.

## The generated Computer Modern PK reference

`scripts/generate-type3-cm-pk-reference.mjs` downloads the pinned CTAN
`cm/mf.zip`, verifies its SHA-256, points **`MFINPUTS`** (not `TEXINPUTS`, or
METAFONT silently uses TeX Live's own Computer Modern sources) at the extracted
archive, runs METAFONT over all 76 Computer Modern faces at each pinned
setting, converts with `gftopk`, decodes the PK bitmaps in-repo, and keys each
glyph with the shipped Type-3 mask-lane key. It ships a digest table,
`server/type3-cm-pk-reference.js`, never bitmaps, and the runtime gains no new
dependency: generation is maintainer-side.

**What is pinned is four numbers per setting, not a mode name.** A METAFONT
raster is decided by the resolution and by `blacker`, `fillin` and
`o_correction`. Mode names are entries in `modes.mf`, a TeX Live component
this repository does not pin; the numbers are what METAFONT consumes. There
are only 83 distinct triples in all of `modes.mf`, so the setting a document
used is recoverable by sweeping them and keeping only those whose output is
**bit-identical** to the document's own rasters under the shipped key. Two
settings pass:

| Setting | Resolution | `blacker` | `fillin` | `o_correction` | Equivalent `modes.mf` name | Exact-reproduction evidence |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| `600-b25-f0-o1` | 600 | .25 | 0 | 1 | `ljfour` | Shannon's own rasters |
| `300-b0-f20-o60` | 300 | 0 | .2 | .6 | `cx` | astro-ph's own rasters |

The generator proves the mode name is only a label: it builds `cmmi10` from
two unrelated base modes with the same four overrides and fails the run unless
the decoded rasters are identical. It compares decoded rasters rather than
font files because METAFONT stamps the run clock into the generic font, so a
byte comparison would differ on every run and would fail spuriously across a
second boundary. Both digests are recorded in
`test/fixtures/eval/extraction/type3-cm-pk-reference.provenance.json`, along
with the METAFONT and GFtoPK banners, the archive digest, a per-face source
digest for all 76 faces, and the emitted digest count.

**Scale and safety.** 152 rasterisations produce 470 enrolled digests across
34 face records — every one of the 41 officially enrolled slots of all 17
Computer Modern math faces, at both settings. Two independent checks:

- The reference reproduces **48 of the 69** mask-lane (family, slot, digest)
  triples the reviewed lane holds, bit for bit, having never seen them. The
  other 21 are Shannon's magnified font instances; sweeping 500, 657, 720, 864
  and 1037 dpi at the same three scalars reproduces 5 more, so additional
  pinned resolutions are the obvious next increment and each would carry the
  same exact-reproduction justification. The 70th reviewed entry,
  `cmsy-ctan-type3-minus-v1`, is an outline program on the exact-operator lane
  and can never be reproduced from a PK raster.
- Not one of the reference's 447 distinct digests stands at two different
  slots of the same family. Eight stand in two families at once, and all eight
  are the math-italic "." against math-symbol "⋅" pair the third finding above
  already names, which is harmless because the matcher pins the family from
  the TFM fingerprint before it looks at a shape at all.

**Why it cannot cost a recovery.** `matchingRegistryEntries` drops a code that
two entries both match, so a careless expansion would delete recoveries rather
than add them. Two entries can only both match a code if they carry the same
`glyph_sha256`. Generated entries therefore (a) yield outright wherever the
reviewed lane already holds the same (family, slot, digest), (b) use a
`complete_font_enrollment` footprint of exactly two slots for the
heavily-subsetted case, so two of them demand incompatible footprints, and
(c) emit the two-witness form only where the (family, slot, digest) occurs in
exactly one generated face. `test/type3-recovery-gate.test.js` asserts the
resulting mutual-exclusion property pairwise over the whole shipped registry,
reviewed and generated together.

**Positive-width pinning still applies to generated entries.** The generated
reference carries no metrics at all — a PK raster is pure shape — so it cannot
substitute for the pin, and the pin's purpose is unchanged: it ties a
recovered slot to the same positive advance that the TFM fingerprint used to
choose the family in the first place. Dropping it for this lane would let a
zero-advance slot recover inside a font whose family was fingerprinted
entirely from other slots. The stronger shape evidence is a reason to trust
the shape, not a reason to stop requiring the metric.

## Why the generated reference does not reach the four Ghostscript 6.52 papers

It was never going to, and the reason is visible in their bytes rather than in
the reference. GNU Ghostscript 6.52 re-rasterised these documents from Type 1
outlines instead of passing dvips PK bitmaps through: 318 of pippenger's 738
masks have a blank border, which a PK raster cannot have because PK stores the
ink box, and the ink runs one to three pixels wider than the Computer Modern
design. Behind that sits finding (g), the glyph-cache-page category error,
which has no answer at all. These four are out of scope for this lane.

## Safeguards this corpus confirms are not what blocks it

Recording these so a later attempt does not spend effort loosening a rule
that is not in its way. Each was measured against the corpus:

- **Per-font paint orientation.** A font whose mask-lane glyphs disagree on
  their CharProc-local determinant sign gets no grid keys. All 92 embedded
  Type-3 fonts of this corpus are unanimous, as are all 24 of Shannon's, so
  this rule refuses nothing here. See
  `docs/evidence/type3-reflected-paint-2026-08.md`.
- **Shape-code injectivity.** The one corpus font that reaches a registry
  digest draws two enrolled slots with two different shapes, so no match is
  lost to a shape standing at two enrolled codes. Three of the four
  Ghostscript 6.52 papers reach no digest at all.
- **The `/ToUnicode` deferral.** This IS what now bounds astro-ph, and it is a
  safeguard rather than a gap. 18 of its 22 Type-3 fonts carry a producer-
  supplied `/ToUnicode`; PDF Tools leaves those to PDF.js rather than
  overriding a valid mapping. Only 4 fonts are link candidates, exactly one of
  them fingerprints a Computer Modern family, and that font accounts for all
  12 classified and all 11 recovered occurrences. No amount of additional
  reference coverage moves the other 100,070 occurrences; only revisiting the
  deferral would, and that is a different decision from this one.

## Binding

`test/legacy-tex-corpus-live.test.js` binds the corpus, following
`test/shannon-type3-live.test.js`: environment-gated, source SHA-256 asserted
before anything else, then an exact assertion on observed behaviour.

- **Interface:** one directory variable, `PDF_TOOLS_LEGACY_CORPUS_DIR`, holding
  all five documents under the fixed basenames in the table above. One
  variable was chosen over five because five permit a partially configured
  run — three set, two unset — which would characterize part of the corpus and
  still report a pass. With one variable the suite is either fully skipped or
  fully measured; once the directory is given, a missing or wrong-digest
  document is a hard failure, never a skip. This was verified by pointing the
  variable at a directory holding only one of the five: five tests failed with
  `ENOENT` — the four absent documents and the corpus-level check — and none
  was reported as skipped.
- **Skips cleanly.** Unset, `npm test` reports the file as 1 skipped, 6 tests
  skipped, and stays green without the corpus present.
- **No hand-typed expectations.** Every recorded figure is the `measured`
  object a real run printed, spliced back in unedited. A previous vacuous test
  on this repository passed while both sides of its assertion were wrong.
- **Empty-measurement guard.** Each document must report a positive page
  count, at least one Type-3 font, and more than 10,000 observed occurrences
  before any zero is accepted, so a broken harness cannot satisfy the baseline
  by measuring nothing.
- **Directional assertions.** Every recovery-shaped count is fenced from both
  sides with its own message. A regression fails with "regressed below the
  recorded baseline"; an improvement fails with "improved … update the
  recorded baseline deliberately". Both directions were verified to fire by
  temporarily perturbing a recorded figure.
- **Linker regression fence.** The corpus-level test additionally asserts that
  each Ghostscript 6.52 paper still links a positive number of occurrences, so
  the zero-width linker fix cannot silently regress back to the 0/0/0/0 state
  this document originally recorded.

The suite needs no entry in `scripts/test-suite-classification.mjs`: it
allocates no checkout-local scratch and so does not reach
`test/helpers/temp-directory.js`, and it performs no computed dynamic import.
Both inventories are derived from the import graph and re-checked by
`test/test-runner-contract.test.js`, which passes unchanged.

## Reproducing

```bash
mkdir -p /tmp/legacy-tex-corpus && cd /tmp/legacy-tex-corpus
for paper in pippenger nfscircuit m3 sf; do
  curl -sL -o "$paper.pdf" "https://cr.yp.to/papers/$paper.pdf"
done
curl -sL -o astro-ph-9402001.pdf https://arxiv.org/pdf/astro-ph/9402001
shasum -a 256 *.pdf

PDF_TOOLS_LEGACY_CORPUS_DIR=/tmp/legacy-tex-corpus \
  npx vitest run test/legacy-tex-corpus-live.test.js
```

Observed: 1 file passed, 6 tests passed.

Per-document census, outside the suite:

```bash
node scripts/inventory-type3-glyphs.mjs --source /tmp/legacy-tex-corpus/pippenger.pdf
```

## Known gaps

- This is still the gap. 11 recovered characters across 385,766 legacy Type-3
  glyph occurrences is the tracked defect, and raising any figure in the
  measured-baseline table is the work this record exists to measure. For the
  four Ghostscript 6.52 papers that work has no known route; that is a finding
  about the producer, recorded in
  `docs/evidence/legacy-tex-metric-routes-closed-2026-08.md`, and not a reason
  to stop calling the zero a defect.
- astro-ph's remaining ceiling is not the reference. Its one recoverable font
  draws two enrolled slots and both now match exactly; the other 100,070
  occurrences sit behind the `/ToUnicode` deferral. Enrolling more Computer
  Modern slots or more pinned resolutions will not move them.
- The generated reference covers the 41 officially enrolled slots and no more.
  Its 470 digests are all that the current `CM_CODEPOINTS` enrolment admits,
  even though METAFONT emitted 128 slots for each of 152 rasterisations.
  Widening the enrolment is a separate, reviewed decision about Unicode
  mappings, not a property of this reference.
- Linking is not recovery. 52,537 occurrences now link where none did, and
  that bought no characters. A future change that raises the linked count
  without raising the recovered count has not moved this baseline.
- No OCR engine is bundled, and none of the above depends on one. This was
  once written here as "every glyph in this corpus is drawn by an embedded
  Type-3 font whose Computer Modern identity is recoverable from metrics and
  raster bytes alone." That is now known to be false for the four Ghostscript
  6.52 papers, and it is the single most important correction to this record:
  their Computer Modern identity is **not** derivable from the metrics and
  structure their producer wrote into the file, by any route measured. See
  `docs/evidence/legacy-tex-metric-routes-closed-2026-08.md`. It remains true
  of `astro-ph-9402001.pdf`, whose codes and metrics are intact and whose only
  obstacle is its 300 dpi rasters.
- The corpus documents are not committed. The digests above are the only
  binding; a re-fetch that produces different bytes must be treated as a
  different document, not as a changed baseline.
