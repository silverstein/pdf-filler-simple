# Legacy dvips-era Type-3 corpus — failing baseline, 2026-08

## Outcome

**This is a failing baseline. Every recovery figure in it is zero, and every
zero is a defect, not an intention.**

The Computer Modern Type-3 recovery that works on Shannon's 1948 paper does
not transfer. A study across 11 dvips-era PDFs and 560,754 Type-3 glyph
occurrences matched 0 of 29 eligible occurrences against any registry digest.
This document binds five of those PDFs as a pinned, measured corpus so the
gap has an executable size instead of an anecdote, and so any later work has
something it must visibly move.

Four of the five are D. J. Bernstein papers from cr.yp.to, produced by
`GNU Ghostscript 6.52`, which repacks glyph names to `/a0 /a1 /a2…`. On these
`pdftotext` yields literal noise and PDF Tools recovers nothing — not one
character, and not even a font family for three of the four. The fifth is an
arXiv paper where the TeX character codes *are* preserved and 11 occurrences
do carry an official Unicode mapping, and it still recovers nothing, which
isolates the digest problem from the code-packing problem.

Nothing in the recovery path was changed to produce this record. The corpus
was measured through the shipped code exactly as it stands.

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

| Metric | pippenger | nfscircuit | m3 | sf | astro-ph-9402001 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Pages | 21 | 11 | 19 | 15 | 37 |
| Bytes | 292,684 | 186,703 | 276,417 | 268,946 | 929,486 |
| Type-3 fonts | 22 | 12 | 20 | 16 | 22 |
| — admissible to the font linker | 19 | 10 | 18 | 15 | 4 |
| — resolving a Computer Modern family | 0 | 0 | 0 | **1** | **10** |
| Observed Type-3 occurrences | 78,175 | 40,704 | 92,502 | 74,271 | 100,114 |
| Linked to a raw Type-3 font | 0 | 0 | 0 | 0 | 44 |
| Omitted, unlinked | 78,175 | 40,704 | 92,502 | 74,271 | 100,070 |
| Classified into a family | 0 | 0 | 0 | 0 | 12 |
| Officially Unicode-mapped | 0 | 0 | 0 | 0 | 11 |
| Matching a registry digest | 0 | 0 | 0 | 0 | 0 |
| **Strictly recovered** | **0** | **0** | **0** | **0** | **0** |

Corpus totals: 385,766 observed Type-3 glyph occurrences, 92 Type-3 fonts,
44 linked occurrences, 11 officially Unicode-mapped occurrences, and **0
recovered characters**. The single abstention reason reported for every
document is `raw_type3_font_link_ambiguous_or_unavailable`.

## Why nothing recovers

The study named two causes. Measuring the corpus found a third that sits
upstream of both, and the three stack.

**1. A zero-width slot voids the whole font.** `rawType3Fonts` builds a font's
width map with `if (width > 0) widths.set(code, width)`, dropping zero-width
slots — correctly, since `metricScaleInterval` cannot fit a scale factor to an
observed zero. But `linkedRawType3Font` then demands
`raw.widths.get(code) === width` for *every* code the page actually drew,
including the zero-width ones, where the lookup returns `undefined`. One drawn
zero-width glyph therefore eliminates every candidate and abstains the entire
font. Every Type-3 font in all four Ghostscript 6.52 papers — 22, 12, 20 and
16 of them respectively — carries at least one zero-width slot. Replaying the
linker over `pippenger.pdf` pages 1–5 with the shipped rule links 0 of 16
font-page pairs; retaining the zero-width slots links 7. This is why 285,652
occurrences across the four papers reach neither the family fingerprint nor
any CharProc digest.

**2. The family fingerprint does not survive repacking.** Of those same 7
font-page pairs that would link, 0 resolve a Computer Modern family:
`uniqueComputerModernFamily` matches `widths[code]` against TFM widths
slot-for-slot, and Ghostscript 6.52 has repacked the codes. Fixing cause 1
alone recovers nothing. Only one font in the whole Bernstein set — one in
`sf.pdf` — fingerprints a family at all, and it still recovers nothing
because its occurrences never link.

**3. `/ToUnicode` presence excludes a font outright.** `rawType3Fonts` skips
any Type-3 font carrying a `/ToUnicode`. In `astro-ph-9402001.pdf` 18 of 22
fonts do, which is why only 4 fonts are admissible while 10 fingerprint a
Computer Modern family, and why 100,070 of 100,114 occurrences are omitted.

**4. The digest does not transfer even when everything else does.** The 44
occurrences that do link in the arXiv paper produce 12 classified and 11
officially Unicode-mapped occurrences — and 0 registry digest matches. The
CharProc SHA-256 folds in PK resolution, producer operator idiom, and the
per-glyph placement `cm` matrix, so a raster that is the same Computer Modern
character hashes differently under a different producer. This is the cause the
study named, isolated here from the other three.

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

Observed: 1 file passed, 6 tests passed, 4.6s.

Per-document census, outside the suite:

```bash
node scripts/inventory-type3-glyphs.mjs --source /tmp/legacy-tex-corpus/pippenger.pdf
```

## Known gaps

- This is the gap. Zero recovered characters across 385,766 legacy Type-3
  glyph occurrences is the tracked defect, and raising any figure in the
  measured-baseline table is the work this record exists to measure.
- No OCR engine is bundled, and none of the above depends on one. Every glyph
  in this corpus is drawn by an embedded Type-3 font whose Computer Modern
  identity is recoverable from metrics and raster bytes alone.
- The corpus documents are not committed. The digests above are the only
  binding; a re-fetch that produces different bytes must be treated as a
  different document, not as a changed baseline.
