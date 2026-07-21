# Vitest 4.1.10 isolated upgrade evidence — 2026-07-21

## Decision

Accept the isolated Vitest 4.1.10 upgrade for integration. Vitest and every
changed package record are development-only, the production dependency
inventory is unchanged, the declared-order test suite discovers and passes the
same tests, and neither the built viewer nor the production MCPB contains a
Vitest delta.

This evidence does **not** approve a release. Release remains gated on the exact
integrated MCPB being installed and exercised in supported stable Claude
Desktop hosts on macOS and Windows. No host installation, push, GitHub action,
Bead mutation, or release was performed in this lane.

## Scope and provenance

- Bead: `pdf-toolkit-mcp-dwk.7`
- Isolated starting commit: `2754783061c3c887b8e391b27c85cf0f383354b8`
- Final integration base: `f6733d464338209be00e828afd75aabde1dee092`
- Node/npm used for verification: Node 22.22.3 and npm 10.9.8 on Linux x64
- Direct manifest delta: `vitest` from `^4.1.4` to `^4.1.10`
- Lockfile before: `e26b433baacae3c89113baa7967ca3afe7d77e5701c26170c721e10f910d9cef`
- Lockfile after: `007e5249462053db87115f5dc414cd00c265f00df6bdeb7a4f9e617a6e76a8ac`

The npm registry reported 4.1.10 under the `latest` tag and 5.0.0-beta.6 under
`beta`. The exact 4.1.10 registry artifact has integrity
`sha512-R9jUTe5S4Qb0HCd4TNqpC7oGcrMssMRGXLW80ubjWsW9VH5GF8y1Y0SFLY9AbqSk6nt0PnOx4H4WNJYZ13GUPw==`
and requires Node `^20.0.0 || ^22.0.0 || >=24.0.0`.
Vitest 4.1.4 declares the same engine range, so the runner update does not raise
the development Node floor. Vite 8.1.5 already imposes the stricter effective
build floor of Node `^20.19.0 || >=22.12.0`.

Primary sources:

- npm package and version history: https://www.npmjs.com/package/vitest?activeTab=versions
- exact immutable signed release: https://github.com/vitest-dev/vitest/releases/tag/v4.1.10
- intervening releases:
  https://github.com/vitest-dev/vitest/releases/tag/v4.1.5,
  https://github.com/vitest-dev/vitest/releases/tag/v4.1.6,
  https://github.com/vitest-dev/vitest/releases/tag/v4.1.7,
  https://github.com/vitest-dev/vitest/releases/tag/v4.1.8, and
  https://github.com/vitest-dev/vitest/releases/tag/v4.1.9

The intervening notes were reviewed specifically for discovery, transforms,
assertions, concurrency, workers, browser security, and reporting. Relevant
changes include static-discovery handling in 4.1.5, concurrency corrections in
4.1.6 and 4.1.7, browser access hardening in 4.1.8, and a worker-crash hang fix
in 4.1.9. Version 4.1.10 adds browser filesystem-access checking and an encoded
URI optimizer-resolution fix. The repository does not use browser-mode Vitest,
coverage plugins, fake timers, or concurrent test options.

## Lockfile boundary

The clean lock regeneration changed ten package records including the root:

- the root `vitest` declaration;
- `vitest` 4.1.4 to 4.1.10;
- seven `@vitest/*` packages from 4.1.4 to 4.1.10; and
- `@types/estree` 1.0.8 to 1.0.9 through Vitest's mocker graph.

All nine non-root records are marked `dev: true`. There are zero changed
production package records. The canonical production-inventory digest, over
package path, version, and integrity, is identical before and after:

```text
31ee00ace40574b9d2b6760264fb0a306741fd2595f2a401b6835d6e7a3e1ee0
```

Protected versions remained unchanged in the lock and installed graph:

| Package | Version |
| --- | ---: |
| `pdfjs-dist` | 5.4.624 |
| `@modelcontextprotocol/sdk` | 1.29.0 |
| `@napi-rs/canvas` | 0.1.99 |
| `@anthropic-ai/mcpb` | 2.1.2 |
| `@modelcontextprotocol/ext-apps` | 1.7.0 |
| `vite` | 8.1.5 |
| `vite-plugin-singlefile` | 2.3.3 |

`npm ls` resolves one Vitest 4.1.10 graph and deduplicates its Vite peer to the
protected Vite 8.1.5 installation.

## Test-runner regression gates

The baseline and candidate were installed with `npm ci` and run from the same
isolated worktree. The focused lane is:

```sh
npx vitest run \
  test/viewer-compat.test.js \
  test/render-pdf-page.test.js \
  test/save-lifecycle.test.js \
  --reporter=verbose
```

| Gate | Vitest 4.1.4 baseline | Vitest 4.1.10 candidate |
| --- | ---: | ---: |
| Full suite | 22 files, 215 passed, 0 failed, 0 skipped | 22 files, 215 passed, 0 failed, 0 skipped |
| Focused viewer/render/lifecycle | 3 files, 16 passed, 0 failed, 0 skipped | 3 files, 16 passed, 0 failed, 0 skipped |
| Built-viewer compatibility | executed and passed | executed and passed |

