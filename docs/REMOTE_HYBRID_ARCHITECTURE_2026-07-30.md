# Remote and hybrid PDF Tools architecture decision

Bead `pdf-toolkit-mcp-22v.2`. Decision frozen 2026-07-30.

## Decision

PDF Tools should keep the current local stdio MCPB as its local-custody product
and treat any remote Streamable HTTP MCP as a sibling service with a separate
security, privacy, deployment, commercial, and evidence boundary.

The present verdicts are:

| Surface | Verdict | Meaning |
|---|---|---|
| Current local MCPB | **GO CONTINUE** | Preserve the local path and approval boundary. Do not turn remote work into an MCPB packaging change. |
| Production remote document service | **WAIT** | Do not deploy, accept user documents, create provider resources, or make compatibility claims until all production flip gates pass. |
| Remote architecture contract | **GO** | The dated capability ledger and machine-readable trust contract are ready for implementation planning. |
| Smallest remote vertical slice | **GO, LOCAL MOCK ONLY** | Use loopback, synthetic metadata, and synthetic PDFs. Prove fail-closed state transitions without a public listener or user-data egress. |
| Optional local companion | **WAIT** | Do not select or install one until explicit one-object handoff and ambient-access threats are proven safe. |

This is an architecture result. It is not a deployed service, a native host
result, a privacy certification, or evidence that the current MCPB works in
Cowork, ChatGPT, Codex cloud, Tasks, or every MCP Apps host.

Normative contract authority digest: `sha256:3783deb63beeb1fe48aa545ca58db861864ccb794a2c8fcc156f06a5b3999627`.

## Why this boundary is necessary

The current package starts as a local process and operates on paths explicitly
permitted by a desktop host. A remote connector is different in every material
way:

- It is an HTTP resource server reachable by a cloud host.
- It needs end-user authentication and object-level authorization on every
  request.
- If it handles PDF bytes, it becomes a document custodian with storage,
  retention, deletion, backup, abuse, incident, and legal obligations.
- It cannot treat a model request, an opaque ID, a hash, or a host approval as
  proof that the end user may access or mutate an object.
- Its compatibility must be qualified per host. Protocol support alone does
  not prove host support for UI, Tasks, file transfer, or the exact workflow.

Current Claude documentation also makes three paths easy to confuse. A remote
Cowork session can request files from a connected folder through Claude Desktop
while that app is online. The opened bytes are processed in Anthropic's remote
session. A remote Cowork session can also reach a local connector or plugin
containing local MCP through the online Claude Desktop broker. The local MCP
executes on the desktop side and does not run inside the remote sandbox. Both
desktop-brokered paths are Anthropic host capabilities, not a remote connector
calling the local PDF Tools MCPB. Exact brokered behavior of the current PDF
Tools MCPB remains unverified and requires native-host evidence.

ChatGPT and Codex have a similar product split. Local Codex hosts document
stdio and Streamable HTTP MCP configuration. In the documented hosted ChatGPT
Work surface, web chats use remote MCP-backed tools delivered by plugins and do
not read the local Codex configuration. Codex cloud checks out a repository
into an OpenAI-managed
environment. Current official sources inspected for this decision do not
establish that the exact PDF Tools remote workflow is available in Codex cloud,
so that row remains unverified.

The full dated source ledger is
[`docs/evidence/remote-hybrid-host-capabilities-2026-07-30.json`](evidence/remote-hybrid-host-capabilities-2026-07-30.json).

## Protocol target

A future remote surface should target the final MCP `2026-07-28` Streamable
HTTP shape, while preserving backward compatibility only where an exact target
host requires it.

The current protocol target has these properties:

- Every JSON-RPC message is a separate POST to one MCP endpoint.
- Every client POST advertises both `application/json` and
  `text/event-stream` in `Accept`.
- Protocol-level HTTP sessions and the standalone GET stream are removed.
- Every POST binds body metadata to `MCP-Protocol-Version`, `Mcp-Method`, and,
  for named calls or reads, `Mcp-Name`.
- Every request body carries protocol version, client name and version, and
  client capabilities in `_meta`, with the body authoritative.
