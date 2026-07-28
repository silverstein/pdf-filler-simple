# Recurring Maintainer Review

The recurring maintainer review is a bounded, read-only collector and reporter.
It observes versioned project state, official upstream release facts, public
GitHub intake, a predeclared evaluation slice, and optional release evidence. It
does not accept work, mutate Beads, build or install artifacts, post externally,
or authorize a release.

The executable entry point is:

```bash
npm run review:maintainer
```

The process writes one JSON report to standard output and diagnostics to
standard error. The caller chooses whether and where to retain the report.

## Cadence and triggers

Run the review weekly and on any of these events:

- publication of a final MCP specification;
- a stable MCPB or MCP SDK release;
- a regression in a supported host;
- preparation of a release candidate;
- an evaluation product failure or harness failure.

The repository does not install a cron job, timer, daemon, or service. An
operator-controlled scheduler may invoke the command unattended from a clean,
immutable checkout. Scheduling must not add credentials or broader authority to
the process. The operator must prepare dependencies from the lockfile before
scheduling. The collector never installs or updates its own dependencies, and
ignored `node_modules` does not make an otherwise clean checkout dirty.

## Source contract

Every report binds itself to:

- the SHA-256 of `config/maintainer-review.v1.json`;
- the requested Git ref at collection start and end;
- local `HEAD` at collection start and end, plus `origin/master`;
- observed Node platform and architecture, plus the installed Vitest, SDK,
  `pdf-lib`, and `pdfjs-dist` package metadata identities used by the
  collector;
- the SHA-256 of exported `.beads/issues.jsonl`;
- the previous report ID and SHA-256 when supplied;
- the exact candidate SHA-256 and source commit when release evidence is
  supplied.

The collector reads Beads directly from the exported JSONL. It never invokes
`bd`, `gh`, `npm`, `npx`, a shell, a package install, a build, or a release
command. Child processes are restricted to Git inspection, the repository-pinned
Vitest binary, and `scripts/eval-run.mjs`. Each command uses an argument array,
a scrubbed environment, an output limit, a timeout, and process-group
termination.

Official network collection uses native HTTPS against the exact hosts and
endpoints declared in the versioned configuration. Redirects are rejected.
Per-source, aggregate-byte, page, item, command-output, candidate-size, and
total-runtime limits are enforced. The collector reserves one bounded command
window for final ref verification and caps every remote request and evaluation
to the remaining operational budget. A cap, timeout, moved source, missing
required source, or malformed response produces partial coverage rather than an
implicit pass.

Because files and evaluations use the checked-out working tree, the requested
ref must resolve to local `HEAD`. A mismatch refuses evaluation and produces
partial coverage instead of attributing working-tree evidence to another
commit. Git status and local `HEAD` are captured at both ends of collection.
The start and end local `HEAD` and requested ref must all resolve to the same
commit. A changed status or identity produces partial coverage so a clean
checkout, branch switch, or concurrent working-tree edit cannot silently create
a mixed-source report.

The v1 GitHub collector covers Issues and Pull Requests through the public REST
API. Discussions are an explicit limitation until a separately reviewed,
query-only GraphQL collector exists.

## Modes

```bash
# Routine online review with the predeclared evaluation slice
npm run review:maintainer

# Verify local collection and failure behavior without network access
npm run review:maintainer -- --offline

# Bind temporal changes and comparable score drift to a previous report
npm run review:maintainer -- --previous path/to/previous-report.json

# Bind collection to an immutable candidate ref
npm run review:maintainer -- --ref <commit-sha>

# Emit compact JSON
npm run review:maintainer -- --compact
```

`--skip-eval` is available for a deliberately limited diagnostic run. It never
counts as complete evaluation coverage when evaluation was declared required
for the run.

Release evidence requires all three inputs together:

```bash
npm run review:maintainer -- \
  --ref <source-commit> \
  --candidate path/to/pdf-toolkit-mcp.mcpb \
  --expected-candidate-sha256 <sha256> \
  --release-evidence path/to/release-evidence.json
```

The evidence index must validate against
`schemas/maintainer-release-evidence-input.v1.schema.json`. The candidate bytes,
declared hash, reviewed source commit, package version, and every receipt are
checked for exact binding. Each index row names a safe relative path to a
retained receipt that validates against
`schemas/maintainer-release-receipt.v1.schema.json`. Receipt files and their
parent directories must not be symlinks. The collector reads them with
per-receipt and aggregate limits, recomputes each byte hash, and requires the
receipt envelope's identity, status, artifact, source, and underlying evidence
hash to match the index. Evidence status is limited to:

- `not_supplied`;
- `incomplete`;
- `stale`;
- `automated_checks_pass`;
- `automated_checks_pass_with_limitations`;
- `harness_failure`.

`automated_checks_pass` is not a release-readiness decision. Release publication
always remains an active human gate when a candidate is supplied. Missing,
failed, or stale native-host receipts also activate the host-access gate.
Receipt-byte consistency proves which retained envelope was reviewed. It does
not independently prove that the underlying tool, host, or operator observation
was truthful, so each receipt must bind the SHA-256 of its underlying evidence
and retain its limitations.
The report retains the exact evidence-index hash and bounded metadata for every
verified receipt: receipt and evidence hashes, observation time, and sanitized
source-associated limitations. Any declared index or receipt limitation changes
the report identity and produces `automated_checks_pass_with_limitations` plus a
warning finding, never an indistinguishable unqualified automated pass.

