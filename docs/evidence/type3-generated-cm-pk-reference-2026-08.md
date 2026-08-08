# Generated Computer Modern PK ground truth — 2026-08

## Outcome

Type-3 bitmap recovery had one source of enrolled shapes: rasters read off the
Shannon reference document and reviewed by a human. That is sound evidence and
it is evidence about one document. Any other dvips-era PDF matched nothing,
because it rasterised Computer Modern at its own resolution and device
setting.

There is now a second source. `scripts/generate-type3-cm-pk-reference.mjs`
runs METAFONT over the pinned CTAN `cm/mf.zip` at pinned rasterisation
settings, converts with `gftopk`, decodes the PK bitmaps in-repo and keys each
glyph with the shipped Type-3 mask-lane key. The result is a digest table,
`server/type3-cm-pk-reference.js`, enrolled under its own qualification string
**`ctan-cm-metafont-generated-pk-v1`**. It is a different class of evidence
from the reviewed lane: nobody looked at a picture, and the whole chain from
archive digest to emitted digest is recorded and reproducible.

| Metric | Before | After |
| --- | ---: | ---: |
| Enrollment lanes | 1 reviewed | 1 reviewed + 1 generated |
| Enrolled mask digests from generated ground truth | 0 | 470 |
| Generated enrollment records built at load | 0 | 6,308 (5,912 `solo` + 396 `duo`) |
| Shannon strictly recovered occurrences | 1,872 | 1,872 |
| astro-ph-9402001 strictly recovered occurrences | **0** | **11** |
| Legacy corpus strictly recovered occurrences | **0** | **11** |
| Reviewed mask-lane digests independently reproduced | n/a | 48 of 69 |

Shannon is unchanged, deliberately and by construction — see "Why Shannon does
not move". astro-ph-9402001 recovers for the first time.

## What the reference is

152 METAFONT runs: all 76 Computer Modern faces in the pinned archive, at each
of two settings. Faces outside the three families the recovery path supports
(`cmmi*`/`cmmib*`, `cmsy*`/`cmbsy*`, `cmex*`) are still built, so the run
proves the whole archive rasterises, but only the 17 math faces contribute
digests. 34 face records, 470 digests — every one of the 41 officially
enrolled slots of every math face, at both settings. Total run time about 19
seconds; the shipped table is 39 KB and the runtime gains no dependency.

`MFINPUTS`, not `TEXINPUTS`. METAFONT resolves `input cmr10` through MFINPUTS.
Setting TEXINPUTS instead leaves MFINPUTS at its default, TeX Live's own
bundled Computer Modern sources get used, and the run silently produces
digests that are not the pinned archive's.

## What is pinned

A METAFONT raster is decided by the resolution and by three device parameters:
`blacker`, `fillin`, `o_correction`. Documents record none of them. They are
recoverable by exhaustive search rather than by reading them out of the file:
`modes.mf` defines only 83 distinct triples, and a candidate is accepted only
when its output is **bit-identical** to a real document's raster under the
shipped mask key. No similarity score is used anywhere, at any stage. Two
settings pass:

| Profile | Resolution | `blacker` | `fillin` | `o_correction` | Equivalent `modes.mf` name | Exact-reproduction evidence |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| `600-b25-f0-o1` | 600 | .25 | 0 | 1 | `ljfour` | Shannon's own rasters |
| `300-b0-f20-o60` | 300 | 0 | .2 | .6 | `cx` | astro-ph's own rasters |

**The pin is the four numbers, not the mode name.** Mode names live in
`modes.mf`, a TeX Live component this repository does not pin and whose
contents change between releases. The generator proves the name is only a
label: it builds `cmmi10` from two unrelated base modes with the same four
overrides and fails the whole run unless the decoded rasters are identical.
Both proof digests are recorded in the provenance. They cover the decoded
rasters rather than the font files, because METAFONT stamps the run clock into
the generic font and a file digest would differ on every run — which would
also have made this comparison flaky across a second boundary.

