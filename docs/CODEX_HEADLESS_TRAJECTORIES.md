# Headless Codex comparison trajectories

`scripts/eval-run-codex-comparison.mjs` records descriptive Codex CLI
trajectories for `pdf-tools.trajectory.v1.compare-and-explain`. It is a
controller for the existing trajectory ingester and grader, not a second
scoring implementation.

The controller separates the workflow into three commands so the denominator
is frozen before any model launch:

```bash
# Non-model operation: create a three-entry plan and three isolated workspaces.
node scripts/eval-run-codex-comparison.mjs plan \
  --campaign /home/mat/Documents/pdf-tools-codex-comparison-2026-07-21

# Each command below launches one paid remote-model attempt exactly once.
node scripts/eval-run-codex-comparison.mjs run \
  --campaign /home/mat/Documents/pdf-tools-codex-comparison-2026-07-21 \
  --repeat 1
node scripts/eval-run-codex-comparison.mjs run \
  --campaign /home/mat/Documents/pdf-tools-codex-comparison-2026-07-21 \
  --repeat 2
node scripts/eval-run-codex-comparison.mjs run \
  --campaign /home/mat/Documents/pdf-tools-codex-comparison-2026-07-21 \
  --repeat 3

# Non-model operation: refuse partial sets, ingest the full batch, then grade.
node scripts/eval-run-codex-comparison.mjs finalize \
  --campaign /home/mat/Documents/pdf-tools-codex-comparison-2026-07-21
```

Use `plan --pilot` for a separate, predeclared one-attempt pilot. A pilot is
not silently added to a later three-run set. `--count N` is available when a
different denominator is deliberately declared before execution. The default
model is `gpt-5.6-sol`; use `--model` only at planning time.

## What planning freezes

`plan` performs no model inference. It creates the campaign directory under
`/home/mat/Documents`, copies the two public synthetic PDFs into every planned
workspace, makes the copies read-only, and verifies these literal SHA-256
digests:

```text
input/before.pdf  bca00ea1e9c27e45c58ace3a80d4df0a56db91c15c0e3d812fe3d22a925b2168
input/after.pdf   8dcb160b21f450a388de112767ad3a25b026f32bfd8064cfcc85e8825374b7e0
```

The pre-run plan binds the complete repeat denominator, invocation IDs, suite
canonical digest, expected-semantics digest, shared fixture-instance digest,
and per-repeat nonce. The campaign record additionally binds the exact Codex
and Node.js versions plus hashes of the complete server source surface,
lockfile, controller, ingester, evaluator, shared PNG validator, grader,
corpus manifest, suite, trust registry, and tool contracts. A self-checking
launch-contract digest covers the campaign fields. It also fingerprints the
resolved Codex and Node executables, MCP SDK, `pdf-lib`, `pdfjs-dist`, JavaScript
canvas package, platform-native canvas binary, and the lexical and real
`node_modules` roots. Deterministic package-tree commitments cover the actual
ESM SDK, PDF libraries, canvas bindings, their recursively resolved production,
optional, and peer dependency closure, the Codex launcher, and the
current-platform native Codex package, rather than only their entry files.
Hoisted dependencies are fingerprinted at their resolved package roots. A `run`
refuses to launch if any of those inputs, fields, installed runtimes, retained
planning files, or its planned workspace changed.

Planner and result signatures remain null. These are unsigned descriptive
measurements on one repeated fixture instance, not independent benchmark
evidence.

## Isolation and observation boundary

Every attempt runs in its own `runs/repeat-NN/workspace`. The controller:

- ignores user Codex configuration and project instructions;
- disables shell, unified execution, browser, computer use, apps, plugins,
  sub-agents, memories, hooks, workspace dependencies, and related surfaces;
- configures only the `pdf_tools` stdio MCP server;
- exposes only `read_pdf_pages` and `render_pdf_page` from that server;
- uses Codex's read-only sandbox and an exact four-call prompt;
- restricts PDF Tools paths, profiles, downloads, and temporary files to the
  isolated workspace; and
- never copies or records authentication material.

Codex receives an explicit allowlisted parent environment frozen at planning
time. Non-secret values are recorded exactly; the optional API-key value is
represented by a salted commitment and passed only when present. Proxy,
`CODEX_HOME`, ambient `PDF_TOOLS_*`, and all other undeclared variables are
stripped, preventing VM session state from silently selecting another renderer
or endpoint.

These are model-visible tool and process configuration controls. They are not
an OS-level network namespace. Remote model inference is predeclared and
accounted separately. The PDF server's external-request record is derived from
the retained tool trajectory; it is not presented as packet capture.

