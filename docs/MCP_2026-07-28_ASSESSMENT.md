# MCP 2026-07-28: adoption assessment

Bead `pdf-toolkit-mcp-ojj`. Assessed 2026-07-28, the day the revision published.

The bead deferred this evaluation until the final spec, a TypeScript SDK v2, and
Claude Desktop / MCPB host support were all available, and required that PDF
Tools upgrade only once local stdio bundle compatibility was demonstrated. This
records what is actually available today, what would concretely have to change
here, and why the recommendation is still to wait.

## Gate status

| Gate | Status |
|---|---|
| Final specification published | **Met.** Live at `/specification/2026-07-28/` |
| TypeScript SDK v2 | **Met, with a caveat.** Shipped stable today |
| Claude Desktop / MCPB host support | **Not met, and unproven** |
| Local stdio bundle compatibility demonstrated | **Not started**, blocked on the gate above |

The SDK caveat matters. v2 did not ship as `@modelcontextprotocol/sdk@2`. It
ships as two new packages, `@modelcontextprotocol/server` and
`@modelcontextprotocol/client`, both at `2.0.0` as of 2026-07-28 00:03 UTC. The
monolithic `@modelcontextprotocol/sdk` remains on the v1 line at `1.30.0`. So
adopting v2 is a dependency replacement, not a version bump, and it rewrites the
server bootstrap rather than adjusting it.

MCPB is unchanged at `2.1.2`. The Claude Desktop build on the maintainer host is
`1.24012.9`, and its logs do not record a negotiated protocol version, so host
support cannot currently be confirmed by inspection.

## What the revision actually changes

The headline framing in press coverage is that this is a stateless rewrite
aimed at remote HTTP deployments, which is true but incomplete for a local
server. Two items reach stdio directly.

**The handshake removal is protocol-level, not transport-level.** The
`initialize` / `notifications/initialized` exchange is removed outright, with
every request instead carrying its protocol version and client capabilities in
`_meta`. That is not confined to HTTP.

**Servers MUST implement `server/discover`.** The spec explicitly names it as
the backward-compatibility probe on stdio. This is a new required RPC for any
server claiming the revision.

## Concrete impact on this codebase

Exposure to the deprecations is **zero**, which is the good news and the reason
there is no forced migration pressure:

- The server declares only `tools`, `resources`, and `prompts`. It has never
  declared Roots, Sampling, or Logging, all three of which are now deprecated.
- Diagnostics already go to `stderr`, which is exactly the migration the spec
  recommends in place of the Logging feature.
- The transport is stdio. The HTTP+SSE reclassification does not apply, and
  neither does anything about sessions, sticky routing, or `Mcp-Session-Id`.

Adopting the revision would nonetheless require real work here:

| Change | Why it applies |
|---|---|
| Implement `server/discover` | Newly mandatory; the stdio compatibility probe |
| Add `resultType` to every result | Now a required field on all results |
| Add `ttlMs` and `cacheScope` to list and read results | Newly required on `tools/list`, `prompts/list`, `resources/list`, and `resources/read`, all four of which this server implements |
| Return `tools/list` in deterministic order | Recommended, and it is what makes client caching and prompt-cache hits work |
| Move resource-not-found from `-32002` to `-32602` | `RESOURCE_NOT_FOUND_ERROR_CODE` in `server/index.js` is currently `-32002` |
| Replace the SDK dependency | New package names, not a version bump |

## Recommendation: do not adopt yet

Three reasons, in order of weight.

**Host support is the binding constraint and it is unproven.** This project
ships a local bundle into Claude Desktop. A server that advertises a protocol
revision the installed host does not speak is a regression, and the failure mode
here is already well documented: the viewer breaks inside the Electron sandbox
while every server-side test stays green. MCPB has not moved from 2.1.2.

**Backward compatibility is explicit, so waiting costs nothing.** Clients must
treat results from earlier-protocol servers that omit `resultType` as complete,
and v2 servers speak both `2025-11-25` and `2026-07-28`. Staying on the current
revision is a supported state, not technical debt accruing interest.

**The deprecation window is twelve months minimum.** The new feature lifecycle
policy guarantees at least twelve months between deprecation and earliest
removal, and this project uses none of the deprecated features anyway.

## What would change the recommendation

Adopt when all of the following hold:

1. MCPB publishes a release that packages a `2026-07-28` server, or Claude
   Desktop is confirmed to negotiate the revision.
2. The exact packaged bundle is installed in a current Claude Desktop on a clean
   host and demonstrates discovery, tool invocation, and viewer rendering.
3. `server/discover`, `resultType`, and the cache fields are implemented behind
   the same evidence gates as any other contract change.

Until then the correct posture is to track, not migrate.

## Lower-risk item available now

`@modelcontextprotocol/sdk` `1.29.0` to `1.30.0` is a v1-line minor bump,
independent of this revision. It is not covered by this assessment and should be
evaluated on its own with the usual host validation, not folded into a protocol
migration.

## Sources

- MCP specification, *Key Changes* for 2026-07-28.
- MCP blog, *The 2026-07-28 MCP Specification Release Candidate* (RC locked
  2026-05-21, final published 2026-07-28).
- MCP blog, *Beta SDKs for the 2026-07-28 MCP Spec Release Candidate*.
- npm registry, checked 2026-07-28: `@modelcontextprotocol/server` 2.0.0,
  `@modelcontextprotocol/client` 2.0.0, `@modelcontextprotocol/sdk` 1.30.0,
  `@anthropic-ai/mcpb` 2.1.2.
