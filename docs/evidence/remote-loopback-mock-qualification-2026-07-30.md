# Synthetic loopback remote MCP qualification, 2026-07-30

## Outcome and claim boundary

Commit `7c72e10d6d0d22409e802cf292734cae21773658` qualifies the
repository-only synthetic loopback mock selected by the frozen remote and
hybrid architecture. The mock exercises the request, authority, identity,
idempotency, receipt, lifecycle, bounds, and no-egress contracts without
creating a production service or adding the mock to the MCPB.

The qualified Git tree is
`45c4dfb3d5f71da987cd7f63eeb553eaf0ae3181`. Its exact identities are:

| Authority | SHA-256 |
|---|---|
| Loopback mock configuration | `621a862f1aa3bfba144becd73b73a4eb25d2b00d888b647606ebb1b0c6b4a1d9` |
| Remote and hybrid architecture contract | `3783deb63beeb1fe48aa545ca58db861864ccb794a2c8fcc156f06a5b3999627` |
| Machine-readable architecture file | `44678af373a64debf7df3f3f4934be5b70c3ed5bc13e099e72fa4782e9d35ce7` |
| Architecture decision record | `8be4894f05ad8bdeeb0fac1ed23d8aaf3801166bb0e8bbb5b6d2165122c6b46f` |

This receipt's machine-readable command and result summary is
[`remote-loopback-mock-qualification-2026-07-30.json`](remote-loopback-mock-qualification-2026-07-30.json).
Its SHA-256 is
`7c446a3b6a039e9b2c7a28eba67bbec71a0ae2e6fe2b1b48b90f70e5c6694d0e`.

This is contract-mock and archive evidence. It is not evidence of a deployed
remote MCP, OAuth, provider integration, cloud custody, user-document
processing, Claude Desktop remote compatibility, or universal host
compatibility. No provider account, production storage, real authentication,
user, customer, confidential, or production PDF, release, tag, deployment, or
extension installation was involved. The architecture verdict remains
`GO_ARCHITECTURE_WAIT_PRODUCTION`.

## Qualified contract

The dependency-free harness exposes only `server/discover`, `tools/list`, and
five synthetic actions through standard `tools/call`. It:

- binds an OS-selected port on exact IPv4 `127.0.0.1`;
- accepts only committed synthetic fixture identities through a trusted
  in-process authority that is not reachable through HTTP;
- treats synthetic harness headers as test data, never as OAuth evidence;
- freshly verifies actor, scope, tenant, workspace, object, source, and
  authorization before new mutation work;
- reserves the tenant-plus-actor idempotency key, single-use authorization
  event, and current source before the first asynchronous boundary;
- commits exactly one immutable output version, current pointer, operation,
  receipt, and effect for a successful mutation;
- keeps failed-operation evidence while leaving versions, pointers, receipts,
  lifecycle, and effect count unchanged on a running failure;
- proves independent idempotency namespaces for actors and tenants, while
  denying same-tenant cross-actor receipt access;
- separates active, tombstoned, purge-pending, and physically-purged states;
- bounds request envelopes, records, strings, responses, body time, and
  shutdown behavior; and
- denies DNS, fetch, external sockets, TLS, UDP, subprocesses, bare packages,
  internal module-loader access, indirect evaluation, and function
  constructors in the reviewed runtime closure.

The packaging policy excludes the test harness, test fixtures, scripts, and
the exact loopback mock configuration from the production MCPB.

## Exact final focused qualification

The exact frozen commit and tree were transferred privately to the designated
Apple Silicon Mac and verified before execution. On macOS 26.6 arm64 with
Node 26.3.1, the focused bank passed:

| Suite | Tests |
|---|---:|
| Architecture contract and verifier | 31 |
| Loopback transport | 51 |
| Loopback state | 22 |
| Wire and state integration | 6 |
| No-egress runtime | 6 |
| Bounds and cleanup | 8 |
| MCPB archive policy | 11 |
| Test-runner source identity | 18 |
| **Total** | **153/153** |

The architecture verifier rejected all 30 adversarial mutants. Concealed
module-loader probes were denied 3/3 with guard telemetry. Nine product-path
operations used nine exact loopback sockets with zero external socket, DNS,
fetch, TLS, UDP, subprocess, or unreviewed-loader telemetry.

Transport checks independently calibrated the bind host and port predicates.
The selected listener was exact `127.0.0.1`, and a connection to the Mac's
assigned non-loopback interface returned `ECONNREFUSED`.

## Same-host aggregate differential

The public parent `e6e3b18d9e2bb22e77439846e9c3f1594ad51b35` and exact
implementation `7c72e10d6d0d22409e802cf292734cae21773658` were run on the
same Mac with the same installed dependency graph. Raw command logs and
normalized failure headings were retained and hashed.

| Exact seam | Files | Passed | Failed | Skipped | Total |
|---|---:|---:|---:|---:|---:|
| Public parent | 110 | 1,594 | 101 | 13 | 1,708 |
| Exact implementation | 115 | 1,687 | 101 | 13 | 1,801 |

All changed suites passed and the implementation added 93 passing checks. Both
logs produced the exact same 102 sorted failure-heading lines at SHA-256
`f1defd674f9f22e0c443a71cf2212cea9c5e3afc6855a39b3ba877c0a91370fb`,
proving zero candidate-only failure heading. Vitest reports 101 failed tests
because one heading is not an additional failed test. The exact raw-log hashes,
commands, counts, and durations are in the machine-readable receipt.

## Production archive boundary

`npm run build:mcpb` performed two clean isolated builds on the Mac. The
archives were byte-identical:

| Property | Result |
|---|---|
| SHA-256 | `22669c81950d7141d1b80b6387f9667f37100d16e666839f9002c6b95ca22364` |
| Bytes | 73,592,352 |
| Files | 2,999 |
| Larger isolated-build peak RSS | 868,672 KiB |
| Reproducibility | Two clean builds were byte-identical |
| Pinned MCPB consumer | Info and unpack passed |

The packed Darwin arm64 smoke passed with 40 tools, 14 prompts, canonical
resources, and a native raster image. Presence of the intended Darwin, Linux,
and Windows native assets is static inventory evidence; this run executed only
Darwin arm64. The archive retained exact `pdfjs-dist@5.4.624` and did not
contain the synthetic remote mock.

## Adversarial review

Three separate final adversarial maintainer review lanes consumed the exact
frozen commit, tree, configuration, architecture digests, preceding focused
test and runtime evidence, actor matrix, receipt rules, and packaging boundary.
All three returned `GO` with zero P0, P1, or P2 findings. These were maintainer
review lanes, not external or third-party assurance.

Earlier review rounds found and drove repairs for cross-object idempotency,
output identity collision, incomplete MCP result shapes, replay semantics,
pre-activation revocation, response-envelope bounds, guard predicate
coupling, internal-loader escapes, state saturation, packaging
source-coupling, duplicate-header behavior, cleanup races, indirect
evaluation, digest-chain drift, and actor-matrix ambiguity.

## Remaining gates

- Keep production remote and hybrid operation at `WAIT`.
- Design real authentication and authorization as a separately reviewed
  production boundary.
- Qualify any future provider, custody, storage, download, retention, deletion,
  and audit implementation against the ten frozen production flip gates.
- Repeat archive and native-host qualification for any source or dependency
  change that alters the MCPB hash.
- Install and drive any release candidate through current Claude Desktop only
  at the separate human/CUA release gate.