`test/fixtures/eval/extraction/type3-cm-pk-reference.provenance.json` records
the METAFONT banner (`Metafont 2.71828182 (TeX Live 2026/Homebrew)`), the
GFtoPK banner (`GFtoPK 2.4`), the `cm/mf.zip` SHA-256, a source SHA-256 for
each of the 76 faces, the four numbers per profile, the mode-independence
proof, and the emitted digest count. `test/type3-recovery-gate.test.js` binds
the module and its share copy to that record by digest.

## Raster coverage of the pinned settings

How much of a real document's Type-3 bitmap content the pinned settings
reproduce **exactly**, measured over every distinct mask a document draws
against the full 76-face rasterisation. This measures the parameter pin, not
recovery: it is the answer to "did we find the setting this document was
rasterised at", and it is why finishing the face set mattered.

| Document | Setting | Distinct masks | Exact matches, 41 faces | Exact matches, all 76 faces |
| --- | --- | ---: | ---: | ---: |
| Shannon | 600 dpi, (.25, 0, 1) | 3,171 | 2,623 (82.7%) | **2,699 (85.1%)** |
| astro-ph-9402001 | 300 dpi, (0, .2, .6) | 11,439 | 5,645 (49.3%) | **5,852 (51.2%)** |

Completing the face set added 76 Shannon masks and 207 astro-ph masks. The
gain is modest because the faces the earlier partial set omitted are mostly
typewriter, sans and fibonacci variants that these two documents barely use;
the point of generating all 76 is that the set is now closed and a document
using any Computer Modern face is measured rather than silently unmatched.

Two cautions about reading this table. First, these are raw mask-slot figures
over all 128 slots of all 76 faces (16,461 and 16,075 reference digests
respectively) — the shipped table keeps only the 470 digests at officially
enrolled slots of the 17 math faces, because those are the only slots that
have a reviewed Unicode mapping to recover *to*. Second, the shortfall is not
noise: Shannon's remaining 472 masks are its magnified font instances, which
need resolutions this revision does not pin.

## Independent corroboration and false-positive surface

Two measurements, both on the shipped table:

- **48 of the 69 mask-lane (family, slot, digest) triples the reviewed lane
  holds are reproduced bit for bit**, by a generator that never saw them. The
  other 21 are Shannon's magnified font instances. Sweeping 500, 657, 720, 864
  and 1037 dpi at the same three scalars reproduces 5 more, so extra pinned
  resolutions are the obvious next increment and each would carry the same
  exact-reproduction justification. The 70th reviewed entry,
  `cmsy-ctan-type3-minus-v1`, is an outline program on the exact-operator lane
  and can never be reproduced from a PK raster.
- **No digest in the table stands for two characters of the same family.** Of
  447 distinct digests, exactly 8 stand in two families at once, and all 8 are
  the already-documented math-italic `.` against math-symbol `⋅` pair. That is
  harmless: the matcher pins the family from the TFM fingerprint before it
  looks at a shape at all. The generator removes any digest that would stand
  at two slots of one family; on this table that count is zero, and the
  removal is recorded in the provenance so a future widening cannot hide one.
- **No record rests on featureless rectangles alone.** 20 of the 447 distinct
  digests are solid filled rectangles: Computer Modern's math minus at cmsy
  code 0 and its vertical bar at code 106, at ten pixel sizes each. A solid
  rectangle's digest is decided entirely by two integers, so it is not shape
  evidence — any producer drawing a rule of that size produces it. Eleven face
  records key both and nothing else a heavily subsetted font would need, and
  the first construction emitted 22 `solo` records from them whose whole case
  was "a solid block corroborated by another solid block". A Ghostscript-
  synthesised rule font would have been transcribed as `−` and `|` with no gap
  reported. `server/layout-extraction.js` now refuses any record whose own
  raster and every witness are rectangles, using the per-face `solid` census
  the generator measures on the raster it hashes. The rule is stated over the
  whole evidence set rather than over the witnesses alone, because the
  question is whether the case reduces to integers, not which slot the shape
  sits in. It costs exactly those 22 records and keeps astro-ph's 11
  recoveries: that document's minus IS an 18x2 solid bar, but its witness at
  code 48 is a 7x15 diagonal prime stroke.

