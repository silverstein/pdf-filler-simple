# Vite 8.1.5 integrated upgrade evidence — 2026-07-21

## Verdict

Vite 8.1.5 is ready for exact-artifact Claude Desktop host validation. The
clean dependency resolution, emitted viewer, browser workflows, full test
suite, packed MCPB, extracted Linux runtime, production-security graph, and
archive comparison pass. This is not release approval: the exact retained
candidate still needs the macOS and Windows Claude Desktop matrix below.

This lane starts exactly at integrated commit
`fba2b88022570b69c3508f7ccb8f493bfc17535e`, which includes both the reviewed
production-transitive security refresh and the MCP discovery manifest
contract. It does not replay or hand-merge the earlier experimental lockfile.
The only direct dependency change is Vite `^8.0.9` to `^8.1.5`;
`dist-ui/index.html` is the corresponding checked-in output. Runtime source,
manifests, and production dependency versions do not change.

## Upstream basis

- Vite's signed, immutable
  [8.1.5 release](https://github.com/vitejs/vite/releases/tag/v8.1.5) is dated
  2026-07-16. Its
  [changelog](https://github.com/vitejs/vite/blob/v8.1.5/packages/vite/CHANGELOG.md)
  records the Rolldown and non-major dependency refreshes resolved here.
- The official [Vite 8.1 announcement](https://vite.dev/blog/announcing-vite8-1)
  describes the 8.1 line and its Rolldown-based build pipeline. This repository
  enables none of its experimental modes.
- Vite 8 requires Node 20.19+ or 22.12+ according to the official
  [Vite 8 announcement](https://vite.dev/blog/announcing-vite8#node-js-support).
  Validation used Node 22.22.3 and npm 10.9.8.
- Vite 8.0.9 is affected by the Windows alternate-path deny bypass
  ([GHSA-fx2h-pf6j-xcff](https://github.com/advisories/GHSA-fx2h-pf6j-xcff))
  and Windows UNC/NTLM disclosure
  ([GHSA-v6wh-96g9-6wx3](https://github.com/advisories/GHSA-v6wh-96g9-6wx3)).
  `npm audit` no longer reports Vite after this upgrade.

## Dependency and security isolation

The root manifest changes only Vite. A fresh `npm install --save-dev
vite@8.1.5`, followed by `npm ci --no-audit --no-fund`, regenerated the lock
against the hardened graph and installed 208 packages. The base lock SHA-256
is `7ef1c83b023228b986aefd0a605ca34a0bb1401f324d066d7bac1a99ea7be373`;
the candidate lock SHA-256 is
`e26b433baacae3c89113baa7967ca3afe7d77e5701c26170c721e10f910d9cef`.

All explicitly gated direct packages remain fixed:

| Package | Resolved version |
| --- | ---: |
| `vite` | 8.1.5 |
| `pdfjs-dist` | **5.4.624 exact** |
| `@modelcontextprotocol/sdk` | 1.29.0 |
| `@modelcontextprotocol/ext-apps` | 1.7.0 |
| `@napi-rs/canvas` | 0.1.99 |
| `vitest` | 4.1.4 |
| `@anthropic-ai/mcpb` | 2.1.2 |
| `vite-plugin-singlefile` | 2.3.3 |

An object-level lock comparison found 29 changed records: the root declaration
and 28 development-only records in Vite's build graph. Those records are Vite,
Rolldown and its platform bindings, Oxc types, PostCSS, Picomatch, Tinyglobby,
Nano ID, and their WASM support packages. Every changed resolved artifact is
from the npm registry. There is no production package change.

Adversarial comparison against the hardened base and inspection inside the
packed candidate confirm that the security-transitive versions remain:

| Production transitive | Retained version |
| --- | ---: |
| `@hono/node-server` | 1.19.14 |
| `body-parser` | 2.3.0 |
| `express-rate-limit` | 8.6.0 |
| `fast-uri` | 3.1.4 |
| `hono` | 4.12.31 |
| `ip-address` | 10.2.0 |
| `path-to-regexp` | 8.4.2 |
| `qs` | 6.15.3 |

`npm ls --omit=dev --all` passes. `npm audit --omit=dev` reports zero known
vulnerabilities before and after the upgrade. The complete development-tree
audit improves from seven findings (four low, three high) to six (four low,
two high) because the Vite high-severity entry is removed. The remaining
findings are development-only paths under the fixed MCPB CLI and its prompt
stack; there is no production finding. Registry signature verification passes
for 208 packages, with 35 verified attestations.

## Build and emitted-viewer review

`npm run build:ui` transformed 149 modules and emitted exactly one
self-contained file:

- integrated Vite 8.0.9 baseline: 3,449,568 bytes, SHA-256
  `921d20ee7ba4333ff28d063853201bfcb4489a0c4b39c8d71a1331deb02b4520`;
- Vite 8.1.5 candidate: 3,449,686 bytes, SHA-256
  `2ec375e79693954439fe37c4238efc941f27d8245fb41ede915e65a7ec95dfd4`;
- one inline `<script>` and one inline `<style>`;
- no script `src`, linked stylesheet, external or `file:` asset reference, or
  external CSS `url()`;
- no `Map.getOrInsert`, `Map.getOrInsertComputed`, `Map.groupBy`,
  `Object.groupBy`, or explicit modern `Set.prototype` method invocation.

The focused built-viewer compatibility test executed and passed. The full
suite passed 21 files and 212 tests. Vitest prints its known 10-second
close-timeout warning after successful completion; this also occurs on the
unmodified baseline and does not change the result.

## Browser validation

All six loopback browser workflows passed against Vite 8.1.5:

- development viewer and MCP bridge;
- sign mode and confirmation-modal flow;
- signature placement on 90-, 180-, and 270-degree rotated pages;
- inspect-region preview;
- preview-to-sign-zone handoff;
- drawn-signature flow.

Browser runs used Chromium's `--no-sandbox` launch argument because this VM
disables the unprivileged-user-namespace sandbox. Navigation was restricted to
`127.0.0.1` and `localhost`. Neither setting is part of the product or build.

## Exact packed artifact

`npm run build:mcpb` passed manifest validation and verified all five required
native canvas bindings. `npm run smoke:mcpb -- pdf-toolkit-mcp.mcpb` then
extracted the candidate on Linux x64, discovered 37 tools, and returned an
image from native rasterization.

Candidate retained outside Git:

- path:
  `/home/mat/.local/state/pdf-vite-815-integrated/candidate-vite-8.1.5.mcpb`
- 3,173 files
- 75,724,492 ZIP bytes
- 189,910,498 uncompressed bytes
- SHA-256:
  `0df0cd0d96ea8eb9cc028bb354aca8e7bebcbf658a3513ae84edc0ec791caa48`

The archived viewer SHA-256 exactly equals the checked-in candidate viewer
hash. Archive integrity testing reports no compressed-data errors. The
production archive contains neither Vite, Vitest, nor Rolldown package trees.

The exact integrated Vite 8.0.9 baseline contains the same 3,173 paths and is
75,724,414 ZIP bytes / 189,910,380 uncompressed bytes. A recursive extracted
comparison found one and only one content difference:
`dist-ui/index.html`. A deterministic digest over every other file is identical
for both archives:
`600d45ed455fec55261f4faee3f9189f24b2a87d69986520266bdce287c88c0f`.
Thus all other 3,172 files—including runtime source, manifests, the security-
refreshed production graph, SDK, PDF.js, SBOM/package inventory, and staged
native bindings—are byte-identical.

## Remaining host-only gates

Before merging or releasing, install the exact retained candidate on clean or
isolated Claude Desktop profiles on macOS and Windows and prove:

1. extension install, enable, restart, and 37-tool discovery;
2. `display_pdf` renders a multipage PDF with no viewer or console errors;
3. page navigation, zoom, search, theme, form sidebar, and reopen work;
4. no `getOrInsertComputed` or other compatibility error appears in Claude
   Desktop logs;
5. the installed extension tree corresponds to the retained candidate hash;
6. Windows x64 and macOS native page rasterization pass from the installed
   artifact.

Until both host rows pass, the correct state is **candidate ready, host gate
pending**. No push, GitHub mutation, release, host install, or signing action is
part of this lane.
