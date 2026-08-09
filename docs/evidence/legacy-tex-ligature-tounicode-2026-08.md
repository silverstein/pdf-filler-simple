# Ligatures behind a demonstrably-wrong /ToUnicode, 2026-08

## Outcome

**The defect is real, it is in documents users can already read, and it is
narrow: 725 occurrences on the one pinned corpus document that has it, and
9,416 across 5 of 122 harvested documents. A producer writes a `/ToUnicode`
that maps a drawn glyph to a C0 control character, and the character silently
disappears. `Oflazer` renders as `O azer`; `defined` as `de ned`; `infinite`
as `in nite`.**

**One of four blockers to fixing it is removed and shipped in this change: the
Type-3 linker could not identify these fonts at all, because pdf-lib leaves a
lowercase `#hh` PDF name escape undecoded and every one of these producers
names its glyphs after raw encoding bytes. astro-ph/9402001 goes from 7,019 to
100,108 of its 100,114 drawn Type-3 occurrences attributable to a font
dictionary, and from 11 to 32 recovered characters — all through the existing,
unmodified generated-PK lane.**

**The other three blockers are not removed, and the ligature override is not
built. They are stated with numbers in §5–§7 so the next attempt starts from
measurements rather than from this record's prose.** Shannon is unchanged at
1,872 recoveries across all 70 registry ids with identical per-id counts.

## What was measured, and against what

- **Corpus.** The five pinned legacy documents plus the Shannon reference,
  every page of each: 390,203 drawn Type-3 glyph occurrences.
- **Wild.** 122 harvested documents, every page of each: 4,497,459 drawn
  Type-3 glyph occurrences. Same harvest as
  `docs/evidence/legacy-tex-ot1-text-no-go-2026-08.md`, and the same sample
  bias applies.
- **Attribution.** The shipped `rawType3Fonts` + `linkedRawType3Font` rules,
  re-implemented without the `recoverable` filter so that fonts carrying a
  `/ToUnicode` stay attributable and countable.
- **Invalid.** A drawn glyph whose PDF.js Unicode contains a C0 control
  (U+0000–U+001F), a C1 control or DEL, an unpaired surrogate, U+FFFD, or a
  noncharacter. **TAB, LF and CR are counted as invalid here**, unlike in
  running text: no glyph is a carriage return, and excluding them undercounts
  astro-ph's ligature damage by exactly the 35 `fl` occurrences it maps to
  U+000D.
- **Provably wrong.** An invalid occurrence drawn from a font that actually
  carries a `/ToUnicode`. This is the distinction the whole record turns on,
  and it is not the same as "invalid".

## 1. The defect, and what separates it from the one already recorded

astro-ph/9402001 (`GPL Ghostscript GIT PRERELEASE 9.22`, `dvips 5.518`) embeds
a `/ToUnicode` for 18 of its 22 Type-3 fonts. For its main text font, `134 0 R`
— 86,547 occurrences, the body type of the whole paper — that CMap is the
identity on the font's own byte codes. OT1 puts the ligatures at codes 11 to
15, so the CMap says:

| Code | OT1 character | Producer `/ToUnicode` target | Occurrences |
| ---: | --- | --- | ---: |
| 11 | `ff` | U+000B VERTICAL TAB | 140 |
| 12 | `fi` | U+000C FORM FEED | 157 |
| 13 | `fl` | U+000D CARRIAGE RETURN | 35 |
| 14 | `ffi` | U+000E SHIFT OUT | 18 |
| | | **Total** | **350** |

Spread over 36 of the document's 37 pages. A reader gets `con ned` for
`confined`, `e ects` for `effects`, `de ned` for `defined`, ` exible` for
`flexible`, ` ducial` for `fiducial`.

This is a **different defect** from the one
`docs/evidence/legacy-tex-corpus-baseline-2026-08.md` records, and conflating
them makes the problem look a hundred times bigger than it is. The four
Ghostscript 6.52 papers also produce a million C0 code points between them —
but their fonts carry no `/ToUnicode` at all, and what is being seen is PDF.js
falling back to the raw byte because the producer supplied no mapping. That is
missing information. What astro-ph has is *wrong* information, asserted by the
producer, which the pipeline currently defers to precisely because it is
asserted.

The two are cleanly separable by whether the font dictionary has a `/ToUnicode`
key, and every figure below uses that split.

## 2. How much of it there is

