# ext-apps 1.7.4 isolated upgrade evidence - 2026-07-23

## Decision

Accept the isolated `@modelcontextprotocol/ext-apps` 1.7.4 candidate for
integration. The dependency artifact, app protocol contract, viewer lifecycle,
browser behavior, deterministic UI build, production MCPB, archive delta, and
candidate-versus-control test differential pass.

This is not release approval. The exact MCPB still requires installed Claude
Desktop validation on supported macOS and Windows hosts. The non-Apps fallback
also remains a target-host gate. Keep Bead `pdf-toolkit-mcp-dwk.8` in progress
until those rows are complete.

## Scope

- Starting commit: `8d54ff7590951f8910801332a1c3e42cef330b6f`
- Final candidate commit: `23ef1070b8f09e84f135dafe04f73403138feae0`
- Direct dependency delta: `@modelcontextprotocol/ext-apps` from `^1.7.0` to
  exact `1.7.4`
- Added command: `npm run smoke:ui-app-lifecycle`
- Candidate `package.json`: 2,292 bytes, SHA-256
  `603ec0f7901eb019088ea55b385f88d51a7c25d42bf79c1daeb76bedd407c407`
- Candidate `package-lock.json`: 118,976 bytes, SHA-256
  `91bbacd5399b9e6f72e0536750f252890f4ed743957f44a8a2e697e1858080e4`
- Protected `pdfjs-dist`: **5.4.624 exact**
- Other direct dependency changes: none

Validation ran on Jex's iMac, not the resource-constrained Silvercloud control
plane:

| Property | Value |
| --- | --- |
| OS | macOS 26.5 |
| Architecture | arm64 |
| Memory | 16 GiB |
| Node | 25.8.1 |
| npm | 11.11.0 |
| Test workers | 1 |

## Upstream basis and package provenance

Primary sources reviewed:

- [MCP Apps stable 2026-01-26 specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)
- [Official MCP Apps announcement](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/)
- [Official ext-apps package and version history](https://www.npmjs.com/package/%40modelcontextprotocol/ext-apps?activeTab=versions)
- [App API and teardown contract](https://apps.extensions.modelcontextprotocol.io/api/classes/app.App.html)
- [MCP Apps client matrix](https://modelcontextprotocol.io/extensions/apps/overview)

The stable extension protocol is `2026-01-26`. The candidate asserts the exact
outbound `ui/initialize` version, app identity, and capabilities, and checks the
SDK's `LATEST_PROTOCOL_VERSION` against that value.

Registry evidence for 1.7.4:

```text
tarball SHA-256:
f9bd6546d6c18f7ad3e9d9bb934eec909db4ea6b85988647db447d08c4b6ce4a

npm integrity:
sha512-QQqysE549cf/Y0VabBmAACXhj92EhB3t8yVct2BHbkWiPTFA1S91EqTVjYXXcZEefXU0pmHcdObhsNMcomJIOQ==
```

The registry package carries npm provenance and registry signatures. A
normalized comparison of the 1.7.0 and 1.7.4 package contents found identical
runtime and declaration bytes. The only added package path is
`dist/src/message-transport.test.d.ts`. The tarballs differ because the package
metadata and archive identity differ, not because the shipped bridge runtime
changed.

For reference, the 1.7.0 tarball SHA-256 is
`5a361169bf438b3e03c7571a99d9704e7416fb1739ae8b146a40bf02ec785e4f`.

## Lifecycle implementation

The viewer uses `App` with strict protocol handling and explicit resize
notifications. The upgrade adds:

- explicit connection error propagation;
- one shared, idempotent teardown promise;
- a one-way viewer lifecycle epoch;
- one guarded path for every `app.callServerTool` invocation;
- entry and post-await checks for display-mode, model-context, signing,
  signature loading, region preview, page-plan, active-document, and PDF byte
  operations;
- destruction of every retained `PDFDocumentLoadingTask` and the active
  document before teardown acknowledgment;
- generation-bound PDF loading, rendering, preloading, timers, and range
  caches;
- invalidation of every pending signature-zone request and region-preview
  request;
- silent rejection of late lifecycle completions;
- no state, cache, DOM, reload, or follow-on host call after teardown begins.

The lifecycle browser host exercises:

- exact initialize request and initialized notification;
- initial tool result and PDF byte reads;
- active-document tool calls;
- model-context updates;
- host theme and style variables;
- resize notification;
- fullscreen request and changed host context;
- protocol-error propagation;
- close, reopen, and reconnect;
- duplicate concurrent teardown requests sharing cleanup;
- a held `read_pdf_bytes` response released after acknowledgment;
- a held `apply_text` response released after acknowledgment;
- a held quick-sign `create_signature` response released after acknowledgment.

The last two cases adversarially prove that a late date stamp cannot initiate a
PDF reload and a late signature creation cannot chain into
`apply_signature`.

Final lifecycle counters:

| Counter | Result |
| --- | ---: |
| Initialize / initialized / initial result | 5 / 5 / 5 |
| Teardown requests / acknowledgments | 8 / 8 |
| Held / released PDF byte requests | 1 / 1 |
| Held / released `apply_text` requests | 1 / 1 |
| Held / released `create_signature` requests | 1 / 1 |
| `apply_signature` after delayed creation | 0 |
| Messages after teardown acknowledgment | 0 |
| UI mutations after teardown acknowledgment | 0 |
| Teardown error | none |

## Focused and browser verification

Commands ran from the exact candidate tree:

```sh
npx vitest run \
  test/ext-apps-lifecycle.test.js \
  test/sign-mode-polish.test.ts \
  test/mcp-contract.test.js \
  test/tool-result.test.ts \
  test/viewer-compat.test.js \
  --maxWorkers=1

npm run smoke:ui-dev
npm run smoke:ui-app-lifecycle
```

Results:

| Gate | Result | Wall time |
| --- | --- | ---: |
| Focused unit and contract set | 5 files, 51 passed | 5.25 s |
| Development viewer and MCP bridge | pass | 6.16 s |
| Built MCP Apps lifecycle smoke | pass | 14.76 s |

The in-memory SDK transport tests cover initialization, initial tool result,
app-to-server tool calls, resource reads, host context, resize, model context,
display mode, teardown, close/reconnect on the same `App`, strict pre-connect
and late-handler rejection, and request, transport, and initialization error
propagation.

## Deterministic viewer and exact MCPB

Two independent UI builds were byte-identical:

```text
dist-ui/index.html
pdf-toolkit-mcp-share/dist-ui/index.html

bytes: 3,457,264
sha256: 44300a4517d7aaaf8eef34cadad3100ed1f0dd36eeb4ee5a74cd2c12b04f18d7
```

`npm run build:mcpb` performed two clean isolated builds. Both produced:

```text
files: 2,994
bytes: 73,542,486
sha256: 7c9014574e073a8ef998287a69b529a43a536de089396bd6e855ef7af7949485
peak isolated-build RSS: 645,280 KiB
```

Manifest validation, pinned MCPB info/unpack, all five native binding checks,
and archive reproducibility passed. The packed smoke then discovered 39 tools,
14 prompts, canonical resources, and a native raster image on Darwin arm64.

The previous audited MCPB was:

```text
files: 2,994
bytes: 73,541,767
sha256: 81c2f0c01f7dca01ac7debf8e297bbfb5651871646f22e800e763038eaccaa72
```

A recursive extracted comparison found one and only one changed archived file:
`dist-ui/index.html`. Its previous hash was
`47f0809fba2215bfa6a94ed134152c96bfdb817eda9577fae572c9ca8755be2f`
at 3,455,131 bytes. Every server file, manifest, native binding, and production
dependency is byte-identical.

## Full-suite differential

The exact pre-lane control and final candidate ran serially on the same iMac,
with separate dependency trees and one Vitest worker:

| Result | 1.7.0 control | 1.7.4 candidate |
| --- | ---: | ---: |
| Test files | 77 | 78 |
| Tests discovered | 1,036 | 1,040 |
| Passed | 940 | 944 |
| Failed | 86 | 86 |
| Skipped | 10 | 10 |
| Wall time | 218.84 s | 222.82 s |

The four new tests all pass. The normalized failed-test and failed-suite list
contains 87 entries on each side and is byte-identical:

```text
4da3b0baef363e59971407f3f340c961e6f11161889867e21c772245678c8b87
```

There are zero candidate-only failures and zero control-only failures. The
remaining shared failures require private evaluator inputs or encounter known
macOS privacy/path/rendering differences. They are outside this dependency
lane and receive no credit from it.

The package and lock update initially invalidated the retained extraction
oracle's dependency bindings. This was caught by the differential, not
waived. Two independent regenerations produced identical bytes. The committed
oracle delta changes only the package.json bytes/hash, package-lock bytes/hash,
and aggregate validator-source digest. Its complete case, fact, geometry, and
truth payload is unchanged.

## Independent adversarial review

The first static review blocked the candidate because delayed non-PDF host
operations could survive teardown and initiate new calls. That finding led to
the lifecycle epoch, exhaustive call-site guards, and the two new delayed
mutation smokes.

The final implementation review of `67c0a23` and the binding-only review of
`23ef107` both returned APPROVE with no P0, P1, P2, or P3 findings. No reviewer
ran builds or tests on Silvercloud.

## Remaining host gates

Before release:

1. install the exact MCPB SHA-256 above in a supported stable Claude Desktop
   profile on macOS;
2. repeat on Windows x64 and, if claimed, Windows arm64;
3. record Claude Desktop, Electron, Chromium, Node, OS, and architecture;
4. exercise resource fetch, connect, initial result, PDF byte reads, theme,
   resize, fullscreen, close/reopen/reconnect, signing, and error handling;
5. exercise a non-Apps host and prove useful text-only tool results;
6. bind screenshots/logs and the installed extension tree to the exact MCPB;
7. confirm there are no viewer render errors or protocol errors.

Until those rows pass, the correct state is **integration ready, native host
gate pending**. This lane performs no host installation, push, release,
signing, Slack message, or public GitHub action.
