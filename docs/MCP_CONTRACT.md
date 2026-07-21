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
model-visible tools and omits `read_pdf_bytes`, whose runtime metadata marks it
`ui.visibility: ["app"]`. `tools_generated: true` explicitly tells MCPB hosts
that runtime discovery includes an additional tool. This preserves the viewer's
private byte-streaming contract without advertising that internal primitive as
a normal model workflow.

Twenty-nine tool handlers can return `structuredContent`. They also return a
human-readable `content` text block so non-Apps and older clients remain usable.
No tool currently publishes an `outputSchema`; MCP permits structured content
without one, while any future output schema would make conformance mandatory.
Add output schemas only as a separately reviewed, versioned contract change
with success and error-path fixtures for every affected tool.

### Prompts

The 14 manifest prompt templates are now first-class MCP prompts. Runtime
discovery preserves manifest order, names, descriptions, and argument names.
Every declared argument is required because every one is interpolated into its
template. `prompts/get` returns one user message and uses literal replacement,
so argument values containing replacement-string characters such as `$&` are
not interpreted.

Missing arguments, unknown arguments, and unknown prompt names return JSON-RPC
`-32602` (`Invalid params`). Adding or removing a prompt requires updating both
manifests and both committed runtime copies; the contract test detects drift.

### Resources

`resources/list` returns the MCP Apps viewer at
`ui://pdf-toolkit/viewer`. `resources/read` returns its single-file HTML with
the `text/html;profile=mcp-app` media type.

PDF file resources are dynamic and therefore are not included in
`resources/list`. `get_pdf_resource_uri` returns a `pdf://` URI after applying
the filesystem allowlist, and `resources/read` returns the corresponding PDF as
an `application/pdf` blob. This path works for resource-aware non-Apps clients
as well as Claude Desktop.

## Verification

Run the deterministic source and share-package contract suite:

```bash
npm test -- --run test/mcp-contract.test.js
```

The suite verifies initialization, all tool declarations and annotations,
prompt listing/rendering/error behavior, static and dynamic resource reads,
representative structured content with a text fallback, and unsupported
resource-template discovery.

For an exact release candidate, also verify the packed projection:

```bash
npm run build:mcpb
npm run smoke:mcpb -- pdf-toolkit-mcp.mcpb
```

Finally install that exact artifact in the current Claude Desktop host and use
a fresh synthetic chat to confirm prompt visibility, one prompt invocation, one
normal tool call, and viewer rendering. The local stdio contract suite proves
protocol behavior, not host-specific catalog presentation.
