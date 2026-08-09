# Legacy dvips-era Type-3 text — OT1 enrollment is not worth building, 2026-08

## Outcome

**Enrolling the OT1 text encoding would gain 72 characters across every
document this repository has ever pinned, and 0.25% of eligible occurrences in
the wild. The reason is not that the work is hard. It is that the documents
where a Computer Modern text raster can be recovered and the documents where
the text is unreadable without recovery are, across all three dvips producer
regimes present, disjoint populations.**

`docs/evidence/legacy-tex-corpus-baseline-2026-08.md` and
`docs/evidence/legacy-tex-metric-routes-closed-2026-08.md` closed the shape and
metric routes to the four Ghostscript 6.52 papers. This record answers a
different question, asked after the generated Computer Modern PK reference made
a labelled bitmap ground truth available for the first time: now that
`ctan-cm-metafont-generated-pk-v1` exists, is it worth extending
`CM_CODEPOINTS` past the three math families to the OT1 text encoding — the
Greek capitals at 0–10, the `ff fi fl ffi ffl` ligatures at 11–15, the dotless
letters and accents at 16–24, and `ß æ œ ø Æ Œ Ø` at 25–31?

No. Not because of a tolerance that needs loosening or a reference that needs
more faces, but because of a structural anti-correlation described in §1 and a
second, independent blocker described in §4 that would require replacing the
family pin the math lane depends on.

This is a decision about the *text* lane. It says nothing about the math lane,
which recovers 1,872 occurrences on the Shannon reference document and is
untouched by any of it.

## What was measured, and against what

- **Generated reference.** Every Computer Modern face in the pinned CTAN
  `cm/mf.zip` (SHA-256 `b22c69034d…`), rasterised by METAFONT at both settings
  the shipped reference pins — 600 dpi `blacker .25 fillin 0 o_correction 1`,
  and 300 dpi `blacker 0 fillin .2 o_correction .6` — and keyed with the
  shipped mask-lane key `type3MaskGridSha256`. 76 faces, 152 face-profile
  builds, **17,597 distinct digests**, zero build failures. This is 37 times the
  470 digests the shipped `server/type3-cm-pk-reference.js` carries, because
  the shipped one keys only the three supported families' enrolled slots.
- **Eligibility.** The shipped gate, unchanged: a Type-3 font with no
  `/ToUnicode`, `LastChar <= 127`, at least one positive width, uniquely
  linkable from its drawn `(code, width)` pairs. An occurrence is *eligible*
  when its font clears that gate.
- **Match.** Exact SHA-256 equality between the document's decoded glyph mask
  and a generated raster. No tolerance, no similarity score, at any point in
  this record.
- **Gained.** An eligible occurrence that matches exactly *and* whose OT1 slot
  disagrees with the Unicode PDF.js reports for it today. An occurrence that
  already reads correctly is not a gain.
- **Corpus.** The five pinned legacy documents plus the Shannon reference,
  every page of each.
- **Wild.** 122 documents harvested from arXiv, ECCC, CMU CS technical reports
  and IAS/TUG mirrors; 110 produced a screen row, the other 12 failed to fetch
  or parse. The wild screen reads the **first three pages** of each document,
  so its absolute counts are a sample and only its rates are comparable to the
  corpus figures.

## 1. The two populations do not overlap

Three dvips-era producer regimes appear in everything harvested, and each one
fails the trade in its own way.

| Regime | Documents | Eligible occurrences | Exact matches | Gained |
| --- | ---: | ---: | ---: | ---: |
| Acrobat Distiller (Shannon) | 1 | 4,437 | 4,083 | 66 |
| GNU Ghostscript 6.52 (m3, nfscircuit, pippenger, sf) | 4 | 52,768 | 11 | 6 |
| GPL Ghostscript 9.22 (astro-ph/9402001) | 1 | 92 | 63 | 0 |
| **Corpus total** | **6** | **57,297** | **4,157** | **72** |

Read down the "gained" column and then read the mechanism for each row.

**Distiller preserves both the raster and the encoding, so its text is already
readable.** Shannon's rasters match the generated reference 4,083 times — a
92% hit rate, the highest anywhere in this investigation, and the direct proof
that the reference is good and the key is right. It converts to 66 gained
characters, and all 66 are *math* slots that no family currently enrolls, not
OT1 text. Shannon's running text is Type-1, extracts correctly today, and OT1
enrollment would not touch a character of it.

**Ghostscript 6.52 renumbers the codes and re-rasterises, so nothing matches.**
The four cr.yp.to papers offer 52,768 eligible occurrences — 92% of the
corpus's eligible population, and the only large body of genuinely unreadable
legacy text here. They yield **11** exact matches, of which 6 are gains. Their
glyph names are repacked to `/a0 /a1 /a2 …`, their `/Widths` are zero for every
inked code, and their bitmaps are the producer's own re-rasterisation rather
than the PK bytes dvips passed through. The two earlier records establish that
no metric or shape route reaches them; this one adds that no *raster* route
does either, at 17,597 candidate digests.

**Modern Ghostscript writes a `/ToUnicode`, so its glyphs are not eligible and
its text is already mapped.** astro-ph/9402001 draws 100,114 Type-3 glyph
occurrences and offers 92 eligible ones — 0.09% — because 18 of its 22 Type-3
fonts carry a producer mapping that the pipeline deliberately defers to. Of
those 92, 63 match exactly and **none** is a gain: every one already reads
correctly.

