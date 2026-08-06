# Shannon Computer Modern Type-3 enrollment — 2026-08

## Outcome

Shannon's 1948 paper was produced by `dvipsk 5.58f` and `Acrobat Distiller
3.01`. Its mathematics is drawn entirely with Type 3 bitmap fonts whose
`/Encoding /Differences` names are the raw TeX character codes, and the file
contains no `/ToUnicode` at all. PDF.js therefore emits the character code
itself: codes in the C0 range became replacement characters, and printable
codes became text that looks correct and is not. A reader saw `Z` where the
paper prints an integral, `H0` for `H′`, `jY(f)j` for `|Y(f)|`, and `n ! ∞`
for `n → ∞`.

This batch extends the existing CTAN-bound enrollment to the rest of what the
paper uses. It adds the `computer-modern-math-extension` family for `cmex*`
metrics, and enrolls the math symbol and math italic slots that were already
identified by the width fingerprint but had no official codepoint.

The preceding ruled-table batch recorded that "several mathematical symbols
within the Shannon table therefore remain damaged even though their row and
column membership is now useful." Table I now reconstructs with no replacement
characters in any cell.

Recovery remains fail-closed. A character is produced only after an exact
official-metric family match, an exact Type-3 CharProc digest match against a
reviewed raster, witness digests from the same font, and a complete
operator-to-text binding. Nothing about the fingerprint or the abstention
behaviour was loosened.

## Clean run

- Evaluated branch: `agent/type3-cmex-enrollment`
- Source PDF SHA-256:
  `6e4e3411984f3edf99dbfe8b941cb5e8a321379ff0cae6ae5c1f592ad8882ca8`
- CTAN `cm/tfm.zip` SHA-256:
  `9c0f99fa34c7d801c40f6b5ff60bc28f200e8ef6ffb2fe75e54ca835c67fc04c`
- CTAN `cm/ps-type3.zip` SHA-256:
  `ef38efbd58774b454b190e17c8b5ca0fde13dd5d5ff2282bf0dc0313197f1033`
- CTAN `cm/mf.zip` SHA-256:
  `b22c69034d9f3f7a9bf22673544bdeaace5656973cf7fb1a395a857148943076`
- Generator toolchain: Ghostscript 10.07.1, qpdf 12.3.2
- Repository gate: 2066 passed, 83 skipped, 0 failed
- Live external oracle: `test/shannon-type3-live.test.js` run with
  `PDF_TOOLS_SHANNON_SOURCE` pointed at the pinned source, 66 registry
  identifiers, 1816 recovered occurrences

Before this batch the live oracle asserted the pre-change result and was
skipped in every unattended run, so the enrollment had no executed end-to-end
evidence. It is now rebound and was run against the real document.

## Metric comparison

| Sampled PDF Tools metric | Before | After |
| --- | ---: | ---: |
| Strict Type-3 recovered occurrences | 1229 | 1816 |
| Registry entries | 28 | 67 |
| Enrolled Computer Modern families | 2 | 3 |
| Reviewed enrolled slots | 10 | 39 |
| Slots the labeled fixture draws | 12 | 21 |
| Of those, slots that resolve to a family | 5 | 21 |
| Families the labeled fixture demonstrates | 1 | 3 |
| Replacement characters in Table I | 8 | 0 |
| Integral signs rendered as `Z` | 92 | 0 |
| `H0` occurrences that should read `H′` | 11 | 0 |
| `jY(f)j` occurrences that should read `\|Y(f)\|` | 3 | 0 |

## Table I, page 40

Before:

```text
| 1<br>1� !<br>0 1! | 1<br>e2 | �8:69 | sin2(t=2)<br>t2=2 |
| 1<br>p<br>1� !2<br>0 1! | �<br>�<br>2<br>2<br>e | �2:67 | J1(t)<br>�<br>2<br>t |
```

After:

```text
| 1<br>1− ω<br>0 1ω | 1<br>e2 | −8.69 | sin2(t/2)<br>t2/2 |
| 1<br>√<br>1− ω2<br>0 1ω | (<br>)<br>2<br>2<br>e | −2.67 | J1(t)<br>π<br>2<br>t |
```

## Evidence for each enrolled slot

Every enrolled slot is asserted against its official METAFONT definition in
the pinned CTAN sources — `symbol.mf`, `sym.mf`, `greekl.mf`, `greeku.mf`,
`romms.mf`, `bigdel.mf`, and `bigop.mf` — inside
`requireSourceDefinitions`. Generation fails closed if any assertion stops
matching, which is how the batch caught that `cmex` `oct"024"` is
`\bigg left bracket` rather than `\Big left bracket`.

Every enrolled raster was additionally rendered out of the source document and
inspected before enrollment, and the provenance record separates the kinds
of evidence: `fixture_drawn_slots` lists what the labeled fixture PDF draws,
`fixture_family_resolving_slots` the subset of those that actually classify,
`fixture_undrawable_slots` the enrolled slots the fixture cannot draw, and
`reviewed_slot_labels` every enrolled slot. The first two are no longer
written by hand. `measureFixture` in the generator reads the Type-3 fonts back
out of the emitted PDF and asks the shipped resolver what each one classifies
as, and `test/type3-glyph-inventory.test.js` re-measures the same fact through
`scripts/inventory-type3-glyphs.mjs` and requires the recorded lists to be
exactly what came back. The previous hand-written figures were wrong and their
test passed vacuously.

## The single-witness exception

An entry normally needs two witness glyphs from its own font. A dvips subset
can hold fewer official glyphs than that: this document's `cmex` integral font
carries exactly two, so no glyph in it could ever have qualified. Such an entry
may now supply one witness only by declaring `complete_font_enrollment`, its
font's complete official footprint, which the matcher requires to be present
exactly as declared and to match in full.

This is not uniformly stronger than the two-witness rule. It is
non-monotonic: a `cmex` font that also contained a big parenthesis would fail
the footprint test and lose integral recovery entirely, so more glyphs in the
font can mean less output. The exception is therefore narrow and tied to the
subsetting this document happens to use. It cannot produce a wrong character —
satisfying it still requires the exact digest of the Computer Modern integral
raster — but it does not generalise, and a font with a different subset needs
its own two-witness entry.

## Deliberate abstentions

- Extensible delimiter tops, bottoms, and modules, including `cmex` `0x0c` at
  68 occurrences, are fragments of a built-up delimiter rather than
  characters. They stay unmapped and are reported.
- Four rasters of otherwise enrolled slots were not visually reviewed and are
  annotated as abstaining in the enrollment run rather than assumed.
- The `cmmi` less-than and greater-than slots were enrolled and then removed.
  They mapped a character to itself, changed no output, and only added
  digest-match surface.

## Known gaps

- The labeled fixture now demonstrates all three enrolled families — 9 cmmi10,
  5 cmsy10, and 7 cmex10 slots, every one of which resolves — but it still
  cannot draw every enrolled slot at once. CTAN `ps-type3` fonts carry
  `/Widths` pre-rounded to integer 1/1000 em, lossy against the TFM by up to
  three units, while `metricScaleInterval` requires a single scale factor to
  fit every observed code within half a unit. Because that constraint is a
  conjunction, adding drawn codes shrinks the feasible interval monotonically,
  so each font draws a maximum subset of its enrolled slots that still admits
  one scale. The excluded slots are recorded as `fixture_undrawable_slots`.
  cmsy10 keeps the exact five codes the previous revision drew, in the same
  order, so the CharProc digests that qualified `cmsy-ctan-type3-minus-v1` stay
  bound to the same bytes.

  Rewriting the emitted `/Widths` from the pinned TFM was evaluated and
  rejected. It does make every enrolled slot of all three fonts resolve, but
  the width reaches the PDF as the `wx` operand of the CharProc's `d1`, so it
  is inside the CharProc digest: every glyph digest in the fixture would then
  describe a font no producer emits, and `cmsy-ctan-type3-minus-v1` — which is
  qualified against this fixture precisely so a real `ps-type3` document can
  match it — would go dead. Keeping the fonts byte-exact keeps the fixture
  usable as digest evidence, which is its other job.

  Real documents are unaffected by the rounding either way: dvips rounds once
  from the TFM at one raster resolution, so Shannon's `/T23` fits twenty-three
  codes into a nonempty interval and resolves uniquely. The `±0.5` tolerance is
  load-bearing evidence for that real case and was not loosened. A labeled
  reference built from dvips PK-derived Type-3 fonts would be able to draw
  every enrolled slot, and remains the way to close the remaining gap.
- `render_pdf_page` and `render_pdf_region` still perform no recognition, and
  no OCR engine is bundled. Mini-graphs inside Table I remain stroked vector
  content reported as a coverage gap.