| Population | Documents | Drawn Type-3 occurrences | Invalid Unicode | …from a font that has a `/ToUnicode` | …at OT1 ligature slots 11–15 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Pinned corpus | 6 | 390,203 | 80,972 | **725** | **470** |
| Harvested wild | 122 | 4,497,459 | 1,136,921 | **9,416** | **1,098** |

Two things to read off this.

**The provably-wrong population is under 1% of the invalid one.** 725 of 80,972
in the corpus (0.90%), 9,416 of 1,136,921 in the wild (0.83%). Nearly
everything that looks like a
broken mapping is the encoding-loss defect, which no `/ToUnicode` override can
touch because there is no `/ToUnicode` to override.

**Ligature slots are 65% of it in the corpus and 12% in the wild.** 470 of 725,
and 1,098 of 9,416. The remaining provably-wrong occurrences sit at Greek
capitals (codes 0–10), accents (18–24) and the `ß æ œ ø` block (25–31) in text
fonts, and at math slots in math fonts — the same slots the OT1 no-go record
declines to enroll. Ligatures are the part worth having because they fall
inside words that are otherwise perfectly readable.

**It is concentrated in five documents.** Only 1 of 6 corpus documents and 5 of
122 harvested ones exhibit it at all:

| Document | Pages | Attributed occurrences | Provably wrong | At ligature slots |
| --- | ---: | ---: | ---: | ---: |
| ias-GNW95.pdf | 27 | 50,103 | 6,990 | 693 |
| CMU-CS-94-194.pdf | 19 | 34,678 | 2,117 | 273 |
| astro-ph-9402001.pdf | 37 | 100,108 | 725 | 470 |
| chao-dyn-9403001.pdf | 27 | 20,457 | 202 | 80 |
| cmp-lg-9503001.pdf | 10 | 14,414 | 76 | 52 |
| CMU-CS-94-135.pdf | 23 | 578 | 31 | 0 |

All six are modern Ghostscript over dvips. The damage is visible in their text
today: `Kemal O azer` on page 1 of `cmp-lg-9503001` (Oflazer), `de ned` and
`the rst` throughout `ias-GNW95`, `ine cient` and `e ects` in
`CMU-CS-94-194`, `in nite` in `chao-dyn-9403001`.

## 3. The evidence bar

The bar proposed for this work was: override a producer `/ToUnicode` only when
it maps to a C0 control, **and** the glyph's raster matches a generated CM
ligature digest exactly, **and** the existing safeguards pass. Two cleaner bars
were tested against the documents first. Both fail, and the reasons are worth
recording because they are the obvious things to try.

**Rejected: trust the glyph name.** The standard extraction fallback when a
`/ToUnicode` is absent or wrong is the PostScript glyph name via the Adobe
Glyph List — a font whose `/Differences` says `/ff` is telling you the answer,
and no raster evidence would be needed at all. It does not work here, because
these producers do not use glyph names. dvips-era Ghostscript names every glyph
after its own raw encoding byte: astro-ph's ligature slots are named `/#0b`,
`/#0c`, `/#0d`, `/#0e`. The name carries exactly the same non-information as
the `/ToUnicode`, from the same source, and it is wrong in exactly the same
places. Of astro-ph's 112 distinct glyph names, 34 need `#`-escaping; the other
78 are single printable bytes like `/a` and `/S`, which happen to coincide with
AGL names only because those codes are ASCII already and need no recovery. Not
one glyph that is actually mis-mapped carries a name that says what it is.

**Rejected: infer from the surrounding word.** `con` + U+000B + `ned` is
unambiguously `confined` to a reader, and a dictionary or a language model would
say so. This is out of contract: the extraction lane is deterministic and local
by construction, reports typed gaps rather than guesses, and runs no external
model. A ligature restored by inference would be indistinguishable in the output
from one restored by exact raster equality, which is the distinction the
`qualification` field exists to preserve.

**Accepted, with one strengthening: the proposed bar, plus a global-uniqueness
requirement on the digest.** The proposed bar leaves the character to be decided
by the (family, code) pair, and §6 shows the family pin is unavailable for
exactly these fonts. Requiring instead that the digest identify exactly one
`(face, code)` across the whole generated reference makes the raster decide the
character on its own, and removes the need for a family. Measured on astro-ph's
`134 0 R`, this holds:

| Code | Digest entries in the 17,597-digest reference | Named face |
| ---: | ---: | --- |
| 11 | 1 | `cmr10@300-b0-f20-o60` |
| 12 | 1 | `cmr10@300-b0-f20-o60` |
| 13 | 1 | `cmr10@300-b0-f20-o60` |
| 14 | 1 | `cmr10@300-b0-f20-o60` |

All four are globally unique and all four name the same face, and 50 of the
font's 92 slots key `cmr10` overall. The C0 test alone is a *trigger*, not
evidence; the exact digest is the evidence; global uniqueness is what lets it
stand without a family. No tolerance appears anywhere in this and none should.

The `/ToUnicode` deferral stays intact for every valid mapping. The override
would apply only where the producer asserted something no text can contain.

## 4. What is fixed here: the linker could not see these fonts

Before any of §3 can be reached, the pipeline has to know which font dictionary
a drawn glyph came from. For these documents it did not.

`linkedRawType3Font` re-identifies a font from its drawn `(code, width,
CharProc name)` triples, comparing pdf-lib's `/Differences` name against
PDF.js's CharProcs key. PDF names escape an irregular byte as `#` plus two
hexadecimal digits and ISO 32000-1 7.3.5 allows either letter case, but
pdf-lib's `decodeText()` unescapes with `/#([\dABCDEF]{2})/g` — digits and
uppercase A–F only. Ghostscript writes lowercase. So pdf-lib reported the
three-character string `#0b` where PDF.js reported the one-character name
U+000B, the comparison failed, and the entire font went unlinked on every page
where such a glyph was drawn.

The cost was not confined to ligatures. It disabled recovery, classification
and census reporting for the whole font:

| Document | Occurrences attributable before | After | Of a total of |
| --- | ---: | ---: | ---: |
| astro-ph-9402001.pdf | 7,019 | 100,108 | 100,114 |
| chao-dyn-9403001.pdf | 1,186 | 20,457 | 20,457 |
| cmp-lg-9503001.pdf | 970 | 14,414 | 14,414 |
| CMU-CS-94-230.pdf | 3,151 | 3,192 | 3,192 |

`type3GlyphNameCandidates` in `server/layout-extraction.js` now offers the
linker both readings of a name. The separation between them is exact rather
than heuristic. pdf-lib has already consumed every escape whose two digits are
`[0-9A-F]`, so a residual `#hh` can only be an escape it missed when one of the
digits is lowercase `a-f`; `#0b` came from a raw `/#0b`, while `#0B`, `#28` and
`#2328` could not have and are left alone. Both readings are offered rather than
one being chosen, so a font is still only linked when the name PDF.js reports is
one pdf-lib's bytes can actually produce, and a code whose two readings *both*
name a real CharProcs entry is refused outright rather than guessed.

This matters because the naive fix — unescape every residual `#hh` — breaks the
Shannon reference document. Shannon's producer writes `/#230B`, an escaped
hash, so its glyph really is named `#0B` and pdf-lib and PDF.js already agree.
All 29 of Shannon's escaped Type-3 glyph names are of that form, and blanket
re-unescaping drops its linked occurrences from 4,437 to 766. `CMU-CS-96-106`
is the same case in the wild. Both are asserted in
`test/read-pdf-layout.test.js`.

**What it bought, and what it did not.** astro-ph's recoveries rise from 11 to
32: 29 minus signs and 3 primes, all from font `247 0 R`, all through the
existing generated-PK lane with its family pin, metric pin, digest match,
witness match and complete-font footprint unchanged. No new evidence class, no
new registry entry, no relaxed rule — the same font was simply invisible on most
of its pages. **It recovered no ligature**, because ligature recovery needs
§5–§7 as well. `test/legacy-tex-corpus-live.test.js` records the new baseline.

## 5. Remaining blocker: recovery targets are single scalars

`ff` is two characters and `ffi` is three. The registry's production site
already computes `output_utf16_end` as `binding.source_utf16_start +
registry.target_unicode.length`, which reads as if multi-scalar targets are
supported. They are not. The semantic validator at
`validatePdfLayoutSemantics` in `server/layout-extraction.js` asserts, in the
single `semanticAssertion` that guards every glyph recovery's offsets,

```
recovery.target_unicode.length === 1
&& recovery.output_utf16_end === recovery.output_utf16_start + 1
```