- A server rejects required-header omissions and header or body disagreement.
- When `Origin` is present, the server validates it against an exact allowlist
  and rejects invalid, null, or multiple values before dispatch. Absence alone
  is allowed for non-browser clients and does not bypass authentication or any
  other request validation.
- `server/discover` supplies explicit server capabilities.
- OAuth authorization is an HTTP transport concern. Tokens are resource
  audience-bound bearer tokens, sent in the authorization header on every
  request and never in a URI.
- MCP Apps and Tasks are optional extensions. Their presence must be negotiated
  or capability detected, and each target host still needs its own evidence
  row.

This protocol target does not change the separate recommendation in
[`docs/MCP_2026-07-28_ASSESSMENT.md`](MCP_2026-07-28_ASSESSMENT.md): do not
migrate the local MCPB until Claude Desktop and MCPB compatibility with the
exact packed artifact are demonstrated.

## Principals and authority

The architecture has six principals:

1. **Resource owner.** The human who may authorize workspace creation, upload,
   mutation, export, deletion, and retention choices.
2. **Host MCP client.** Claude, ChatGPT, Codex, or another client acting through
   an authenticated protocol. It transports requests but is not the tenant or
   object authority.
3. **Remote resource server.** PDF Tools' future HTTP MCP and service API. It
   authenticates every request, derives tenant scope from verified identity,
   authorizes every object and action, and emits content-free audit records.
4. **Authorization server.** An established identity provider or equivalent
   component that supplies discovery, PKCE, resource audience tokens, scopes,
   and expiration or revocation behavior.
5. **Document worker.** A tenant-scoped, resource-bounded, network-restricted
   processor. It executes an already authorized operation but cannot grant
   itself authority based on PDF contents or model text.
6. **Optional local companion.** A future process that may identify and
   explicitly transfer one permitted object. It is not selected or implemented
   by this decision.

The server must derive the user and tenant from a verified token and server-side
membership data. Caller-supplied `tenant_id`, `workspace_id`, `document_id`, or
`task_id` values select candidates only. They never grant access.

## Document identity and versioning

A local path is meaningful only on the machine that owns it. It must never
become the remote identity.

Each remote object uses:

- an opaque server-generated document ID;
- a mandatory tenant and workspace binding;
- exact byte length and SHA-256 content identity;
- an immutable source version;
- new output versions by default.

Every mutation binds:

- verified tenant and actor;
- workspace and document;
- exact input byte length and SHA-256;
- exact tool name and version;
- a digest of canonical operation arguments;
- destination and expected effects;
- the authorization or approval record and policy version;
- operation ID and idempotency key;
- current authorization for the requested action;
- the output identity and provenance receipt.

The receipt repeats tenant, workspace, actor, idempotency key, canonical
argument digest, authorization or approval record, policy version and result,
source identity, output identity, tool identity, operation ID, and completion
time. A same-key retry with a different request identity fails with no effect.
Membership and action authorization are rechecked at worker dequeue, before
output activation, and before result or download release.

This is the remote analogue of the local project's existing source and output
identity protections. It does not replace authorization. A correct hash can
still identify an object the caller is forbidden to access.

## Data flows

### Local only

1. The human permits a local path through the desktop host.
2. The local MCPB reads or mutates within its current path, identity, and
   approval controls.
3. The output stays local and receives byte length and SHA-256 identity.

No PDF byte egress to a PDF Tools remote service occurs.

### Remote only

This path remains synthetic-only until the production gates pass.

1. The human creates or selects a tenant-scoped remote workspace.
2. The human explicitly authorizes upload of one named content identity.
3. The service stores an immutable source and returns an opaque remote identity.
4. Each authorized mutation creates a new version after exact source identity
   and idempotency checks.
5. The human reviews provenance and output identity before export.
6. Expiry, deletion, and physical purge follow a visible lifecycle.

### Hybrid explicit handoff

This path also remains synthetic-only.

1. The local companion identifies bytes in an already permitted path without
   exposing ambient filesystem access.
2. The human authorizes one content identity, destination workspace, direction,
   and expiry.
