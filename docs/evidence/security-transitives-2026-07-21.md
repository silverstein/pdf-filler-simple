# Production transitive security refresh — 2026-07-21

## Scope and decision

This tranche refreshes only vulnerable production transitive packages already
allowed by the dependency ranges of `@modelcontextprotocol/sdk` 1.29.0 and its
existing graph. It does not change `package.json`, public APIs, application
source, or any direct dependency range.

The following dependency families are explicit invariants for this change:

| Component | Locked invariant |
| --- | ---: |
| `@modelcontextprotocol/sdk` | 1.29.0 |
| `@napi-rs/canvas` | 0.1.99 |
| `pdfjs-dist` | 5.4.624 exact |
| `@anthropic-ai/mcpb` | 2.1.2 |
| `@modelcontextprotocol/ext-apps` | 1.7.0 |
| Vite | 8.0.9 |
| Vitest | 4.1.4 |

## Before state

At 2026-07-21T06:43Z, `npm audit --omit=dev` reported eight vulnerable
production package entries: zero critical, three high, four moderate, and one
low. All eight descend exclusively from the locked MCP SDK:

```text
@modelcontextprotocol/sdk@1.29.0
├── @hono/node-server@1.19.11
├── ajv@8.18.0 → fast-uri@3.1.0
├── express-rate-limit@8.3.1 → ip-address@10.1.0
├── express@5.2.1
│   ├── body-parser@2.2.2 → qs@6.15.0
│   ├── qs@6.15.0
│   └── router@2.2.0 → path-to-regexp@8.3.0
└── hono@4.12.8
```

The affected entries and the versions selected within their existing parent
ranges are:

| Package | Audit severity | Before | Selected |
| --- | ---: | ---: | ---: |
| `@hono/node-server` | moderate | 1.19.11 | 1.19.14 |
| `body-parser` | low | 2.2.2 | 2.3.0 |
| `express-rate-limit` | moderate through `ip-address` | 8.3.1 | 8.6.0 |
| `fast-uri` | high | 3.1.0 | 3.1.4 |
| `hono` | high | 4.12.8 | 4.12.31 |
| `ip-address` | moderate | 10.1.0 | 10.2.0 |
| `path-to-regexp` | high | 8.3.0 | 8.4.2 |
| `qs` | moderate | 6.15.0 | 6.15.3 |

