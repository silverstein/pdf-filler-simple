# Accessibility Evaluation Phase 0 and Claim Safety

Accessibility is not a boolean that PDF Tools can infer from a tag flag, an XMP
identifier, successful text extraction, or one automated checker. This document
defines a phase-0 structural screen, a bounded external machine-validation
pilot, and the evidence still required before a stronger claim may be made.

The implementation is intentionally an evaluation harness, not a user-facing
accessibility checker. It does not change runtime tools or claim that PDF Tools
can produce, repair, validate, or certify an accessible PDF.

## Standards basis and scope

This source review was current on 2026-07-21 and uses standards bodies,
standards-maintainer resources, and official validator documentation:

- [ISO 14289-1:2014](https://www.iso.org/standard/64599.html) defines PDF/UA-1
  using PDF 1.7. Its ISO abstract limits the standard's scope and does not make
  it a conversion process, user-interface specification, or implementation
  technique.
- [ISO 14289-2:2024](https://www.iso.org/standard/82278.html) defines PDF/UA-2
  using PDF 2.0. The [PDF Association's PDF/UA-2 resource](https://pdfa.org/iso-14289-2-pdfua-2/)
  warns that PDF/UA alone does not ensure every aspect of content accessibility,
  including matters outside its scope such as color contrast and cognitive
  accessibility.
- The [Matterhorn Protocol 1.1](https://pdfa.org/resource/the-matterhorn-protocol/)
  supplies possible failure conditions for PDF/UA-1 and distinguishes checks
  requiring human judgment. It does not define partial conformance or defect
  severity. The [PDF/UA Technical Working Group](https://pdfa.org/community/pdf-ua-technical-working-group/)
  records PDF/UA-2's publication and the ongoing Matterhorn 2.0 work; therefore
  this lane does not silently apply Matterhorn 1.1 to PDF/UA-2.
- [veraPDF validation documentation](https://docs.verapdf.org/validation/)
  states that its PDF/UA profiles cover machine-verifiable checks. The official
  [CLI profiles](https://docs.verapdf.org/cli/validation/) expose `ua1` and
  `ua2`, while the project is available under
  [GPLv3+ or MPLv2+](https://docs.verapdf.org/develop/). The pilot runner can
  invoke a separately installed, hash-pinned veraPDF CLI; no validator binary
  is bundled.
- The official [PAC check guidance](https://pac.pdf-accessibility.org/en/check)
  says machine checking is useful for technical aspects but cannot replace the
  final human check. PAC is not bundled or automated here.
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/) is a separate W3C Recommendation.
  W3C explains that its [techniques are informative rather than normative](https://www.w3.org/WAI/WCAG22/Techniques/about),
  and its [PDF techniques](https://www.w3.org/WAI/GL/WCAG20-TECHS/pdf) include
  tests that require inspection with assistive technology, visual review, tag
  trees, or accessibility APIs. PDF/UA signals are therefore never promoted to
  a WCAG conformance claim.

The ISO catalogue entries and public supporting resources are useful evidence,
but they are not substitutes for licensed access to the complete standards when
building a conformance validator.

## Claim taxonomy

`test/fixtures/eval/accessibility/claim-taxonomy.v1.json` is the normative claim
contract for this evaluation lane. The corpus manifest pins its SHA-256 so an
unreviewed taxonomy change cannot silently alter the runner's claim boundary.
It keeps six concepts separate:

| State | Evidence needed | What v1 can emit |
|---|---|---|
| Structural failures detected | A deterministic check failed | Yes |
| No structural failures detected | Every check in `structural_screen_v1` passed | Yes |
| Machine validation passed | Hash-bound output from an approved, pinned validator/profile adapter | External pilot only; not accepted by the phase-0 claim gate |
| Human review completed | Hash-bound review record covering a versioned checklist, scope, reviewer, and date | No schema exists yet |
| Conformance validated | Complete standard-specific machine and human evidence for the exact document hash | No |
| Certified conformance | Authentic certificate from a named trusted external authority for the exact hash and scope | Never issued by this repository |

The maximum v1 statement after a passing screen is exactly:

> Automated structural screening found no failures among the checks it performed.

That statement must not be shortened to “accessible,” “PDF/UA compliant,”
“WCAG compliant,” or “certified accessible.” A failing screen reports only the
failures it detected; it is not a complete defect inventory and does not by
itself establish non-conformance.

## Executable screen

Run the public-safe corpus with existing repository dependencies:

```bash
node scripts/eval-run-accessibility.mjs
```

Select one partition when needed:

```bash
node scripts/eval-run-accessibility.mjs --partition development
node scripts/eval-run-accessibility.mjs --partition adversarial
```

The versioned scorer checks only these catalog-level signals:

- the file parses;
- `MarkInfo/Marked` is true;
- a non-empty document language and title exist;
- `ViewerPreferences/DisplayDocTitle` is true;
- a structure-tree root has `K` and `ParentTree` entries.

PDF/UA identification metadata is an observation, never a passing check. These
checks cannot determine semantic tag correctness, reading order, alternate-text
quality, table relationships, contrast, script behavior, or assistive-technology
usability. Passing all checks means only that these shallow failures were not
detected.

The claim gate rejects caller-supplied validator, reviewer, and certificate
objects because v1 has no trusted ingestion adapters. This is fail-closed by
design: unverified JSON cannot manufacture conformance.

The runner reports a confusion matrix for each structural rule family. Its
three-document corpus is synthetic calibration only. Those counts are not
PDF/UA false-positive or false-negative rates and must not be generalized to
real documents, other producers, other rule families, or human-verifiable
requirements.

## Fixture and provenance contract

The phase-0 corpus manifest and JSON Schema live under
`test/fixtures/eval/accessibility/`. The loader compiles the published JSON
Schema with Ajv 2020 and `ajv-formats`, then applies semantic invariants the
schema cannot express. These packages are intentionally not new direct
dependencies: they are locked transitives of `@modelcontextprotocol/sdk`, and a
test mechanically checks that exact package-lock relationship and versions.
If the SDK graph stops providing them, evaluation fails until maintainers make
an explicit dependency decision. Every committed PDF must have:

- a stable ID, exact SHA-256, partition, and expected bounded outcome;
- public or synthetic provenance and a reproducible generator when synthetic;
- explicit redistribution permission;
- an explicit privacy record confirming that no personal data is present.

The loader requires exact expected failure sets and exact derived rule-family
sets. An unexpected failure is a false positive and fails the evaluation. Paths
are checked with `lstat` and `realpath`; escapes, symlinked files or path
components, and non-regular files are rejected before scoring.

The three v1 fixtures are deterministic, MIT-licensed synthetic documents:

1. an untagged born-digital PDF that must fail the structural screen;
2. a PDF/UA-identifier decoy with an incomplete structure-tree shape;
3. an adversarial file that passes every shallow check but must remain
   `conformance_not_established`.

Regenerate them with:

```bash
node scripts/eval-generate-accessibility-fixtures.mjs
```

Tests require byte-for-byte reproduction. Personal, confidential, contract, or
customer PDFs are prohibited from this public corpus. A public source may be
added only after its exact source, immutable local hash, license, redistribution
right, and privacy status are reviewed.

The [PDF/UA-1 Reference Suite](https://pdfa.org/resource/pdfua-reference-suite/)
is a promising future public corpus source and is published under CC BY 4.0.
It is not copied into v1: future intake should retain attribution, license text,
upstream version, expected validator profile, and source hashes, then add known
non-conforming counterexamples instead of treating conforming examples as a
complete validator test.

## External veraPDF machine-validation pilot

`formal-corpus.v1.json` pins the official veraPDF Greenfield 1.30.2 installer,
its detached signature file and signer fingerprint, a Temurin 21.0.11+10
runtime, the installed wrapper and CLI JAR, the `ua1` profile, and commit
`49de56cd987929932c9e4fbbbe67d052bf44ef83` of the official
[veraPDF corpus](https://github.com/veraPDF/veraPDF-corpus). That corpus records
CC BY 4.0 licensing and supplies atomic known-good and known-defect files.

The two pilot fixtures exercise only PDF/UA-1 version identification. Fetch
them to an external cache; they are not copied into this repository:

```bash
node scripts/eval-fetch-accessibility-formal-corpus.mjs \
  --output-dir /external/cache/pdfua-corpus
```

After separately obtaining and installing the pinned artifacts, run:

```bash
node scripts/eval-run-accessibility-formal.mjs \
  --corpus-dir /external/cache/pdfua-corpus \
  --validator /external/verapdf/verapdf \
  --validator-artifact /external/cache/verapdf-greenfield-1.30.2-installer.zip \
  --runtime-archive /external/cache/OpenJDK21U-jre_x64_linux_hotspot_21.0.11_10.tar.gz \
  --java-home /external/temurin-jre \
  --report-dir /external/evidence/raw
```

The runner checks all artifact and fixture hashes, the reported validator
version and profile, exactly one normally completed job, batch parsing and
exception counters, typed non-negative rule/check counters with non-zero
evaluated coverage, veraPDF's observed exit semantics (`0` compliant, `1`
non-compliant), and exact failed rule keys. Missing counters cannot be treated
as a passing result. It retains raw reports only in the
caller-selected evidence directory and records their SHA-256. Repository
evidence stores non-normative derived fields rather than copying validator
renderings of standards requirements.

Formal confusion classification uses the validator's compliance boolean: a
non-compliant result on known-good input is a false positive even if its failed
rule keys are unexpected. Exact failed-rule agreement remains a separate hard
expectation gate. Corpus filenames must be single safe PDF basenames, and the
fetcher rejects path escapes, symlinked output components or targets, existing
targets, and non-hash-matching downloads.

The child process does not inherit the caller's environment. It receives the
exact Java home, a minimal path, fixed `C.UTF-8` locale and UTC timezone, and a
disposable home/config/cache/temp tree that is also the child working directory.
`JAVA_TOOL_OPTIONS`, `JDK_JAVA_OPTIONS`,
`_JAVA_OPTIONS`, `CLASSPATH`, user veraPDF configuration, and other ambient
variables are absent. Tests inject hostile parent values and require them not
to reach the validator.

The recorded 2026-07-21 pilot produced one true positive, one true negative,
zero false positives, zero false negatives, and zero harness failures for the
single `version_identification` family. This is a two-file integration proof,
not an estimate of veraPDF accuracy or PDF/UA coverage. The safe repair guidance
is diagnostic only: correcting identification metadata cannot make an otherwise
inaccessible document conformant.

Artifact authenticity is not complete. The official detached signature and
fingerprint are pinned, but the signature was not verified because no trusted
signing key was established in the disposable environment. HTTPS plus recorded
hashes prevents unnoticed drift after this observation but does not replace a
trusted signature chain.

## Required next evidence layers

A future conformance lane should be added only as separately reviewed,
versioned evidence adapters:

1. Establish and document a trusted veraPDF signing key, verify the pinned
   release signature, expand known-good/known-defect coverage across rule
   families, and calibrate repair guidance. Treat validator crashes, skipped
   rules, unknown profiles, and incomplete reports as unavailable evidence.
2. Build standard-edition-specific human checklists derived from licensed
   normative requirements and appropriate supporting protocols. Retain the
   exact document hash, reviewer identity, competence/role, date, scope,
   checklist version, item-level results, exceptions, and assistive-technology
   setup.
3. Require both complete machine and human evidence before a bounded validation
   conclusion. Keep PDF/UA-1, PDF/UA-2, and WCAG conclusions independent.
4. Treat certification as external evidence. Verify issuer, credential,
   signature or authenticity mechanism, document hash, standard edition, scope,
   issue/expiry status, and revocation before displaying the certificate's own
   wording.
5. Re-run the entire assessment after any PDF modification; evidence for one
   hash cannot transfer to another.

Until those adapters and review records exist, the overall work remains phase
0. `not_established` is the only truthful conformance and certification state,
even when the external pilot reports a machine-profile pass.
