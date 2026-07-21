# MCP discovery contract

PDF Tools targets MCP `2025-11-25` through the stable TypeScript SDK 1.x and
MCPB manifest format `0.3`. The server intentionally exposes the same protocol
surfaces from the source checkout, the packed MCPB, and the share package.

Primary references:

- [MCP lifecycle and capability negotiation](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
- [MCP prompts](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts)
- [MCP resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources)
- [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCPB manifest 0.3](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md)

## Advertised surfaces

| Surface | Initialize capability | Discovery and use | Static declaration |
| --- | --- | --- | --- |
| Tools | `tools: {}` | `tools/list`, `tools/call` | `manifest.json` and `manifest.mcpb.json` |
| Prompts | `prompts: {}` | `prompts/list`, `prompts/get` | Identical 14-prompt arrays in both manifests |
| Resources | `resources: {}` | `resources/list`, `resources/read` | Runtime only; MCPB 0.3 does not declare resources |

The capability objects do not claim list-change notifications or resource
subscriptions because PDF Tools does not emit or implement them. Resource
template discovery is also unsupported and deterministically returns JSON-RPC
`-32601` (`Method not found`).

### Tools

The runtime returns 37 uniquely named tools. Every tool has an object input
schema plus `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, and
`openWorldHint` annotations. Annotations are user-interface hints, never an
authorization boundary; path allowlists and signature-intent checks remain the
enforced controls. The contract test enforces annotation presence and types,
not the policy judgment for every overwrite-capable path; that semantic
classification requires its own host-UX and handler-by-handler review.

The source manifest lists all 37 tools. The packed MCPB manifest lists the 36
normal model-workflow tools and omits `read_pdf_bytes`, whose runtime metadata
marks it `ui.visibility: ["app"]`. `tools_generated: true` explicitly tells MCPB
hosts that runtime discovery includes an additional tool. That visibility hint
is advisory and depends on an MCP Apps-aware host filtering its model catalog;
a generic MCP client can still discover and call `read_pdf_bytes`. It is not an
authorization or confidentiality boundary. Filesystem allowlists and the tool's
bounded reads remain the enforced controls.

Twenty-nine tool handlers can return `structuredContent`. They also return a
human-readable `content` text block so non-Apps and older clients remain usable.
No tool currently publishes an `outputSchema`; MCP permits structured content
without one, while any future output schema would make conformance mandatory.
Add output schemas only as a separately reviewed, versioned contract change
with success and error-path fixtures for every affected tool.

### Prompts

The 14 manifest prompt templates are first-class MCP prompts. Runtime
discovery preserves manifest order, names, descriptions, and argument names.
Every declared argument is required because every one is interpolated into its
template. `prompts/get` returns one user message. User-provided values are
bounded to 1,024 characters, reject C0/C1 and common invisible/bidirectional
format characters, and are serialized in an explicit JSON data block. The task section refers to
argument names instead of splicing values into operative instructions. The
boundary tells the consuming model never to follow commands embedded in the
data. This reduces prompt-injection ambiguity but does not make arbitrary
untrusted input safe by itself; clients should keep prompt invocation
user-controlled and avoid sourcing arguments from untrusted documents without
their own review.

Missing arguments, unknown arguments, and unknown prompt names return JSON-RPC
`-32602` (`Invalid params`). Adding or removing a prompt requires updating both
manifests and both committed runtime copies; the contract test detects drift.

### Resources

`resources/list` returns the MCP Apps viewer at
`ui://pdf-toolkit/viewer`. `resources/read` returns its single-file HTML with
the `text/html;profile=mcp-app` media type.

PDF file resources are dynamic and therefore are not included in
`resources/list`. `get_pdf_resource_uri` applies the filesystem allowlist, then
encodes the absolute platform path as one percent-encoded segment under the
canonical `pdf://local/` authority. The symmetric decoder handles POSIX,
Windows-drive, UNC, Unicode, and RFC 3986 reserved characters without allowing
URI query/fragment ambiguity. `resources/read` re-applies the allowlist before
returning the PDF as an `application/pdf` blob. Schema-valid string URIs that
do not match a supported resource form return `-32602`; missing or
expected-permission-unavailable resources return `-32002`. Inputs rejected by
the SDK before the handler runs can use the SDK's own protocol-error mapping.
Genuine filesystem/runtime faults remain `-32603` instead of being mislabeled
as a missing resource.

The finite tools, prompts, and resource lists do not issue pagination cursors.
Supplying a schema-valid string cursor therefore returns `-32602` instead of
silently restarting at the first page. Inputs rejected by the SDK schema before
the handler runs can use the SDK's own protocol-error mapping.

## Verification

Run the deterministic source and staged-share-files contract suite:

```bash
npm test -- --run test/mcp-contract.test.js
```

The suite verifies initialization, tool declarations and annotations, explicit
generic-client behavior for the app-intended byte tool, prompt
listing/rendering/injection boundaries/error behavior, cursor rejection,
static and reserved-character dynamic resource reads, representative structured
content with a text fallback, and unsupported resource-template discovery. It
also requires all committed share runtime modules and the single-file viewer to
be byte-identical to their source counterparts. The regular suite stages share
files under a temporary root with an explicit dependency fixture; it catches
missing package files and source/share drift, but is not the clean-install proof.

Prove that the share manifest resolves and installs without any parent checkout:

```bash
npm run test:contract:share
```

This gate runs the real share packager, extracts its ZIP into a clean temporary
root, generates a dependency lock from only that archive, recreates it with
`npm ci --omit=dev`, and exercises discovery, app-tool compatibility, cursor
errors, and a dynamic PDF resource round trip.

For an exact release candidate, also verify the packed projection:

```bash
npm run build:mcpb
npm run smoke:mcpb -- pdf-toolkit-mcp.mcpb
```

The packed smoke runs the extracted archive itself and covers discovery,
prompt argument boundaries, cursor errors, both resource kinds, generic-client
app-tool behavior, tool error signaling, and native rasterization.

Finally install that exact artifact in the current Claude Desktop host and use
a fresh synthetic chat to confirm prompt visibility, one prompt invocation, one
normal tool call, and viewer rendering. The local stdio contract suite proves
protocol behavior, not host-specific catalog presentation.