The audit records include the public advisories
[GHSA-92pp-h63x-v22m](https://github.com/advisories/GHSA-92pp-h63x-v22m),
[GHSA-v422-hmwv-36x6](https://github.com/advisories/GHSA-v422-hmwv-36x6),
[GHSA-v2v4-37r5-5v8g](https://github.com/advisories/GHSA-v2v4-37r5-5v8g),
[GHSA-q3j6-qgpj-74h6](https://github.com/advisories/GHSA-q3j6-qgpj-74h6),
[GHSA-v39h-62p7-jpjc](https://github.com/advisories/GHSA-v39h-62p7-jpjc),
[GHSA-j3q9-mxjg-w52f](https://github.com/advisories/GHSA-j3q9-mxjg-w52f),
[GHSA-27v5-c462-wpq7](https://github.com/advisories/GHSA-27v5-c462-wpq7),
and [GHSA-q8mj-m7cp-5q26](https://github.com/advisories/GHSA-q8mj-m7cp-5q26),
plus the Hono advisories aggregated by the npm audit service for 4.12.8.

## Reachability review

PDF Tools imports only `McpServer` and `StdioServerTransport`; it does not
instantiate an HTTP, OAuth, SSE, or Streamable HTTP server. Most of the findings
are therefore shipped but not imported by the current executable path:

- `@hono/node-server` is imported by the SDK's Streamable HTTP transport.
- `hono` is used by SDK web-standard transport/examples, not the PDF Tools
  stdio entry point.
- Express, `body-parser`, `qs`, `path-to-regexp`, `express-rate-limit`, and
  `ip-address` support SDK HTTP/OAuth handlers that PDF Tools does not import.
- `fast-uri` is different: `McpServer` constructs the SDK's AJV validator, and
  AJV uses `fast-uri` while compiling JSON Schemas. PDF Tools supplies those
  schemas locally rather than accepting attacker-provided schemas, but this is
  a live stdio-process dependency and not merely dormant archive content.

Dormant reachability does not justify shipping known-vulnerable code. The
packages remain in the exact MCPB because SDK 1.29.0 publishes a monolithic
production graph, and future transport work could make the HTTP paths live.
Refreshing the allowed transitive versions is lower risk than changing the SDK
or attempting an unreviewed production-pruning strategy in this tranche.

## Lockfile method and graph review

The narrow resolution command is a package-lock-only update naming exactly the
eight audit entries:

```sh
npm update --package-lock-only --ignore-scripts --omit=dev \
  @hono/node-server body-parser express-rate-limit fast-uri hono \
  ip-address path-to-regexp qs
```

A disposable candidate resolution reduced the production audit to zero and
left every direct dependency version unchanged. In addition to the eight named
entries, npm resolves compatible supporting updates for `es-object-atoms`,
`hasown`, `side-channel`, `side-channel-list`, and `type-is`, and adds nested
`content-type` 2.0.0 instances required by `body-parser` 2.3.0 and `type-is`
2.1.0. Those packages require no newer runtime than Node 18, matching the
project's existing minimum.

The before lock SHA-256 was
`a1e6de35b1aa2bf169893fe6b4e0a0de67cfe8468a8bac0c000fa9164fd6b264`.
The baseline MCPB contained 3,172 files, 101 locked production package entries,
and 189,733,315 uncompressed bytes. Its local-build ZIP SHA-256 was
`bc1b3459dbb4c7fb947e5fd0b4b916c7a40ed98b03671741aac52da51feb9d73`.
ZIP timestamps make whole-archive hashes build-specific, so the final review
also compares extracted file paths and content, especially source, UI, PDF.js,
and all native bindings.

The installed baseline dependency set passed npm registry signature
verification for 206 packages; 32 also carried verified registry attestations.

## After state and verification

The applied lock SHA-256 is
`7ef1c83b023228b986aefd0a605ca34a0bb1401f324d066d7bac1a99ea7be373`.
`npm audit --omit=dev` reports zero known vulnerabilities at the time of this
review. The installed candidate contains 208 packages with verified npm
registry signatures; 33 also have verified registry attestations.

Adversarial lock review found 29 changed package records. Fifteen are
functional transitive changes: the eight selected packages, compatible
supporting updates to `es-object-atoms`, `hasown`, `side-channel`,
`side-channel-list`, and `type-is`, plus the two nested `content-type` package
locations. The other 14 records only gained npm registry license metadata;
their versions, resolutions, integrity hashes, dependency declarations, and
engine declarations did not change. Every changed resolution is on the npm
registry. There are no direct, SDK, PDF.js, native, MCPB, ext-apps, Vite, or
Vitest changes.

Verification ran on Linux x64 with Node 22.22.3 and npm 10.9.8:

| Gate | Result |
| --- | --- |
| Clean install from candidate lock | 208 packages installed |
| Full Vitest suite | 20 files and 193 tests passed |
| Production UI build | Passed with Vite 8.0.9; one self-contained 3,449.56 kB HTML file |
| Built viewer compatibility guard | 1 test passed |
| SDK module compatibility | stdio, AJV/MCP server, Streamable HTTP, Express, and OAuth router imports passed |
| Raw initialize, current protocol | 2025-11-25 negotiated; stdout contained one JSON-RPC response |
| Raw initialize, earlier protocol | 2024-11-05 negotiated; stdout contained one JSON-RPC response |
| Raw initialize, unknown offer | cleanly negotiated the server's 2025-11-25 version without stdout leakage |
| Exact MCPB archive integrity | ZIP test passed |
| Extracted MCPB smoke | 37 tools discovered; native rasterization returned an image |
| Production archive hygiene | no Vite, Vitest, MCPB CLI, or ext-apps development packages present |
| Lock graph consistency | `npm ls --omit=dev --all` passed |
| Diff credential-pattern scan | no findings |

The candidate MCPB evidence is:

| Measure | Baseline | Candidate |
| --- | ---: | ---: |
| ZIP bytes | 75,681,413 | 75,721,894 |
| Uncompressed bytes | 189,733,315 | 189,902,962 |
| Files | 3,172 | 3,173 |
| Locked production package entries | 101 | 103 |
| Package inventory SHA-256 | `99e76110e647929837299af5e398005be513b6f2eb5303a080b4a1cec0d788e7` | `cdf722ad1cc12f68ab2284e3038b449cd36ef8279ecff2476abedec56d3b75e8` |
| CycloneDX components | 247 | 249 |
| CycloneDX dependency nodes | 248 | 250 |
| Sorted CycloneDX purl SHA-256 | `a12af2a2fccb9c79605350af2847e8942635867f433883a18df9f2c2195df20d` | `a217bc7b89ae0f84a07d646874403a38dbd3204a5f28499e7ae351f84da30d3a` |
| Local ZIP SHA-256 | `bc1b3459dbb4c7fb947e5fd0b4b916c7a40ed98b03671741aac52da51feb9d73` | `722f48f049d0c27cbfb4f86a061105c921c6de7a253e46fa831117e42d959a0e` |

An extracted content comparison found 211 changed files: 12 added, 11
removed, and 188 modified. Every change is inside one of the reviewed
transitive package directories or `node_modules/.package-lock.json`; there are
zero unexpected paths. The following protected content is byte-identical
between archives:

- `server/index.js`, the MCPB manifest, runtime `package.json`, and built UI;
- `@modelcontextprotocol/sdk` 1.29.0;
- `pdfjs-dist` 5.4.624, including its built `pdf.mjs`;
- `@napi-rs/canvas` 0.1.99 and every staged platform-native binding.

## Residual release gates

This is a reviewed, test-complete Linux artifact candidate, not a published
release. Before release, install this exact candidate hash in supported stable
Claude Desktop builds and repeat tool discovery, native rendering, viewer
rendering, and fresh-session restart checks on macOS and Windows. The prior
known-good host evidence applies to the baseline artifact, not automatically to
this new archive.

The share ZIP has a separately tracked reproducibility weakness because it
ships ranged dependencies without this production lock or preinstalled graph.
No claim in this record extends the MCPB result to that independently resolved
artifact.

Finally, a zero-result npm audit is a point-in-time advisory database result,
not proof that the graph is vulnerability-free. Release review must rerun the
audit, signature verification, exact archive inventory, and supported-host
matrix against the artifact actually being distributed.