3. A one-time transfer grant moves only those bytes.
4. Remote operations produce versioned outputs and receipts.
5. The human authorizes a specific return identity.
6. The local companion writes to a new path or an existing path whose current
   identity was explicitly approved.

Folder access does not imply upload consent. Directory sync is not the handoff
protocol. A remote connector cannot invoke a local MCP merely because both are
enabled in one product.

### Cowork connected-folder bridge

This is a documented host path, not the PDF Tools remote design:

1. The human connects a bounded folder in Claude Desktop.
2. A remote Cowork session requests a permitted file through the desktop bridge
   while the app is online.
3. Anthropic processes the bytes in the remote session under its own product
   data boundary.

Public language must not describe this as the document staying on-device, as
local MCP execution inside the remote session, or as implicit consent to upload
the same document to a PDF Tools service.

### Cowork Desktop-brokered local connector

This is a second documented host path and remains unverified for exact PDF
Tools:

1. The human enables a local connector or plugin containing local MCP through
   Claude Desktop.
2. A remote Cowork session requests the connector through the online desktop
   broker.
3. The local MCP executes on the desktop side, outside the remote sandbox.
4. Tool inputs and results used by the remote session cross Anthropic's
   processing boundary.

Public language must not describe this as local MCP running inside the remote
sandbox, as proof that the current MCPB works in remote Cowork, or as an
entirely on-device workflow.

## Authentication and authorization

Anything customer-specific or mutating requires end-user authentication. The
production target is OAuth 2.1 authorization code with PKCE through an
established identity provider.

The HTTP MCP must:

- publish protected resource metadata;
- use validated authorization server metadata;
- bind authorization responses to the expected issuer;
- require tokens intended for the canonical PDF Tools resource;
- validate signature, issuer, audience, expiry, not-before, and scopes on every
  request;
- bind validated issuer metadata to JWKS keys, handle key rotation and stale-key
  behavior, and assess token replay;
- reject missing or invalid credentials with an appropriate challenge;
- keep tokens out of URIs, tool results, logs, and document metadata;
- request the least privilege needed for the current operation;
- separate read, upload, mutate, export, and delete authority;
- support step-up or fresh authorization for consequential actions.

Client identity and end-user identity remain separate. For example, mTLS can
prove that ChatGPT is the connecting client, but it does not prove which end
user may read a given PDF. The server must still enforce OAuth and its own
tenant and object policy.

Host tool approvals are useful user experience and defense in depth. They are
not the service authorization boundary.

## Storage, retention, and deletion

Before any production file enters the service, the owner must approve a
complete data map covering:

- source PDF bytes;
- derived versions and previews;
- OCR text, embeddings, and indexes if any;
- temporary worker storage;
- task state and input requests;
- caches and content delivery layers;
- operation and audit records;
- backups;
- observability and incident artifacts;
- subprocessors and data regions.

The service needs a declared default retention period, user-visible expiry,
explicit delete behavior, a bounded physical purge objective, backup deletion
rules, and legal hold behavior before enterprise claims. Cancellation of a job
is not deletion of a document. A deletion tombstone is not proof that all
copies have been physically purged. These states need separate APIs, receipts,
and tests.

PDF bytes, extracted text, tokens, and unnecessary filenames must not enter
logs or traces. Audit events should retain stable operation, actor, tenant,
object, policy, result, and timing identifiers without document contents.

## Upload, mutation, and export

An upload authorization binds one tenant, workspace, content identity,
verified actor, content type, direction, destination, purpose, size bound,
single-use nonce, and expiry. The server atomically consumes it. First
redemption may succeed; replay, concurrent double redemption, wrong actor,
wrong object, wrong destination, and wrong content identity fail. An
interrupted or hash-mismatched receive cannot leave a partial object or a
reusable grant. Upload cannot be inferred from:

- the model asking for a tool call;
- a user connecting a local folder;
- a prior upload of a different version;
- a path appearing in conversation context;
- access to a remote workspace.