The campaign directory is mode `0700`, and runtime/workspace fingerprints are
checked repeatedly before launch and again at finalization. This detects
persistent drift but cannot defeat a malicious process running as the same VM
account that swaps a checked path only inside the validation-to-use race. The
same-account VM boundary is therefore explicit in the descriptive claim; a
stronger claim needs an immutable snapshot or OS isolation.

The controller writes stdout bytes unchanged to `codex.jsonl`, stderr bytes to
`codex.stderr`, and an incremental `jsonl-arrivals.jsonl` sidecar. Each arrival
record binds the line number, host receipt timestamp, raw-line SHA-256, parsed
event when valid, and parse error when invalid. No event is removed or
rewritten before ingestion.

Filesystem manifests are captured before launch and after process completion.
Source-hash events are recorded before any MCP call. Call observations use the
same public raw item ID on `item.started` and `item.completed`. Evidence records
are created only when an exact successful required call and its structured
page or render geometry are present.

Codex may resize or otherwise transform an MCP image before exposing it in
public JSONL. The trajectory contract therefore records the host-visible PNG
hash/dimensions separately from the server-declared renderer, scale, and pixel
geometry. A transformation-tolerant visual oracle also normalizes that PNG and
compares it with an independently rendered, SHA-256-pinned corpus fixture. Page
aspect ratio, normalized pixel error, and foreground overlap must all pass;
valid-but-blank or unrelated images are rejected. Final grading recomputes the
complete oracle from the retained PNG and pinned source fixture and requires
exact agreement with the ingested oracle record. It does not claim that JSONL
contains the byte-identical original MCP image. Proving original MCP transport
bytes would require a separately reviewed transparent stdio observer.

## Product versus harness outcomes

The classification boundary matches the trajectory ingester:

- If any `pdf_tools` MCP call completed, the attempt is a product trial. A bad
  answer, failed tool result, malformed later event, nonzero Codex exit, or
  retained host diagnostic cannot relabel it as a harness failure.
- If Codex completes its turn without any PDF call, the attempt is still a
  failed product trial. This keeps tool-avoidance failures in the product
  denominator.
- A spawn failure, timeout, or process that ends before a completed turn and
  before any completed PDF call is a harness failure, with launcher exit,
  signal, timeout, stderr digest, and a retained host event.

The exclusive `launch-claim.json` prevents accidentally paying for the same
planned invocation twice. If the controller itself is killed before it can
write `observer.json`, do not delete the claim or rerun automatically. Preserve
the partial stdout, stderr, and arrival ledger and perform an operator audit;
the frozen denominator must resolve to one product or harness record.

Host diagnostic text stays in raw JSONL. The launcher record stores only its
item ID, type, and message hash, and the observer adds an explicit limitation.
The ingester retains the narrowly recognized Codex skill-budget warning as a
hash-bound host diagnostic; unknown diagnostic shapes remain fail-closed.

## Campaign records

Each campaign contains:

```text
campaign.json
pre-run-plan.json
runs/repeat-NN/
  workspace/
  prompt.txt
  planned-workspace-manifest.json
  launch-claim.json
  launcher-start.json
  codex.jsonl
  codex.stderr
  jsonl-arrivals.jsonl
  pre-filesystem-manifest.json
  post-filesystem-manifest.json
  launcher-record.json
  observer.json
batch-manifest.json
measured-trials.json
trajectory-report.json
```

`finalize` checks every retained file for every planned entry before creating
the batch manifest. It replays raw JSONL against the arrival ledger, verifies
the launch claim and exact command, arguments, source/runtime fingerprints,
stdout/stderr digests, pre/post filesystem snapshots, and then rederives the
entire observer sidecar from those retained inputs. It then invokes
`scripts/eval-ingest-codex-trajectory.mjs` once for the complete batch and
evaluates the resulting trial set with
`scripts/eval-run-trajectories.mjs`. A partial first result cannot redefine the
denominator.

## Offline verification

Controller tests do not invoke Codex:

```bash
npx vitest run test/eval/codex-comparison-controller.test.js
```

They cover exact plan cardinality, isolation arguments, split UTF-8 JSONL,
product/harness classification, deterministic evidence binding, filesystem
effects, observer construction, and complete batch manifests. An offline fake
Codex executable also exercises plan-to-finalize success, a completed no-tool
product failure, exclusive concurrent claims, prompt and descendant-symlink
tampering, altered arrival evidence, output-symlink safety, timeout accounting,
and a fully passing four-call read/render trajectory through final grading.
