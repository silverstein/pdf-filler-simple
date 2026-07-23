# Dependency and protocol audit — 2026-07-21

This audit records the stable production baseline for PDF Tools 0.8.6 and the
regression gates required before changing the MCP, MCPB, viewer, build, test,
or native-rendering stacks. It is intentionally a decision record, not an
upgrade sweep.

## Decision summary

Do not merge the current Dependabot pull requests as-is.

| PR | Proposed change | Decision |
| --- | --- | --- |
| [#37](https://github.com/Open-Document-Alliance/PDF-Tools/pull/37) | Vitest 4.1.4 to 4.1.5 | Close or supersede; test current 4.1.10 alone. |
| [#38](https://github.com/Open-Document-Alliance/PDF-Tools/pull/38) | ext-apps 1.7.0 to 1.7.1 | Supersede with the isolated 1.7.4 candidate. Synthetic lifecycle, differential, and archive gates pass; native host gates remain. |
| [#39](https://github.com/Open-Document-Alliance/PDF-Tools/pull/39) | Vite 8.0.9 to 8.0.10 | Close or supersede; 8.0.10 remains in security-affected ranges. Test 8.1.5 alone. |
| [#40](https://github.com/Open-Document-Alliance/PDF-Tools/pull/40) | `@napi-rs/canvas` 0.1.99 to 1.0.0 | Close or defer; 1.0.0 has a Windows ARM64 packaging defect. Consider 1.0.2 only after native archive gates are strengthened. |
| [#41](https://github.com/Open-Document-Alliance/PDF-Tools/pull/41) | PDF.js 5.4.624 to 5.7.284 | Close or defer. Keep 5.4.624 pinned exactly until an explicit Claude Desktop compatibility strategy and exact-artifact host matrix pass. |

## Stable baseline

Versions were checked against official release/specification sources on
2026-07-21.

| Component | Production baseline | Stable upstream checked |
| --- | ---: | ---: |
| PDF Tools | 0.8.6 | 0.8.6 |
| `pdfjs-dist` | **5.4.624 exact** | [6.1.200](https://www.npmjs.com/package/pdfjs-dist) |
| `@napi-rs/canvas` | 0.1.99 | [1.0.2](https://www.npmjs.com/package/@napi-rs/canvas) |
| `@modelcontextprotocol/ext-apps` | **1.7.4 exact** | [1.7.4](https://www.npmjs.com/package/@modelcontextprotocol/ext-apps) |
| `@modelcontextprotocol/sdk` | 1.29.0 | [1.29.0](https://www.npmjs.com/package/@modelcontextprotocol/sdk) |
| `@anthropic-ai/mcpb` | 2.1.2 | [2.1.2](https://github.com/modelcontextprotocol/mcpb/releases/tag/v2.1.2) |
| Vite | 8.0.9 | [8.1.5](https://github.com/vitejs/vite/releases/tag/v8.1.5) |
| Vitest | 4.1.4 | [4.1.10](https://github.com/vitest-dev/vitest/releases/tag/v4.1.10) |
| MCP protocol | 2025-11-25 | [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25) |
| MCPB manifest | 0.3 | [0.3](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md) |

Until the planned 2026-07-28 MCP specification is final, supported by a stable
SDK, and adopted by target hosts, retain SDK 1.29.0, protocol 2025-11-25, MCPB
2.1.2, and manifest 0.3. Track the post-final migration separately; do not
pre-implement an SDK v2 beta or release candidate in the production extension.

## Confirmed PDF.js regression

The dependency failure from April 2026 was `pdfjs-dist` 5.6.205:

1. Commit [`4500b89`](https://github.com/Open-Document-Alliance/PDF-Tools/commit/4500b894ec55fc06d0a5775761df8f1f07dc503d)
   upgraded PDF.js from the 5.4 line to `^5.6.205` in v0.7.1.
2. Local build, unit, stdio, and MCPB checks passed, but no installed Claude
   Desktop viewer gate ran.
3. Commit [`d3b23d3`](https://github.com/Open-Document-Alliance/PDF-Tools/commit/d3b23d36a307544bbe79beb241ec2d31ff67993d)
   pinned 5.4.624 exactly in v0.7.3 because 5.6.205 called
   `Map.prototype.getOrInsertComputed`, which the Claude Desktop Chromium
   runtime did not provide. Every PDF viewer render failed.
4. PDF.js 5.7.284 uses the same modern Map API family, raises the Node engine
   floor, and changes the optional native canvas graph. Server-side tests can
   therefore pass while the packed Desktop viewer fails.

Every future PDF.js change must be isolated from all other dependency changes
and pass both gates below:

```sh
npm ci
npm run build:ui
npx vitest run test/viewer-compat.test.js
```

The compatibility test must fail rather than skip when `dist-ui/index.html` is
missing. Then install the exact recorded MCPB hash on supported stable Claude
Desktop hosts and assert a nonblank first-page canvas, populated form sidebar,
navigation, zoom, and search. Logs must contain neither viewer render errors nor
`getOrInsertComputed is not a function`. Record the Desktop, Electron,
Chromium, Node, OS, and architecture versions.

## Isolated upgrade gates

### Vite 8.1.5

Vite 8.0.10 remains affected by the official Windows dev-server
[UNC/NTLM disclosure](https://github.com/advisories/GHSA-v6wh-96g9-6wx3) and
[`fs.deny` alternate-path bypass](https://github.com/advisories/GHSA-fx2h-pf6j-xcff).
A fresh 8.1.5 candidate must be the only dependency change. Require a clean UI
build, a single self-contained HTML file with no external or `file:` assets,
the built viewer compatibility test, browser smoke, MCPB archive diff, and
installed macOS/Windows viewer workflows.

### Vitest 4.1.10

Upgrade Vitest alone. Record discovered, passed, failed, and skipped counts;
run the full suite and focused viewer/render/lifecycle tests; prove the built
viewer compatibility test executed; and verify the production archive contains
no test-runner dependencies or unexpected runtime delta.

### ext-apps 1.7.4

The isolated 1.7.4 candidate passed the standalone bridge, exact initialize
contract, built-browser lifecycle, delayed-operation teardown, deterministic
viewer, candidate-versus-control full-suite differential, reproducible MCPB,
archive-delta, and packed native-raster gates. The retained evidence is
[ext-apps 1.7.4 isolated upgrade evidence](evidence/ext-apps-1.7.4-2026-07-23.md).

Wrapper version still does not establish target-host support. Test the exact
packed MCPB in Claude Desktop on macOS and Windows. Exercise resource fetch,
`App.connect()`, initial tool result, app-to-server calls, host context, theme,
resize, fullscreen/display mode, close/reopen/reconnect, signing, and error
propagation. Prove text-only fallback in a non-Apps host. Use the official
[MCP Apps client matrix](https://modelcontextprotocol.io/extensions/apps/overview)
when recording support.

### `@napi-rs/canvas` 1.0.2

Version 1.0.0 omitted a Windows ARM64 auxiliary file; v1.0.1 fixed static CRT
handling and the missing `icudtl.dat`. A root 1.x upgrade also cannot satisfy
PDF.js 5.4's `^0.1.88` range, which can introduce a second nested native canvas
tree that current top-level archive checks do not remove.

Before considering 1.0.2, require:

- `npm ls @napi-rs/canvas --all` reports exactly one implementation version.
- No `pdfjs-dist/node_modules/@napi-rs` tree exists in the archive.
- Archive verification checks auxiliary assets such as Windows `icudtl.dat`,
  not only `.node` files.
- Extracted artifact smoke passes on darwin-arm64, darwin-x64,
  linux-x64-gnu, win32-x64, and win32-arm64.
- Real supported Claude Desktop macOS and Windows hosts render page, region,
  and scanned-PDF fallback workflows after clean install and restart.
- PDF.js remains fixed during the canvas change.

## Protocol, security, and reproducibility gates

The current server should negotiate protocol 2025-11-25 and supported earlier
versions 2025-06-18, 2025-03-26, 2024-11-05, and 2024-10-07, while rejecting
incompatible versions cleanly. Exercise initialize, discovery, schemas,
annotations, structured content, Apps resources, cancellation, timeout, large
results, malformed JSON-RPC/PDF input, shutdown, disconnect, reconnect, and
restart. Keep stdout protocol-only and diagnostics on stderr.

The audit found eight production transitive advisory entries in the current
lock (0 critical, 3 high, 4 moderate, 1 low), mostly through the monolithic SDK
graph. First try a lockfile-only transitive refresh while retaining SDK 1.29.0,
then inspect reachability, advisory delta, archive/SBOM delta, protocol tests,
and real-host evidence. Do not move to an SDK beta solely to clear audit output.

The share ZIP copies a ranged `package.json` without a lockfile or production
`node_modules`; a clean install can resolve a graph different from the MCPB.
Until the share package has a locked or prepacked production graph, test it
independently on every release platform and do not treat MCPB evidence as proof
for the share artifact.

## Safe sequencing

1. Freeze and record a known-good 0.8.6 artifact and installed-host baseline.
2. Refresh vulnerable transitive lock entries without changing SDK 1.29.0.
3. Test Vite 8.1.5 alone.
4. Test Vitest 4.1.10 alone.
5. Integrate the evidence-backed ext-apps 1.7.4 candidate, then complete its
   native macOS, Windows, and non-Apps host gates.
6. Consider canvas 1.0.2 only after native packaging gates are strengthened.
7. Keep PDF.js exactly at 5.4.624 pending a separate compatibility strategy.
8. After the final July 28 specification, stable SDK support, and host adoption,
   perform protocol/SDK migration as an isolated effort.

For every accepted change, record source commit, lock hash, MCPB SHA-256,
archive list/SBOM, Desktop version, Electron/Chromium/Node versions, OS, and
architecture. A dependency bump without this evidence is not release-ready.
