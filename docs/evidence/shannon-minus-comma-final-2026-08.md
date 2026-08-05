# Shannon final qualified minus and comma recovery — 2026-08

## Outcome

This tranche safely recovers the last 64 source-supported minus signs (`−`)
and five source-supported commas (`,`), reducing the named but unrecovered
Type-3 census in Shannon's 55-page paper from 80 occurrences to 11. The eleven
remaining occurrences are alpha glyphs that deliberately fail the existing
source-placement rules.

The candidate changes exactly 69 output characters: 64 replacement characters
become minus signs and five semicolons become commas. No other output character
changes.

## Source-bound evidence

The 64 minus signs share exact target CharProc SHA-256
`0c8b34a3281f9e8e91b2d955f952a50d187cd06c432be27c015b78570e645e9d`.
Their exact font also contains two independently identified Computer Modern
math-symbol witnesses:

- code 6, official plus-or-minus, CharProc SHA-256
  `b68b24c69a8802a7e57a1cabaa7c1153a0a305e5d29ba308b78d60c16a5464b7`;
- code 33, official right arrow, CharProc SHA-256
  `6ff1e08b5364a8ce02ac2390691fdfb1f2e532bd0a1dac95d01a155bbce482fc`.

The five commas share exact target CharProc SHA-256
`7c69e2ebf2eec772599fae11d278adcc3c88472af6279f9801865628040d981b`.
Their exact font contains the already qualified period and slash witnesses,
with SHA-256 values
`cdf3cbb1bd7626495858ebacb74816ba82ac139458edf75c6d737f6b121b65fe`
and
`dfa9c162caf4e99dafd16ca5d87e90f89d44c29312a2675e89aa789c5355d63e`.

The generator pins the official CTAN Computer Modern TFM, Type-3, and
METAFONT archives by SHA-256 and verifies the named source definitions. Runtime
recovery still requires the unique official metric family, exact target and
two-witness digests, exact source character, raw-font link, and complete
page-wide operator/text binding. Companion-only characters are evidence, not
replacement targets.

## Full-paper evidence

- Source SHA-256:
  `6e4e3411984f3edf99dbfe8b941cb5e8a321379ff0cae6ae5c1f592ad8882ca8`.
- Exact implementation commit:
  `942d80405d4949033765f7e5c49c16467c27f9f7`.
- Clean inventory SHA-256:
  `6c1a318a29cc3aa663a779b8375e05c2497af61ed94b51ec14a0ed4c1849bb69`.
- Strictly recovered named occurrences: 1,229 of 1,240; 11 remain.
- Three clean PDF Tools runs produced byte-identical Markdown SHA-256:
  `723ca1614c6516ee698c596aab6acb84c0437983e6f96c1f871dea9668b79985`.
- Each output is 182,565 bytes with 434 replacement characters, 49 recovered
  alpha symbols, and 68 explicit gaps.
- Clean report SHA-256:
  `0b9cb50c5b9baa8caa3c17a611aeb1f5fa28b94766eff754732306564d1b4189`.
- Private report directory:
  `/Users/silverbook/Sites/pdf-tools-extraction-sidecars/shannon-minus-clean-eval-parent.RutCQo/run`.

The sampled structural scores are unchanged: headings 14/14, reading order
24/24, paragraphs 3/4, equations 4/4, footnotes 4/4, one qualifying table,
and zero false equation headings. The complete repository gate passed 1,996
tests with 82 intentional skips and zero failures. The native macOS partition
passed 62 tests with 9 intentional skips.

An independent exact-commit review accepted the source binding, official CTAN
definitions, target and witness evidence, generated provenance, root/share
equivalence, and fail-closed behavior.

## Honest limits

This is source-bound recovery for the named Shannon PDF, not general Type-3
decoding, OCR, or arbitrary formula reconstruction. The eleven alpha cases
remain unchanged because their operator evidence does not safely identify one
source placement. Ten glyphs with ambiguous raw-font links also remain explicit
abstentions outside the named recovery census.