The receive path enforces size and type bounds, validates the complete received
hash, and isolates parser work. It also needs hostile input controls for
malformed PDFs, decompression or object bombs, malicious annotations,
unexpected embedded files, and resource exhaustion.

Mutations create new versions by default. The exact reviewed source identity is
rechecked before processing and before activation. Retries use a tenant-scoped
idempotency key. Outputs receive type validation, byte length, SHA-256,
source-to-output provenance, and operation receipts.

Downloads use short-lived grants bound to actor, tenant, workspace, exact
object and version, direction, client or destination audience, expiry, and a
single-use nonce. The server atomically consumes the grant. Replay, concurrent
double redemption, wrong object, wrong actor, and wrong audience fail. A list
or search result never contains a broad reusable storage credential. Export to
an external system remains a consequential action with explicit destination
and identity review.

## Long-running work and Tasks

OCR, large comparisons, and batch transforms may benefit from MCP Tasks, but
Tasks is currently an experimental draft extension pinned by this decision to
repository commit `2c1425d9a288b9b1f489430fe1e00bb392b47e48`. Host support
must be proven, and its revision and schema must be refreshed before
implementation.

If enabled:

- both client and server advertise support;
- the server durably creates the task before returning its handle;
- each task binds tenant, workspace, document version, operation, and actor;
- authorization is rechecked on `tasks/get`, `tasks/update`, and
  `tasks/cancel`;
- subscription creation and every task notification are tenant scoped;
- membership and action authorization are rechecked at worker dequeue, before
  activation, on terminal retrieval, and before export;
- a revoked actor cannot activate or retrieve a newly completed output;
- TTL and poll intervals are bounded;
- input requests bind the exact paused operation state;
- cancellation is represented as cooperative cancellation, not guaranteed
  immediate termination or document deletion;
- terminal results are idempotent and identity-bound;
- no unscoped task listing endpoint is introduced.

The smallest mock slice can simulate this state machine later, but it should
not advertise Tasks until the basic request, identity, authorization, and
mutation contracts pass.

## MCP Apps review and approval

A PDF viewer, diff, and approval surface is a strong MCP Apps candidate.
Portable behavior should use the MCP Apps fields and `ui/*` bridge first.
ChatGPT-specific file APIs or other host extensions must be feature detected,
with a tool-only fallback.

The app runs in a host-controlled sandbox. It does not gain ambient
authorization. An approval message must bind:

- verified user and tenant;
- workspace and exact source identity;
- operation name and arguments;
- destination and expected effects;
- a single-use approval nonce or equivalent server-verifiable record;
- expiry.

The server rejects a tool call whose approval record does not match the exact
operation. UI text alone is not the authorization receipt.

## Threat priorities

The machine contract tracks sixteen threats. The P0 class includes:

- cross-tenant access through any list, fetch, mutation, job, export, delete,
  notification, or deep-link path;
- wrong-issuer, wrong-audience, or confused-deputy tokens;
- upload inferred without a content-addressed human authorization;
- prompt injection causing disclosure or unreviewed mutation;
- stale-source mutation;
- cross-tenant task handles;
- broad or replayable download grants;
- ambient local companion access;
- approval text not bound to the invoked operation;
- HTTP routing or policy headers that disagree with the JSON-RPC body.

No product usefulness score can average away one of these failures.

## Smallest safe vertical slice

The first implementation tranche, if authorized separately, is a loopback-only
mock using repository synthetic fixtures. It may implement:

- `server/discover`;
- `tools/list`;
- synthetic workspace creation;
- registration of a synthetic document identity;
- a simulated identity-bound mutation that creates a new synthetic version;
- operation receipt retrieval;
- simulated deletion and purge lifecycle states.

It must prove:

- missing or wrong identity and tenant context fails closed;
- cross-tenant reads, writes, jobs, and lifecycle calls fail closed;
- a present invalid, null, or multiple `Origin` fails with 403 while an absent
  `Origin` reaches the independent authentication check;
- required-header omission and header or body disagreement fails closed;
- upload without a specific authorization event fails closed;
- mutation without exact source identity fails closed;
- a retry is idempotent;
- delete, cancelled, expired, and physically purged are distinct;
- receipts bind source and output identity;
- no network egress occurs.