so any entry with a two-character target would fail validation and abort the
extraction rather than emit a ligature.

The survey's observation that no shipped entry emits more than one character is
confirmed and is stronger than reported: all **6,379** entries have a
`target_unicode` of length exactly 1 — 70 reviewed, 6,308 generated, 1 labelled
reference — so the multi-scalar path has never executed and its correctness is
unestablished, not merely untested. Relaxing the two assertions is necessary but
not sufficient; the offset arithmetic they guard is consumed downstream by
`server/markdown-conversion.js` and by the layout occurrence oracle, and each
consumer needs its own evidence that a target longer than one code unit keeps
`recoveredText === item.text` and keeps every subsequent offset aligned.

## 6. Remaining blocker: these fonts pin no family

`collectType3GlyphRecoveries` resolves a family from `/Widths` before it looks
at a raster, and abandons the font when the answer is `null` or `unsupported:`.
astro-ph's `134 0 R` returns `null`. It is cmr10 — its four ligature rasters are
bit-exact to `cmr10@300-b0-f20-o60` — and 91 of its 92 positive widths fit
cmr10's TFM inside the shipped ±0.5 tolerance. Code 109, `m`, is out by 1.33.
One outlier empties the intersection of scale intervals and the font resolves
to nothing.

Widening the tolerance is the wrong response and is refused: the ±0.5 is what
makes the fingerprint an identification rather than a guess, and it is shared
with the math lane that Shannon depends on. The right response is §3's
global-uniqueness requirement, which makes the family unnecessary for this lane
rather than obtainable. `docs/evidence/legacy-tex-ot1-text-no-go-2026-08.md` §4
records the same blocker from the other direction and measures it on three
documents.

## 7. Remaining blocker: no text encoding, and no text faces in the reference

`CM_CODEPOINTS` covers three math families. There is no table saying OT1 code
11 is `ff`, and no text face in `server/type3-cm-pk-reference.js` — its 34 face
records and 470 digests are cmmi, cmsy, cmex and their bold variants only. Both
would have to be generated, not written: `scripts/generate-type3-cm-reference.mjs`
and `scripts/generate-type3-cm-pk-reference.mjs` are the only sanctioned
sources, and the second needs a METAFONT run over the pinned CTAN archive.

Two hazards for whoever does it. Text faces do not share one encoding: `cmtt`
and `cmsltt` put arrows and inverted punctuation at codes 11–15 where `cmr` and
`cmbx` put ligatures, so a per-family table is wrong and a per-face table is
needed. And `generatedPkRecoveryEntries` builds a solo entry for every
(code, witness) pair of a face; at 5 enrolled slots per text face that is
manageable, but enrolling the whole OT1 range at 128 slots per face over 75
faces is a combinatorial explosion that would have to be bounded deliberately.

## 8. Verification

- Both live oracles pass. Shannon: exactly 1,872 recoveries across all 70
  registry ids, per-id counts identical to before this change.
  `test/legacy-tex-corpus-live.test.js` baseline deliberately updated for
  astro-ph (44→92 linked, 11→32 recovered); the other four documents are
  unchanged to the occurrence.
- `test/read-pdf-layout.test.js` gains four fixtures for hex-escaped glyph
  names, two of which fail without the fix and two of which are the controls
  that keep the naive fix from being written.
- `npm test`: 2,192 passed. The 12 failures are the `source-identity`
  clean-tree gate in `test/eval/agent-workflow-*`, which requires a committed
  working tree; they pass on a clean tree and this change was not committed.
- `npm run build:mcpb` reproducible (two byte-identical isolated builds) and
  `npm run smoke:mcpb` passed on darwin/arm64.
- `pdf-toolkit-mcp-share/server/` re-mirrored byte-identical; share contract
  passed. Layout occurrence oracle regenerated — only the module digest binding
  changed, no case content.

## Conclusion

The ligature override is worth building and is not built here. What is built is
the prerequisite that made it look impossible: the affected fonts are now
visible to the Type-3 subsystem at all, which is separately worth having because
it recovers 21 further characters through the existing lane and repairs a census
that was misreporting 93% of one document's Type-3 glyphs as unattributable.

The next step is §3's bar behind a face-pinned lane, gated on a font carrying a
`/ToUnicode` that maps a drawn glyph into C0 — a population of five documents
in 122, disjoint at the font level from everything the math lane touches, so
Shannon cannot be affected by construction.