Only unflipped rasters are enrolled. A vertically mirrored variant of every
glyph was measured against both Shannon and astro-ph: across 14,610 mask
slots it produced **zero** matches that the unflipped variant did not already
produce, so enrolling it would double the false-positive surface for no
measured gain. Reflection is separately policed by the per-font paint
orientation rule, which is unchanged.

## Why the expansion cannot cost a recovery

`matchingRegistryEntries` drops a code that two entries both match, so a
careless expansion would **delete** recoveries rather than add them. Two
entries can only both match a code if they carry the same `glyph_sha256`,
because each is compared against the single digest the font has there. Three
construction rules follow:

1. A generated record is skipped outright where the reviewed lane already
   holds the same (family, slot, digest). That is the only way the two lanes
   could collide, so the reviewed lane keeps every recovery it has, unchanged
   and under its own qualification.
2. The `solo` shape declares `complete_font_enrollment: [slot, witness]` and
   fires only for a font drawing exactly those two enrolled slots. Two solos
   demand different complete footprints; a solo and a two-witness `duo` are
   exclusive because a duo needs three enrolled slots present. Solo records
   are what recover a heavily subsetted dvips font, which is the common case.
3. The `duo` shape is emitted only where its (family, slot, digest) occurs in
   exactly one generated face, so two duos can never pick different witnesses
   for the same shape.

`test/type3-recovery-gate.test.js` asserts the resulting mutual-exclusion
property **pairwise over the whole shipped registry**, reviewed and generated
together, from the entries actually built rather than from a restatement of
this argument. Writing that check found a real hole: two long-standing
reviewed entries, `cmmi-pk-raster-period-v1` and
`cmmi-pk-raster-period-bd8a8b-v1`, share a slot and a digest and are separated
only by disagreeing witness digests. The predicate now states that case
explicitly instead of assuming footprints are the only separator.

## Safeguards, all kept

Nothing was loosened. Within-font shape-code injectivity, per-font orientation
unanimity, positive-width pinning, whole-page link competition, the
two-independent-glyph rule, the `/ToUnicode` deferral and the ±0.5
`metricScaleInterval` all apply to generated records exactly as they do to
reviewed ones.

**Positive-width pinning deserves its own note**, because this lane is
orthogonal to metrics: a PK raster is pure shape, and the generated reference
carries no widths at all. The question is whether the pin should still apply.
It should, and the reason is that the pin is not about the reference. It ties
a recovered slot to the same positive advance the TFM fingerprint used to
choose the family in the first place; without it a zero-advance slot could
recover inside a font whose family was fingerprinted entirely from other
slots, and the whole lane is conditional on that family being right. Stronger
shape evidence is a reason to trust the shape, not a reason to stop requiring
the metric. Both astro-ph slots that recover here carry positive declared
widths (26 and 10), so the pin costs nothing on the one document it could
have.

## Why Shannon does not move

Shannon's reviewed enrollment already covers **100% of its officially
Unicode-mapped occurrences**: all 70 named glyph groups, 1,883 occurrences,
carry registry evidence today. 1,872 of those recover strictly; the other 11
fail on text binding, not on evidence. There is therefore nothing for a
second evidence lane to add, and the measured result is exactly that — every
one of the 70 registry identifiers keeps its exact count and the coverage
object is byte-identical before and after.

Shannon's remaining unrecovered Type-3 content is bounded by enrollment, not
by shapes: 166 occurrences sit at Computer Modern slots with no reviewed
Unicode mapping (cmmi 12, 13, 60, 62, 96; cmsy 2, 28, 54; cmex 12, 35, 46,
104, 105, 112), and 2,388 sit in fonts that resolve no supported family at
all. Widening `CM_CODEPOINTS`, and widening the supported family set beyond
the three math families, are the levers there. Both are decisions about
Unicode mappings and metric fingerprints rather than about this reference,
which already holds all 128 slots of every face it rasterised and emits only
the 41 the enrolment admits.