The machine contract freezes the implementation choices that must not be left
to the mock's developer:

- bind exactly to `127.0.0.1` on a test-selected ephemeral port, assert the
  observed local address, and prove a non-loopback connection is refused;
- preload guards that deny DNS, global fetch, and every socket except the exact
  loopback mock port, with zero attempted external connections;
- an exact POST `/mcp` request envelope containing content type, both required
  `Accept` media types, protocol version, method, synthetic harness identity,
  conditional name, optional validated `Origin`, and authoritative per-request
  body metadata;
- six synthetic auth contexts: anonymous; two active actors, each represented
  in both tenant A and tenant B; and a revoked tenant A actor;
- exact workspace, document, immutable version, authorization event, operation,
  receipt, and lifecycle records;
- exact lifecycle transitions from absent through active, tombstoned,
  purge-pending, and physically purged;
- an idempotency scope and request identity where same-key same-request returns
  the prior effect, same-key different-request fails, and concurrent same-key
  creates exactly one effect;
- exact HTTP behavior that allows absent `Origin` for non-browser clients but
  rejects present invalid values, plus exact envelope, protocol,
  authentication, scope, and method errors and stable no-effect tool errors for
  object, authorization, identity, and idempotency failures.

The JSON contract is normative for those slice choices. The Markdown explains
their rationale and evidence boundary. The verifier freezes the complete
versioned contract, complete source-specific ledger, and exact ADR bytes. Its
output does not automate source truth; the dated manual review receipts remain
part of the evidence.

It explicitly excludes a public listener, provider deployment, OAuth provider
mutation, real authentication, user files, production storage, external
downloads, or local companion installation.

## Production flip gates

The production verdict changes from WAIT only when all ten gates in
[`config/remote-hybrid-trust-boundary.v1.json`](../config/remote-hybrid-trust-boundary.v1.json)
have exact evidence:

1. Current official source refresh plus exact host workflow rows.
2. Owner-approved custody, privacy, retention, deletion, backup, region, and
   subprocessor decision.
3. Established identity provider and OAuth interoperability.
4. Independent all-surface tenant isolation proof.
5. Human-observed, content-addressed upload and download authorization.
6. Bounded and isolated hostile-document worker evidence.
7. Mutation, idempotency, provenance, and output validation integrity.
8. Full lifecycle and clock-bounded deletion or purge evidence.
9. Quotas, abuse controls, redacted observability, rollback, kill switch,
   incident response, and recovery drill.
10. Human approval of legal, commercial, support, and production-spend
    boundaries.

Any P0 finding returns the service to WAIT. Native or hosted evidence for one
host qualifies only that host, version, account mode, configuration, workflow,
and artifact.

## Implementation ownership

The next authorized tranche should split into narrow Beads:

1. Loopback mock and fail-closed request envelope.
2. Tenant and object policy model with exhaustive negative tests.
3. Content-addressed upload authorization model using synthetic bytes.
4. Versioned mutation and idempotency model.
5. Lifecycle state model and purge receipt.
6. OAuth provider selection and interoperability plan, still without account
   mutation until approved.
7. Host-specific synthetic workflow qualification.
8. MCP Apps review and approval prototype after the tool-only path passes.
9. Tasks state machine after basic operations pass.
10. Optional local companion only after one-object handoff review.

Do not combine those lanes into a single service build. Each lane should freeze
its policy, adversarial mutants, evidence boundary, and flip conditions before
implementation.

## Sources

The machine-readable ledger records exact source URLs and supported claims.
Primary source families are:

- MCP final `2026-07-28` transport, discovery, authorization, and security
  documentation.
- MCP Apps and Tasks extension documentation.
- Anthropic custom connector, Cowork architecture, Cowork surfaces, and
  Messages API MCP connector documentation.
- OpenAI MCP, plugin server, plugin authentication, MCP Apps UI, and Codex
  cloud environment documentation.

All were retrieved or refreshed on 2026-07-30. Future implementation must
refresh drift-prone host rows before relying on them.
