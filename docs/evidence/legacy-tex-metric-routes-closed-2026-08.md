# Legacy dvips-era Type-3 corpus — every metric route closed, 2026-08

## Outcome

**Recovery on the four GNU Ghostscript 6.52 papers is zero and stays zero.
This record does not excuse that. It records why the remaining route was
closed, so the next attempt spends its effort somewhere it can work.**

`docs/evidence/legacy-tex-corpus-baseline-2026-08.md` bound the failing
baseline and closed one of the two routes past it: identifying a Computer
Modern family from matched glyph *shapes* is ill-posed, because there is no
labelled bitmap reference to match against and shape does not determine a
family even when the match is exact.

The other route was metric. `uniqueComputerModernFamily` identifies a family by
fitting one scale factor to a font's declared `/Widths`, and Ghostscript 6.52
declares zero for every inked code. If the per-character advance could be
recovered from somewhere else in the file — from the spacer glyph that follows
each inked one — the shipped fingerprint would work unchanged on renumbered
codes. That is the hypothesis this investigation tested, and it is wrong in
three independent ways, the third of which is not about advances at all.

Combined with the shape finding, **all metric-derived routes to these four
documents are closed.** This is a property of what the producer emitted, not a
limit on effort: the information the fingerprint needs is not in the file in
any form, at any tolerance, under any statistic. It is not a claim about
legacy Type-3 documents generally — the fifth corpus document, the arXiv
paper, preserves its TeX codes and fails for an entirely different reason
(its rasters, at 300 dpi, match no enrolled shape), and nothing here applies
to it.

## What was measured, and against what

- Corpus: the same five pinned documents as the baseline record, verified by
  SHA-256 before measurement. The four in scope are `pippenger.pdf`,
  `nfscircuit.pdf`, `m3.pdf` and `sf.pdf`, all `GNU Ghostscript 6.52`.
- Metrics: `CM_TFM_METRICS` from `server/type3-cm-reference.js`, the same
  pinned CTAN TFM table the shipped resolver uses, and
  `uniqueComputerModernFamily` from `server/layout-extraction.js` itself.
- Displacements are read out of the page content streams directly: for each
  inked code, the `wx` of the spacer that immediately follows it in the same
  show operation, or, where the inked glyph ends the operation and the
  operation stands alone between two moves, the `tx` of the following `Td`
  minus the spacers already consumed.

## 1. The spacer does not carry a per-character advance

The hypothesis was that Ghostscript 6.52 displaces the advance onto the
ink-free spacer glyph, so that `spacer.wx` is the missing `/Widths` entry for
the inked glyph before it. It is not. The spacer carries an inter-glyph
**displacement** — advance plus interword space plus kern plus grid rounding —
and that is not a function of the inked glyph.

**Most inked glyphs have no spacer to ask.** Of the inked occurrences, only
53.0% (pippenger), 77.4% (nfscircuit), 59.1% (m3) and 51.3% (sf) are followed
by a spacer at all. The rest end their show operation, where the displacement
has already been folded into the following `Td`: 30.1 / 20.0 / 28.2 / 46.6%
of inked occurrences are run-final. In pippenger the single commonest shape of
show operation is one inked glyph and nothing else — **7,725 of 15,010 show
operations, 51.5%** — so for over half the operations in the document there is
no spacer in the operation to attribute anything to.

**Where a spacer does follow, it is not stable per character.** The map from
inked code to spacer code is many-to-many. In pippenger, of the 333 inked
codes that ever take a spacer partner, **222 take more than one spacer code**;
in nfscircuit 238 of 323, m3 238 of 334, sf 214 of 317. Read the other way,
one spacer serves many different inked codes: 168 / 170 / 198 / 183 spacer
codes across the four documents serve more than one. Across every inked code
with any displacement data at all — 432 / 357 / 420 / 388 codes — only
109 / 98 / 101 / 103 are single-valued, and the *most common* displacement for
a code accounts for just 43.7 / 46.0 / 46.2 / 46.8% of that code's
observations. There is no modal value to take as "the" advance.