That is the whole finding. Recoverable-by-PK and unreadable-without-recovery
are anti-correlated by construction: a producer that preserves the METAFONT
raster well enough to match also preserved the encoding, and a producer that
destroyed the encoding also destroyed the raster.

## 2. The wild sample says the same thing, at scale

Of 110 documents screened, 71 offer at least one eligible occurrence. Across
those 71:

- **41,840** eligible occurrences.
- **105** exact matches against the 17,597-digest reference — **0.251%**.
- 99 of the 105 sit at an OT1 text slot; **92** are gains.
- The best single document is `eccc-1998-012.pdf` with **16** matches. No
  document exceeds 16 on its three-page sample; scaled to full length the best
  case is on the order of a hundred characters in a nineteen-page paper, in a
  document whose remaining fourteen thousand eligible occurrences would still
  be unrecovered.

A 0.25% hit rate is not a coverage problem that more faces or more profiles
fix. It is what §1 predicts: 70 of the 122 harvested documents are ESP
Ghostscript 7.05, which behaves like 6.52 — it re-rasterises, so its glyphs
miss — and most of the rest are modern Ghostscript, which writes a `/ToUnicode`,
so its glyphs are ineligible.

## 3. What OT1 enrollment would have to buy to be worth it

72 characters across six pinned documents. For comparison, the math lane the
same reference already serves recovers 1,872 occurrences on Shannon alone. The
text lane would cost a new encoding table, text faces added to the generated PK
reference, and — per §4 — a replacement for the family pin, in exchange for
less than 4% of the recoveries the existing lane already makes on one document.

## 4. The independent blocker: text faces pin no family

Even granting §1 were wrong, the matcher could not be reached.

`collectType3GlyphRecoveries` resolves a font's family from its `/Widths` with
`uniqueComputerModernFamily` before it looks at any raster, and abandons the
font when the answer is `null` or begins with `unsupported:`. Of the 75 faces in
`CM_TFM_METRICS`, exactly three carry a supported family label; every text face
— `cmr10`, `cmbx10`, `cmti10`, `cmss10`, `cmtt10`, `cmcsc10` and the rest — is
labelled `unsupported:<face>` by `encodingFamily` in
`scripts/generate-type3-cm-reference.mjs`, and `CM_CODEPOINTS` has no entry for
any of them.

Measured on real documents, the fingerprint does not merely fail to name a text
family — it returns nothing at all:

| Document | Type-3 fonts | Pin a supported math family | Pin any family | Pin a text family |
| --- | ---: | ---: | ---: | ---: |
| shannon-entropy.pdf | 24 | 11 | 11 | **0 of 13** |
| ias-GNW95.pdf | 29 | 0 | 0 | **0 of 29** |
| eccc1997-020.pdf | 25 | 0 | 0 | **0 of 25** |

Every non-math Type-3 font in all three documents returns `null` — not an
`unsupported:` label that a new encoding table could be attached to, but no
answer. Nine of Shannon's thirteen have two or more positive widths, so they are
not being refused by the `widths.size < 2` guard; their width vectors simply
admit either several Computer Modern faces or none.

astro-ph/9402001 shows how close and how unfixable this is. Its main text font
`134 0 R` is cmr10 — its ligature rasters are bit-exact to
`cmr10@300-b0-f20-o60` — and 91 of its 92 positive widths fit that face's TFM
inside the shipped ±0.5. One slot, code 109 (`m`), is out by 1.33, and one
outlier is enough: the scale intervals fail to intersect and the font resolves
to no family.

So an OT1 text lane cannot be an extension of the existing matcher. It would
need a different pin — a face identified from its rasters rather than a family
identified from its metrics — which means replacing, for text, the very
mechanism the math lane's safety argument rests on. That is a large change to
the most invariant-dense code in the repository, in service of §3's 72
characters.

## 5. Sample bias, stated plainly

The evidence above is real but it is not a random sample of the world's legacy
TeX PDFs, and three limits should be read alongside it.

- **Two producer families dominate.** 74 of the 122 harvested documents are
  Ghostscript 7.05 (ESP or GNU) and 19 more are modern GPL Ghostscript. A third
  regime that preserved the PK raster *and* dropped the encoding would break the
  anti-correlation in §1, and nothing here proves one does not exist. It is
  simply absent from everything reachable.
- **The corpora are computer science.** arXiv `cs`/`astro-ph`, ECCC, CMU CS
  technical reports. Mathematics, physics and humanities archives of the same
  era were not sampled, and their `dvips` invocations may differ.
- **Two intended sources were unreachable.** The IACR eprint archive and
  CiteSeerX did not serve documents during the harvest, so the sample has no
  cryptography preprints and no broad-crawl population at all.

## Conclusion

Do not build OT1 text enrollment. If the question is reopened, the thing to
look for first is a producer regime that keeps METAFONT's rasters while losing
the encoding — that is the population this lane would serve, and this
investigation found none. The generated reference itself is not the problem and
should be kept: at 17,597 digests it matches Shannon's rasters 4,083 times, and
it is what proved the text lane empty rather than merely unattempted.

The user-visible defect in this space is not a missing encoding at all. It is a
producer `/ToUnicode` that is present and wrong; see
`docs/evidence/legacy-tex-ligature-tounicode-2026-08.md`.