## Evaluation interpretation

The recurring slice has two independent components:

1. A small Vitest bank checks protocol, packaging, and evaluator-contract
   integrity.
2. `scripts/eval-run.mjs --partition development` emits structured product
   scores bound to the manifest's exact corpus version and development fixture
   set.

Each component is classified independently:

- `pass` or `product_pass`: the declared check completed successfully;
- `product_fail`: the harness completed and found a product expectation failure;
- `harness_failure`: execution, timeout, output, parsing, or evaluator identity
  failed;
- `skipped` or `unavailable`: the run did not produce admissible evidence.

A valid product failure is a complete report with findings and exit code 1. It
is not mislabeled as missing coverage. The report partition, corpus version,
fixture IDs, pass bit, result records, and process exit code must agree with the
SHA-bound evaluation contract. Any disagreement is a harness failure, produces
partial evidence, and uses exit code 2.

The report-schema validator currently uses the pinned SDK v1 AJV export. A
future SDK v2 migration must update and requalify that validator import as part
of the migration, not silently inside the recurring review.

Score drift is comparable only when the configured score command, partition,
evaluator, scorers, fixture manifest, exact fixture set, and fixture schema have
the same comparison-key SHA-256. The key also binds the lockfile, installed
`pdf-lib` and `pdfjs-dist` package metadata identities, Node version, platform,
and architecture. Package metadata identity is the installed package version
plus the SHA-256 of its `package.json`; it does not attest installed package
contents, and lockfile integrity is recorded for downstream verification rather
than independently reverified here. An installed scorer version that differs
from the lockfile is a harness failure. A changed key produces
`incomparable_due_to_harness_or_contract_change`, never an apparent improvement
or regression.

A previous report is used for fact and score comparison only when it validates
against the current report schema and carries the exact current configuration
SHA-256. A valid report from another configuration is retained as
`supplied_incompatible` but is not treated as a baseline.

## Report semantics

The report validates against
`schemas/maintainer-review-report.v1.schema.json` and keeps these sections
separate:

- `observations`: bounded source receipts and sanitized public values;
- `facts`: hashes and typed status derived from observations;
- `changes`: fact-level comparison with a supplied previous report;
- `inferences`: versioned rules applied to facts;
- `decisions`: always empty for unattended collection;
- `proposed_work`: unaccepted proposals requiring named authority;
- `github_beads_reconciliation`: public intake and exported tracker drift;
- `evaluation`: product-versus-harness classifications and comparable drift;
- `release_evidence`: exact candidate and receipt binding;
- `human_gates`: standing policy gates and currently active gates;
- `limitations` and `errors`: evidence boundaries that must remain visible.

Remote and tracker strings are treated as untrusted. Control characters,
terminal escapes, token-like values, and common absolute paths are removed or
redacted. Reports include hashes, bounded metadata, and classifications rather
than raw command output, issue bodies, or log tails.
The report ID suffix hashes normalized report content rather than only its
timestamp and source commit, so reports with different observations do not
share an identity.

## GitHub and Beads reconciliation

An open GitHub Issue or Pull Request without an explicit exported Bead reference
is reported as untriaged intake. Lifecycle disagreement between a referenced
GitHub item and its Bead is a finding. When the corresponding collection is
complete, a Bead reference to an absent Issue or Pull Request is also a finding.
Absence is not inferred from a truncated or unavailable collection.

One public item may legitimately map to a parent Bead and bounded child Beads,
so external-reference multiplicity is informational by itself. Canonical
ownership is asserted only through an explicit Bead label:

```text
review-key:<64-lowercase-hex-characters>
```

Two active Beads claiming the same review key are a conflict. A proposal can
name existing Beads, but the collector never creates or updates one. The
control tower reviews an accepted proposal, reuses a canonical Bead where
appropriate, and records the review key explicitly.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Complete collection with no failure, warning, reconciliation, or proposal finding |
| 1 | Complete collection with one or more findings |
| 2 | Partial collection, harness failure, invalid configuration, or invalid input |

Exit code 0 is not a release gate, compatibility claim, security claim, or host
validation receipt.

Exit code 2 intentionally covers both a schema-valid partial report and a fatal
failure before a report can be produced. A scheduler distinguishes them by
checking whether standard output contains a schema-valid report. It must retain
standard error separately and must not treat either form as a pass.

## Human authority

The configuration lists standing gates for public communication, releases,
signature intent and signing, spend, host permissions, and material product
policy. Routine collection leaves them standing. A supplied release candidate
activates release authority, and missing supported-host proof activates host
access.

No report can authorize:

- publishing, replacing, rolling back, or announcing a release;
- GitHub, Slack, release, or community communication;
- signature intent, cryptographic signing, or external document sharing;
- paid inference, paid services, or increased build and hosting spend;
- CUA, Screen Recording, or unavailable host access;
- a product choice that materially changes scope or user experience.

The review is evidence for a maintainer decision. It is never the decision
itself.