## astro-ph-9402001

The one legacy-corpus document that moves. Its Type-3 font `247 0 R` carries
no `/ToUnicode`, fingerprints `computer-modern-math-symbol`, and draws exactly
two officially enrolled slots: code 0 with positive width 26 and code 48 with
positive width 10. Both digests are bit-identical to **cmsy7 at 300 dpi with
(0, .2, .6)**. The `solo` record
`cmsy7-300-b0-f20-o60-pk-c0-solo-w48-v1` therefore matches, and all 11
occurrences of the math minus recover as U+2212.

Its ceiling is now the `/ToUnicode` deferral, not the reference. 18 of its 22
Type-3 fonts carry a producer-supplied `/ToUnicode` and are deliberately left
to PDF.js; only 4 are link candidates and exactly one fingerprints a Computer
Modern family. The remaining 100,070 occurrences are behind that decision, and
no amount of additional reference coverage moves them.

The four GNU Ghostscript 6.52 papers stay at zero and are out of scope for
this lane. That producer re-rasterised from Type 1 outlines rather than
passing dvips PK through — 253 of pippenger's 584 decodable single-mask glyph
programs carry a blank outer edge, against 0 of astro-ph's 588, 0 of the
Shannon document's 125 and 0 of the 4,352 rasters this reference decodes.
GFtoPK writes each character's ink box as its bounding box, so its output is
tight on all four sides; the padding is the producer's, not something the PK
container forbids. On top of that the ink runs
one to three pixels wider than the Computer Modern design. Behind that sits
the glyph-cache-page category error recorded in
`docs/evidence/legacy-tex-metric-routes-closed-2026-08.md`, which has no
answer at all.

## Reproducing

```bash
# Requires METAFONT and gftopk on PATH (TeX Live).
node scripts/generate-type3-cm-pk-reference.mjs

# Live oracles.
PDF_TOOLS_SHANNON_SOURCE=/path/to/shannon-entropy.pdf \
  npx vitest run test/shannon-type3-live.test.js
PDF_TOOLS_LEGACY_CORPUS_DIR=/path/to/legacy-tex-corpus \
  npx vitest run test/legacy-tex-corpus-live.test.js

# Per-document census.
node scripts/inventory-type3-glyphs.mjs --source /path/to/astro-ph-9402001.pdf
```

The generator is idempotent: rerunning it on the same toolchain rewrites the
same bytes, and the provenance record is what a reviewer diffs.

## Known gaps

- Two pinned resolutions. 500, 657, 720, 864 and 1037 dpi at the same three
  scalars each reproduce Shannon rasters exactly and are the obvious next
  increment; they are not pinned yet because nothing measured needs them.
- 41 enrolled slots. METAFONT emitted 128 slots per face and the table keeps
  only the enrolled ones. Widening the enrolment is a separate reviewed
  decision about Unicode mappings.
- Three families. Roman text faces (`cmr*`, `cmbx*`, `cmti*`, …) have no
  entry in the family fingerprint, so their rasters are generated and then
  discarded. That is where the bulk of both documents' unrecovered Type-3
  content sits.
- Generated records do not opt into the collapsed-whitespace binding. Exactly
  one enrolled slot has a whitespace source scalar — math-italic 11, alpha,
  whose TeX code is a vertical tab — and the reviewed lane sets
  `allow_collapsed_whitespace` there because a reviewer confirmed PDF.js
  collapses it. Generated records leave it off, so a future document whose
  alpha is collapsed into a whitespace text item will not bind through this
  lane. No measured document needs it: Shannon's alphas are covered by the
  reviewed lane and astro-ph draws none. Turning it on is a one-line,
  deterministic change once a document justifies it.
- Nothing here is OCR. No recognition of any kind takes place: a digest either
  matches exactly or the pipeline abstains.
