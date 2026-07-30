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

### Reproducing the pinned toolchain

The runner does not install anything. Obtain the pinned artifacts yourself and
verify each digest against `formal-corpus.v1.json` before use. The pinned
runtime is a **Linux x64** JRE, so the evaluation reproduces on a Linux x64
host; another platform needs a different archive and therefore different
`runtime` digests in the contract.

```bash
INSTALL=/external/pdf-tools-accessibility
mkdir -p "$INSTALL/dl" && cd "$INSTALL/dl"

curl -sSL -o jre.tar.gz \
  "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.11%2B10/OpenJDK21U-jre_x64_linux_hotspot_21.0.11_10.tar.gz"
sha256sum jre.tar.gz   # must equal runtime.archive_sha256
tar xzf jre.tar.gz -C "$INSTALL"
sha256sum "$INSTALL/jdk-21.0.11+10-jre/bin/java"   # must equal runtime.java_binary_sha256

curl -sSL -o verapdf-installer.zip \
  "https://software.verapdf.org/releases/1.30/verapdf-greenfield-1.30.2-installer.zip"
sha256sum verapdf-installer.zip   # must equal validator.installer_sha256
unzip -q verapdf-installer.zip
```

veraPDF ships an IzPack installer. Install it headlessly with an automation
descriptor that selects the CLI and sets the target directory, then verify:

```bash
"$INSTALL/jdk-21.0.11+10-jre/bin/java" \
  -jar verapdf-greenfield-1.30.2/verapdf-izpack-installer-1.30.2.jar auto.xml
sha256sum "$INSTALL/verapdf/verapdf"              # validator.installed_wrapper_sha256
sha256sum "$INSTALL/verapdf/bin/cli-1.30.2.jar"   # validator.installed_cli_jar_sha256
```

The release signature is recorded in the contract but is **not** verified,
because no trusted veraPDF public key is established for this project. That
remains an open gate and the evidence says so explicitly.

### Installed tree binding

Pinning the installer, wrapper, CLI JAR, runtime archive, and `java` binary
proves those five files are the reviewed ones. It says nothing about the other
files beside them. An attacker able to write into the install directory does not
need to touch a pinned file: adding a JAR next to the pinned one, or editing the
validation profile XML that decides what "compliant" means, changes the evidence
while every pinned hash still matches.

`validator.installed_tree_sha256` and `runtime.installed_tree_sha256` therefore
bind the **complete** listing of both trees: every file by content hash, every
directory, and every symlink by its raw target, walked without following links.
An addition, deletion, edit, type change, or retargeted symlink all change the
digest. Absolute symlink targets and relative targets escaping the tree are
rejected outright rather than folded into the digest, since a link pointing
outside is an evasion of the binding rather than part of it. The pinned JRE
legitimately contains 145 relative symlinks under `legal/`, so rejecting
symlinks wholesale is not an option.

Regenerate the digests after any deliberate toolchain change:

```bash
node -e '
import("./test/eval/accessibility-formal.js").then(async m => {
  for (const root of process.argv.slice(1)) {
    console.log(root, (await m.computeInstalledTreeDigest(root)).digest);
  }
});' "$INSTALL/verapdf" "$INSTALL/jdk-21.0.11+10-jre"
```

After installing and verifying the pinned artifacts, run:

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

Version 1 artifact authenticity is not complete. The official detached signature and
fingerprint are pinned, but the signature was not verified because no trusted
signing key was established in the disposable environment. HTTPS plus recorded
hashes prevents unnoticed drift after this observation but does not replace a
trusted signature chain.

## Version 2 installer provenance candidate

Version 1 and its recorded trial remain frozen evidence. The separately
versioned `formal-corpus.v2.json` adds an installer-authenticity precondition
without changing the two-file corpus or widening its PDF/UA-1 scope.