**Ground truth confirms it directly.** Page 1 of `pippenger.pdf` opens with a
readable roman line and a bold title, both drawn by font `9 0 R`, which lets
each drawn code be labelled by eye. One show operation on that page holds
fourteen inked glyphs, and the letter `t` (code 7) appears in it four times
with four different displacements — **33, 54, 29 and 30**. In the same
fourteen-glyph operation, `.` (code 8), `I` (code 10) and `w` (code 12) are
each followed by a spacer of exactly **51**, and 51 is the only displacement
either `.` or `I` is ever observed with anywhere in the document: they happen
to occur only before a word space, so what was measured is the word space, not
the letter.

A quantity that changes four times for one letter inside one line, and that
reports the same number for a period, a capital I and a `w`, is not a
character advance. This is the mechanism, and it is why every attempt below
fails: the file records where the next glyph goes, not how wide this one is.

## 2. The decisive independent test

Two blockers stand between these documents and the shipped fingerprint: the
advance is not recoverable (§1), and the codes are renumbered so even a correct
advance sits at the wrong slot. The test grants a *perfect* solution to both at
once.

The fifteen ground-truth roman characters read off page 1 were placed at their
true OT1 slots and given their best-case reconstructed advances. Against the
whole pinned `CM_TFM_METRICS` table:

| Tolerance | ±0.5 | ±1 | ±2 | ±3 | ±5 | ±8 | ±12 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Metrics fitting, min statistic | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Metrics fitting, mode statistic | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

Zero, everywhere, out to **24 times the shipped ±0.5 tolerance**. The same is
true of the fifteen ground-truth bold characters out to ±5; at ±8 thirty
metrics fit at once and at ±12 forty-four do, which is no identification at
all. Dropping the three characters that were only ever seen before a word
space admits 25 metrics at ±2 under the min statistic — obtained by discarding
evidence and widening fourfold, and still not unique.

The reason is visible in the per-character implied scale. Against `cmr10`, the
fifteen characters imply anything from **66.6 px/em** (`n`) to **183.6 px/em**
(`.`); against `cmr7`, 58.6 to 157.7. A single font cannot be drawn at two
scales at once, so no scale exists, so no metric fits. This is not a tolerance
that needs loosening. There is no signal to loosen toward.

## 3. The category error

This is the deepest finding, and it is the one that would have defeated the
other two even if they had gone the other way.

**Ghostscript 6.52 does not emit one Type-3 font per TeX font. It emits glyph
cache pages.** Every one of the four documents contains exactly one Type-3 font
— object `9 0 R` in all four — carrying **171 / 168 / 168 / 164** inked
glyphs. Every Computer Modern font has at most 128 slots. A font with 171
inked glyphs is not a Computer Modern font that has been renumbered; it is a
bucket into which several of them have been poured.

In pippenger's `9 0 R`, code 10 is the small roman `I` (mask 21x41) and code 49
is the large bold `I` (mask 39x69). Same letter, two design sizes and two
weights, one font object. The question the fingerprint asks — *what family is
this font?* — has no answer for these objects, and neither would the shape
question, and neither would any question posed at font level. No font-level
identification of any kind can work for this producer.

That is why §1 and §2 are not fixable by a better statistic. They are
measurements of a font that is not a font.

## 4. What a width-pinned prediction would actually have said

One candidate looked stable enough to be worth carrying to the end. `m3.pdf`'s
font `408 0 R` is the only object in the corpus that resolves a single family
under all three reconstruction statistics — min, mode and max — landing on
`computer-modern-math-italic`, and uniquely on `cmmi7` under min. Six other
fonts resolve under exactly one statistic and dissolve under the others.

Its fitted scale is **103.99 px/em**, which at this corpus's 720 dpi places a
**7 pt metric at 10.40 pt** — the first sign that the fit is a coincidence
rather than an identification. Seven of its codes are pinned to exactly one
`cmmi7` slot at the shipped ±0.5:

| Code | Advance | Mask | Ink band (glyph space, baseline ≈ 72) | Predicted `cmmi7` slot |
| ---: | ---: | --- | --- | --- |
| 0 | 38 | 31x48 | −10 … 38 | `l` |
| 12 | 79 | 74x71 | 4 … 75 | `psi` |
| 24 | 82 | 43x46 | 28 … 74 | `L` |
| 29 | 42 | 35x50 | 38 … 88 | `i` |
| 35 | 78 | 52x46 | 28 … 74 | `varphi` |
| 37 | 86 | 45x46 | 28 … 74 | `w` |
| 42 | 113 | 47x65 | 28 … 93 | `M` |

Rendered, they are not those characters:

- Code 24, pinned to a capital `L`, is a 43x46 mask sitting entirely between
  the x-height line and the baseline. It has no ascender. A capital cannot be
  an x-height box.
- Code 0, pinned to `l`, draws entirely **above** the baseline, in the band
  −10 to 38, in a font whose ordinary glyphs all reach down to about 72. It is
  a superscript raster, not a letter.
- Code 42, pinned to `M`, is 47 px wide against its own 113-unit advance, a
  0.42 ink-to-advance ratio, and it descends 21 units below the baseline.
  The genuine bold `M` in pippenger's `9 0 R` draws 102 px against a 109-unit
  advance — 0.94 — and has no descender.
- Code 29, pinned to `i`, sits 16 units lower than the font's own baseline
  band: a subscript.

The line this font actually helps draw, on page 4 of `m3.pdf`, is

```text
4x² + 1x³ + 5x⁴ + 9x⁵ ∈ R[x] → R[x][y]/(x²−y)
```

and it is drawn by **five different Type-3 fonts** (`408 0 R`, `304 0 R`,
`9 0 R`, `382 0 R`, `266 0 R`) — one per raster size the cache happened to
need, which is exactly the cache-page structure of §3. `408 0 R` is the
superscript-and-subscript bucket. Had the metric route been shipped, this is
the one place in the corpus it would have produced output, and the output would
have been `L`, `M`, `i`, `w`, `l`, `psi` and `varphi` in place of digits and
exponents.

The shipped pipeline abstains here. That abstention is correct, and this
section is the evidence that it is correct rather than merely cautious.

## What is left

Nothing derived from metrics. Shape does not determine a family
(`legacy-tex-corpus-baseline-2026-08.md`), width does not survive the
producer's split and renumbering (§1, §2), and the font object these documents
present is not the unit either question is asked about (§3).

The only remaining theoretical route is an **external labelled bitmap
reference**: a METAFONT run for each Computer Modern font at each document's
own mode and resolution, producing PK rasters whose bits can be compared
directly against the embedded image masks. That is unavailable and
unpinnable — no document in the corpus records the mode or the exact
resolution its rasters were built at, the toolchain that built them is not
pinned by anything in the file, and the repository has no METAFONT engine and
no reproducible way to pin one. It is recorded as the boundary of the problem,
not as planned work.

The honest summary is that these four documents are not recoverable by this
pipeline, and no measurement performed here suggests a way that they could
become recoverable. The corpus stays bound as a failing baseline, and any
future change that moves it must move `strict_recovery_count` in
`test/legacy-tex-corpus-live.test.js`, not the count of things that link.

## Reproducing

Measurement scripts are not committed; they read the corpus and the shipped
`server/` exports and print the figures above.

```bash
# Corpus fetched and digest-verified as in legacy-tex-corpus-baseline-2026-08.md.
node adv/a-inventory.mjs    # inked vs spacer CharProcs, all zero-advance
node adv/a-pairing.mjs      # ink→spacer pairing, run-final share, many-to-many map
node adv/b-advances.mjs     # per-code displacement multiplicity and modal share
node adv/b-family.mjs       # per-font family fit under min and mode
node adv/c-groundtruth.mjs  # labelled page-1 characters, per-character implied scale
node adv/e-final.mjs        # slot-indexed fit at ±0.5…±12; the >128-glyph fact
node adv/f-falsepos.mjs     # fonts resolving under some statistic; 408 0 R located
node adv/g-pin.mjs          # 408 0 R unique width pins vs rendered masks
node adv/h-check.mjs        # lone-inked-glyph show operations; the 't' line
```

Every figure in this record was re-run and reproduced before it was written
down. The five corpus documents hashed to the digests pinned in
`legacy-tex-corpus-baseline-2026-08.md`.

## Known gaps

- Recovery on these four documents is **0** and this record does not change
  it. It changes only what a future attempt should not spend time on.
- The finding is specific to GNU Ghostscript 6.52 style glyph-cache output. It
  says nothing about dvips-era Type-3 documents in general, and it does not
  apply to `astro-ph-9402001.pdf`, which preserves its TeX codes, fingerprints
  ten fonts correctly, and fails on rasters instead.
- No OCR engine is bundled, and nothing above depends on one. The claim is
  narrower than "these documents cannot be read": it is that their Computer
  Modern *identity* is not derivable from the metrics and structure the
  producer wrote into the file.