The full and focused suites were also run with both the default and
`hanging-process` reporters. On the isolated starting graph the result was
exactly unchanged by the runner upgrade:

| Diagnostic | 4.1.4 | 4.1.10 |
| --- | ---: | ---: |
| Full-suite reported handles | 87 `FILEHANDLE` entries | 87 `FILEHANDLE` entries |
| Focused reported handles | 14 `FILEHANDLE` entries | 14 `FILEHANDLE` entries |
| Close behavior | 10-second Vite-server close timeout | same timeout |

The Vitest upgrade receives no credit for that pre-existing lifecycle defect.
The manifest-contract integration changes `vite.config.mjs` separately so the
development bridge is not started under Vitest; its lifecycle result must be
kept separate from this runner comparison.

After rebasing onto the corrected manifest-contract integration, both runner
versions preserved the expanded suite and the repaired shutdown behavior:

```sh
npm exec --yes --package=vitest@4.1.4 -- \
  vitest run --reporter=default --reporter=hanging-process
npx vitest run --reporter=default --reporter=hanging-process
```

| Integrated-graph gate | Vitest 4.1.4 baseline | Vitest 4.1.10 candidate |
| --- | ---: | ---: |
| Full suite | 23 files, 241 passed | 23 files, 241 passed |
| `hanging-process` reporter | no retained handles; normal exit | no retained handles; normal exit |
| Wall time with reporter | 3.94 seconds | 3.47 seconds |

The candidate's exact `npm test` also passed 23 files and 241 tests in 3.70
seconds with no close timeout. The focused viewer/render/lifecycle run passed 3
files and 16 tests in 3.20 seconds with no close timeout.

### Adversarial shuffle finding

A deterministic shuffle exposed a pre-existing order dependency:

```sh
npx vitest run --sequence.shuffle --sequence.seed=410 --reporter=default
```

Two `save-lifecycle` tests fail if the rotation test runs first because all
three tests share one fixed temporary directory initialized only in
`beforeAll`. The later assertions see the rotation test's two PDFs. Running the
minimal reproduction through an explicitly selected Vitest 4.1.4 produces the
identical two failures:

```sh
npm exec --yes --package=vitest@4.1.4 -- \
  vitest run test/save-lifecycle.test.js \
  --sequence.shuffle --sequence.seed=410 --reporter=default
```

This is not a 4.1.10 regression and was fixed separately in `0f9f83b` by using
per-test fixtures. After rebasing, the same full fixed-seed command passed all
23 files and 241 tests under Vitest 4.1.10.

## Viewer and production-artifact gates

`npm run build:ui` used Vite 8.1.5, transformed 149 modules, and reproduced the
checked-in single-file viewer byte-for-byte:

```text
dist-ui/index.html
2ec375e79693954439fe37c4238efc941f27d8245fb41ede915e65a7ec95dfd4
```

`npm run smoke:ui-dev` passed the viewer and MCP bridge gate. The post-build
viewer compatibility test executed one test rather than skipping and rejected
the unsupported ES2025 `Map.getOrInsertComputed` API family.

The exact artifact built after rebasing onto `f6733d4` had:

```text
retained path: /home/mat/.local/state/pdf-vitest-dwk7/integrated-f6733d4-vitest-4.1.10.mcpb
bytes: 75,726,358
files: 3,174
sha256: db9412ecf3911f42f7cc828a41396267ef6c79bf95e95065e629956226cf61ea
```

Archive integrity passed. Its internal production lock has 103 package records
and zero Vitest, `@vitest`, Vite, Rolldown, or `@rolldown` records. It contains
no project `test/` tree and its generated `package.json` has no
`devDependencies`. Hashes of the archived viewer, manifest, runtime server
files, README, license, and icon match their source inputs. Exact-artifact
smoke passed on Linux x64 with 37 discovered tools, 14 prompts, canonical
resources, and a native raster image. The independently installed share-package
contract also passed with 37 tools, 14 prompts, and a canonical PDF resource
round trip.

For separation of evidence, the earlier artifact from the exact isolated
`2754783` graph is retained at
`/home/mat/.local/state/pdf-vitest-dwk7/candidate-base-2754783-vitest-4.1.10.mcpb`
with SHA-256
`020286009365a74df01865d310e2eddf8240d4beb6f1b7e986c8774fc89f05c7`.
Its different identity reflects the independently integrated runtime changes,
not Vitest content in the production package.

## Audit and residual risk

- `npm audit --omit=dev`: 0 vulnerabilities.
- Full `npm audit`: unchanged at 4 low and 2 high, confined to the pre-existing
  MCPB development CLI prompt/editor graph (`tmp` and nested Picomatch).
- `npm audit signatures`: 208 verified registry signatures and 35 verified
  attestations.
- The upgrade changes test infrastructure, not shipped runtime behavior. Its
  chief residual risk is false confidence from changed discovery, scheduling,
  transforms, assertions, or reporter behavior; equal discovery/pass counts,
  focused workflow tests, the hanging-process comparison, and artifact
  exclusion directly address that risk.
- Release still requires the exact integrated artifact's prescribed Claude
  Desktop macOS and Windows installation gates. This lane did not substitute a
  Linux smoke test for those host gates.