The official [veraPDF installation documentation](https://docs.verapdf.org/install/)
publishes the full primary OpenPGP fingerprint
`13DD102B4DD69354D12DE5A83184863278B17FE7` and links the public key at
`https://software.verapdf.org/keys/KEY`. Version 2 pins that URL, the exact
5,613-byte key, its SHA-256, the detached signature and installer SHA-256
values, and the exact `/usr/bin/gpgv` executable identity used by the evidence
host. The key, detached signature, installer, verifier, validator, runtime, and
corpus stay outside the repository and outside the extension.

Acquire the exact v2 artifacts without importing the key into a user keyring:

```bash
umask 077
mkdir -p /external/cache/verapdf-v2
curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
  --output /external/cache/verapdf-v2/KEY \
  https://software.verapdf.org/keys/KEY
test "$(wc -c < /external/cache/verapdf-v2/KEY)" -eq 5613
printf '%s  %s\n' \
  30f1dc7fb7c9f3d9796dd9f9dd5d344ebbcf45bef9632d9c47c39cdf254249f2 \
  /external/cache/verapdf-v2/KEY | sha256sum --check --strict

curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
  --output /external/cache/verapdf-v2/verapdf-greenfield-1.30.2-installer.zip.asc \
  https://software.verapdf.org/releases/1.30/verapdf-greenfield-1.30.2-installer.zip.asc
test "$(wc -c < /external/cache/verapdf-v2/verapdf-greenfield-1.30.2-installer.zip.asc)" -eq 659
printf '%s  %s\n' \
  f33175e402f28c42e80866aa62aa337c5d7d7a16a4ea1ae4ff50b0f13343ff26 \
  /external/cache/verapdf-v2/verapdf-greenfield-1.30.2-installer.zip.asc |
  sha256sum --check --strict

curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
  --output /external/cache/verapdf-v2/verapdf-greenfield-1.30.2-installer.zip \
  https://software.verapdf.org/releases/1.30/verapdf-greenfield-1.30.2-installer.zip
printf '%s  %s\n' \
  6cc6341cb1af644044054b81f00a6590a7918abb18f762243de115258bcad838 \
  /external/cache/verapdf-v2/verapdf-greenfield-1.30.2-installer.zip |
  sha256sum --check --strict
```

A candidate v2 run uses only an isolated binary keyring decoded from the pinned
ASCII-armored key. It supplies a disposable home and a minimal environment to
`gpgv`, requires one exact status sequence, and checks the complete primary
fingerprint, signature timestamp, public-key algorithm, digest algorithm, and
signature class. Any malformed, missing, duplicate, fatal, or unexpected status
fails closed. Installer authenticity must pass before the runner creates an
evidence generation or invokes veraPDF.

Before invocation, an external supervisor must attest the clean repository and
capture a closed source/runtime receipt. The supervisor obtains `git rev-parse
HEAD`, `git rev-parse 'HEAD^{tree}'`, and an empty `git status
--porcelain=v1 --untracked-files=normal`; computes SHA-256 and byte size for the
v2 CLI, v2 runner, imported v1 helper, and v2 contract; and records the
realpath, SHA-256, size, and `process.version` for the Node executable. The
receipt has this exact top-level shape:

```bash
test -z "$(git status --porcelain=v1 --untracked-files=normal)"
git rev-parse HEAD
git rev-parse 'HEAD^{tree}'
sha256sum \
  scripts/eval-run-accessibility-formal-v2.mjs \
  test/eval/accessibility-formal-v2.js \
  test/eval/accessibility-formal.js \
  test/fixtures/eval/accessibility/formal-corpus.v2.json
wc -c \
  scripts/eval-run-accessibility-formal-v2.mjs \
  test/eval/accessibility-formal-v2.js \
  test/eval/accessibility-formal.js \
  test/fixtures/eval/accessibility/formal-corpus.v2.json
node -p 'process.version'
node -p 'require("node:fs").realpathSync(process.execPath)'
node -e 'const fs=require("node:fs");const crypto=require("node:crypto");const p=fs.realpathSync(process.execPath);const b=fs.readFileSync(p);console.log(crypto.createHash("sha256").update(b).digest("hex"), b.length)'
```

```json
{
  "receipt_version": 1,
  "receipt_kind": "pdf_tools_accessibility_formal_v2_source_runtime",
  "publication_authorized": false,
  "captured_at": "2026-07-30T00:00:00.000Z",
  "capture_method": "external_supervisor_git_sha256_node_identity_v1",
  "repository": {
    "commit": "40 lowercase hexadecimal characters",
    "tree": "40 lowercase hexadecimal characters",
    "clean_attested": true
  },
  "files": {
    "cli": {"relative_path": "scripts/eval-run-accessibility-formal-v2.mjs", "sha256": "64 lowercase hexadecimal characters", "size": 1},
    "runner": {"relative_path": "test/eval/accessibility-formal-v2.js", "sha256": "64 lowercase hexadecimal characters", "size": 1},
    "v1_helper": {"relative_path": "test/eval/accessibility-formal.js", "sha256": "64 lowercase hexadecimal characters", "size": 1},
    "contract": {"relative_path": "test/fixtures/eval/accessibility/formal-corpus.v2.json", "sha256": "64 lowercase hexadecimal characters", "size": 1}
  },
  "node": {
    "executable_realpath": "/absolute/supervisor-observed/node",
    "executable_sha256": "64 lowercase hexadecimal characters",
    "executable_size": 1,
    "version": "v22.0.0"
  }
}
```

The displayed sizes and versions are shape examples, not pinned values. Replace
them with the exact supervisor observations. Create the receipt as an owned
mode-0600 single-link file no larger than 65,536 bytes and retain the original
outside the run. The runner exact-matches its current source files and live
Node executable to the receipt, copies the receipt into the private generation,
and binds its hash and source/runtime summary into the qualification index.
The Git attestation remains the external supervisor's assertion. A modified
runner can forge self-observation, so a separately retained supervisor receipt
is part of qualification.

Prepare a private, owner-only generation root and run:

```bash
mkdir -m 700 /external/evidence/accessibility-v2
node scripts/eval-run-accessibility-formal-v2.mjs \
  --source-receipt /external/evidence/pdf-tools-source-runtime.v1.json \
  --corpus-dir /external/cache/pdfua-corpus \
  --public-key /external/cache/verapdf-v2/KEY \
  --signature /external/cache/verapdf-v2/verapdf-greenfield-1.30.2-installer.zip.asc \
  --verifier /usr/bin/gpgv \
  --validator /external/verapdf/verapdf \
  --validator-artifact /external/cache/verapdf-v2/verapdf-greenfield-1.30.2-installer.zip \
  --runtime-archive /external/cache/OpenJDK21U-jre_x64_linux_hotspot_21.0.11_10.tar.gz \
  --java-home /external/temurin-jre \
  --generation-root /external/evidence/accessibility-v2
```

The CLI writes only the whitelisted, non-publishable public projection to
standard output. Raw signature status, signature diagnostics, validator
reports, and the qualification index remain in a new mode-0700 private
generation. Files are created mode 0600 with no-follow and exclusive flags,
synced, closed, reopened, rehashed, and bound by an index written last. A
partial generation without that final index is not qualified evidence.

For each corpus input, the runner verifies the source bytes, writes them to a
mode-0600 exclusive no-follow file under the stable disposable runtime home,
reopens and rehashes that staged file, and invokes veraPDF only on the staged
path. It checks the staged inode and bytes again after execution. A persistent
swap at the original corpus path therefore cannot change the bytes attributed
to that validator job.

The runner retains open handles and exact device, inode, mode, and owner
identities for both the generation root and the generation directory. It proves
path and handle agreement before and after every artifact write, before the
index, around directory sync, and before return. Each file is chmodded through
its open handle before file sync, then bound to the same single-link inode
through lstat and no-follow reopen. Generation writes accept safe basenames
only, and directory sync uses the retained handle.

These checks are not equivalent to `openat`. Node does not expose an `openat`
primitive for path creation relative to the retained directory handle. A
same-user actor can therefore target the short proof-to-open micro-race and
restore the expected path before the post-write proof. This candidate detects
persistent root and generation replacement, but does not claim to resist that
transient attack.

Qualification process limits are recursively exact fields in the v2 contract.
They separately cap stdout, stderr, and aggregate bytes and set the timeout,
SIGTERM-to-SIGKILL grace, and process-group-empty proof timeout. Callers cannot
override them through the qualification API. The private index records the
limits used.

The runner launches each external executable in a dedicated process group.
Timeout or output-limit termination sends SIGTERM to the complete group, waits
the contract grace, then sends SIGKILL if needed. A surviving or ambiguously
inspected descendant fails qualification. A low-probability process-group ID
reuse remains an operational risk on a busy shared host because this slice does
not use a cgroup or pidfd supervisor. The runner checks every pinned input and
both complete installed-tree digests before signature verification, after
signature verification, after validator preflight, after each fixture, and
before the index is written.

On failure, the CLI writes only a closed JSON envelope to standard error with
`publication_authorized: false` and a reviewed path-free code. Unknown errors
map to `EVALUATION_FAILED`. It emits no message, cause, stack, input value,
private generation name, signer identity, raw GnuPG status, or diagnostic.
On a completed run, standard output remains only the public projection.

A qualifying v2 run permits only this bounded statement:

> The pinned veraPDF installer signature was verified against the exact OpenPGP key and fingerprint published by veraPDF's official installation documentation.

This statement is anchored to the key and fingerprint served by veraPDF's
official HTTPS documentation. It is not an independently certified public-key
infrastructure chain. The offline run does not refresh key revocation state.
The evidence host kernel, operating system, loader, dynamic libraries, and
Node runtime remain part of the trusted computing base. The source receipt pins
the Node executable, not the complete host. Pre-run, post-run, inode, and handle
checks detect persistent drift, but do not resist a same-user actor able to
substitute and restore bytes during execution or exploit the Node
proof-to-open micro-race.

Synthetic parser and source-order tests cover the post-input authenticity gate.
A full post-input cryptographic failure run still requires the exact external
key, signature, installer, validator, and runtime artifacts on the evidence
host. Until that external run is retained, the control-flow result is
candidate evidence rather than executed cryptographic proof.

Signature verification authenticates the pinned installer only. It does not
establish validator correctness, complete machine-rule coverage, PDF/UA
conformance, WCAG conformance, legal compliance, certification, or document
accessibility. The v2 pilot still covers only two PDF/UA-1
version-identification files and no human-verifiable requirement. Its public
projection therefore carries `publication_authorized: false`, and every
conformance, compliance, and certification state remains `not_established`.

## Required next evidence layers

A future conformance lane should be added only as separately reviewed,
versioned evidence adapters:

1. Independently establish signing-key trust and current revocation status
   beyond the v2 HTTPS key pin, expand known-good/known-defect coverage across
   rule families, and calibrate repair guidance. Treat validator crashes,
   skipped rules, unknown profiles, and incomplete reports as unavailable
   evidence.
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
