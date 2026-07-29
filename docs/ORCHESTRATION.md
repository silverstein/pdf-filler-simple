# Autonomous Maintainer Orchestration

This is the operating contract for long-running, multi-session PDF Tools work.
It exists so an authorized epic continues without requiring the maintainer to
approve every next step, while preserving clear human authority at consequential
boundaries.

## Control plane

| Concern | Durable system |
|---|---|
| Priorities, dependencies, ownership, readiness | Beads |
| Code, tests, artifacts, and reviewable changes | Git branches and worktrees |
| Agent identity, reservations, inboxes, and handoffs | MCP Agent Mail |
| Public user reports and contributor work | GitHub Issues and Pull Requests |
| Public evaluation and release contract | `docs/EVALUATION.md` |
| Private contract, sponsor, commercial, and cross-project context | Maintainer PARA vault |
| Live consoles and operator visibility | `tmux` session `pdf` on silvercloud |

Chat transcripts are disposable execution context. A decision, failure, test
result, or handoff that matters must be written to one of the durable systems.

## Execution host policy

Silvercloud is the always-on agent control plane and is resource constrained.
Keep its workload to coordination, static inspection, bounded file edits, Git
operations, and small incremental indexes. Do not run dependency installs,
broad PDF test suites, UI builds, MCPB packaging, full differential runs, or
other memory-heavy work on Silvercloud when a Mac execution host is available.

Prefer Silverbook for resource-intensive work. If it is offline, use an
available iMac or Stonebook on the tailnet. Use one test worker unless evidence
shows a higher concurrency is safe. Record the exact execution host, operating
system, architecture, runtime version, candidate commit, and command with every
material test or artifact result.

## Roles and lanes

### Control tower

The control tower owns sequencing and integration. It:

1. reconciles contract priorities, user reports, Beads, and current evidence;
2. selects a small active tranche and keeps work-in-progress bounded;
3. creates one isolated worktree and Agent Mail identity per code-changing lane;
4. assigns exact acceptance criteria, permissions, forbidden actions, and evidence;
5. monitors agent mail, tmux consoles, branches, tests, and blockers;
6. schedules independent adversarial review before integrating meaningful changes;
7. merges locally, runs tranche gates, updates Beads/evidence, and pushes only at milestones;
8. immediately schedules the next ready work unless an exit condition is met.

The control tower does not become an implementation bottleneck. Execution lanes
own their bounded outcome and continue through research, implementation, testing,
self-review, and handoff without pausing for routine approval.

### Execution lane

Each lane gets one Bead or one tightly coupled vertical slice. On startup it must:

1. read the applicable `AGENTS.md`, `CLAUDE.md`, Bead, and named specification;
2. register in Agent Mail under the canonical repository project;
3. inspect active reservations and reserve the files it expects to edit;
4. verify its worktree branch and clean starting state;
5. restate its outcome, acceptance evidence, forbidden actions, and stop gates.

The lane then executes this loop:

**inspect → establish baseline → implement smallest useful slice → targeted tests →
broader proportional tests → adversarial self-review → refine below 9.5/10 →
record evidence → local commit → Agent Mail handoff → release reservations → next
ready work or explicit gate.**

Planning is not a terminal state when implementation remains safe and in scope.
A progress report is not a request for permission to continue.

### Independent review lane

Meaningful runtime, security, document-mutation, host, packaging, or release work
requires a separate review context. The reviewer receives the Bead, base/head
commits, acceptance criteria, evidence, and relevant threat boundaries. It must
try to falsify the result, distinguish product failures from harness failures,
and produce a clear pass, conditional pass, or reject verdict.

## Autonomy boundary

### Continue autonomously

- read repositories, specifications, public sources, logs, and scrubbed fixtures;
- create bounded Beads, branches, worktrees, tests, synthetic fixtures, and docs;
- implement and refactor inside accepted public-safe technical scope;
- run builds, tests, protocol clients, browsers, and isolated artifact smokes;
- make reversible local commits and merge reviewed work locally;
- install a candidate on explicitly designated test hosts with an exact hash,
  backup, and recovery path when the active tranche authorizes host validation;
- update factual Bead notes, evidence ledgers, and public issue drafts;
- continue to the next ready task within the active tranche.

### Notify the maintainer, but do not pause safe work

- a non-blocking upstream change, flaky harness, or lower-priority defect is found;
- a task estimate materially changes but another ready lane remains;
- a host or external tester is unavailable while local/CI work can continue;
- research changes a recommendation but no irreversible decision is required.

Create a Bead or record the evidence, send an informational update, and continue
with the best unblocked work.

### Human gate: stop only the affected lane

- publishing, replacing, rolling back, or announcing a public release;
- executing or fabricating signature intent, cryptographic signing, or external sharing;
- spending money, enabling a paid service, or materially increasing build/hosting cost;
- requesting, rotating, or exposing credentials and production secrets;
- destructive or difficult-to-recover changes to user, production, or external data;
- legal, contractual, compliance-certification, pricing, or commercial commitments;
- contacting Max/Lumin, Slack participants, users, or reporters beyond factual
  maintainer updates already authorized by a reviewed evidence record;
- public disclosure of an unpatched vulnerability;
- a product choice whose alternatives materially change scope and user experience.

One gated lane does not halt the program. The control tower records the gate and
schedules other ready work.

## Worktree and file ownership

- Code-changing worktrees live under `/home/mat/Sites/pdf-tools-worktrees/` and
  are named `codex-<task>` or `claude-<task>`.
- One branch and one primary owner per worktree. Never share an uncommitted
  worktree between agents.
- Use Agent Mail exclusive reservations for expected edit paths. Reservations
  are coordination signals, not a substitute for isolated worktrees.
- Do not install dependencies in a worktree unless its task requires a build or
  test. Remove the worktree after its commits are integrated and reachable.
- Never use `/tmp` worktrees or leave completed work only in an uncommitted tree.

## Commit, merge, and push budget

Agents commit locally at coherent checkpoints so their work survives crashes and
can be reviewed independently. They do not push every checkpoint.

The control tower pushes only when one of these milestone conditions is met:

- a reviewed release-blocking fix or native-host evidence tranche is complete;
- a coherent evaluation or feature vertical slice is green and documented;
- a handoff must be backed up before a long external dependency or human gate;
- a security fix requires protected remote continuity;
- the maintainer explicitly requests an intermediate push.

Before a milestone push, integrate compatible branches, run the tranche-level
gates, update Beads and evidence once, and push one coherent batch. This minimizes
CI/Vercel build-minute consumption without risking uncommitted work loss.

## Handoff contract

Every lane handoff contains:

- Bead ID and user-visible outcome;
- worktree, branch, base commit, and head commit;
- files changed and any active reservations;
- exact tests, host/app versions, artifact hashes, screenshots/logs, and results;
- adversarial findings and fixes;
- unresolved risks, known limitations, and whether a human gate is active;
- recommended next ready work.

Send the handoff through Agent Mail using the Bead ID as the thread ID. Update the
Bead only from the canonical integration checkout to avoid concurrent JSONL merge
conflicts.

## Deep-malformed qpdf oracle containment

The v4 deep-malformed macOS campaign treats qpdf as an untrusted oracle rather
than as part of the Node product process. Every PDF-dependent qpdf route
(`--check`, page count, object-stream projection, and JSON graph extraction)
must execute through the receipt-bound native launcher
`test/eval/native/qpdf-macos-budget-exec.c`. The launcher is exec-only: it
inherits and verifies its direct row-runner parent, both processes' process
group, and their `getsid(2)` equality; measures its pre-limit macOS VM-map size;
applies a checked 1.5 GiB headroom as an absolute `RLIMIT_AS`; reads back every
qpdf-only rlimit and remeasures its post-limit VM-map size; emits those values
in a fixed-endian READY or ERROR frame on fd 3; marks fd 3
close-on-exec; and replaces itself with qpdf. READY followed by fd 3 EOF is the
required exec proof.

The active successor entrypoints are
`prepare-deep-malformed-macos-campaign-v4.js`,
`deep-malformed-macos-campaign-v4.js`,
`deep-malformed-row-runner-v4.js`, and
`compare-deep-malformed-macos-campaign-v4.js`. The v2 and v3 files remain
frozen because historical plans and receipts bind their paths, protocols, and
byte identities. The v4 campaign deliberately reuses only the separately
frozen v2 corpus provisioning protocol; it does not reuse a v2 or v3 row or
campaign protocol.

The v4 response scanner retains the raw response identity and computes a
separate semantic digest. It may normalize only one generated
`/_meta/viewUUID` from a successful `read_pdf_fields` call, or the two
byte-equal `last_mutation_at` values at
`/structuredContent/last_mutation_at` and `/_meta/last_mutation_at` from a
successful `rotate_pdf_pages` call. Each value must match its exact generated
format and fall within the captured call wall-clock interval, with the
receipt-bound one-second skew policy. Same-named values at every other path
remain in the semantic digest.

The initial uncalibrated policy is a 1.5 GiB address-space headroom above the
launcher's measured pre-exec VM-map size, a 256 MiB output file, CPU soft/hard
limits of 8/9 seconds, 64 open files, zero core bytes, and a 10-second wall
deadline. This is an absolute address-space cap derived from launcher state,
not a claim that qpdf has exactly 1.5 GiB of usable memory after `execve(2)`.
Its `calibration_required` field remains true until repeated exact-host qpdf
post-exec measurements, a paired under-limit mapping success and controlled
over-limit mapping denial, benign-corpus headroom, and retained-hostile
containment have been reviewed. A failed qpdf
check short-circuits page count and fingerprint routes. No v4 result may
qualify if launcher authority, exact-limit proof, exec proof,
process-group/session inheritance, executable stability, or the route result
is missing.

## Active-tranche exit conditions

An autonomous run stops only when:

1. the tranche's accepted outcomes and evidence gates are complete;
2. no ready work remains inside the tranche;
3. every remaining lane is behind a recorded human or external-state gate; or
4. continuing would cross the autonomy boundary above.

Token use, context compaction, elapsed time, a completed subtask, or sending a
status update are not exit conditions. Recover state and continue.

## Current first tranche

The initial autonomous tranche is intentionally narrow:

1. Prove the exact current MCPB in macOS Claude Desktop and investigate issues
   #44/#47 plus the macOS portion of #42/#43.
2. Establish the first versioned corpus/scorer slice under Bead
   `pdf-toolkit-mcp-igr.1`.
3. Reconcile dependency PRs and stale execution state without merging risky
   runtime upgrades.
4. Independently review and integrate the results, then select the next tranche
   from the contract-ordered priorities: PDF-to-Markdown, comparison,
   accessibility, and the confirmed electronic-signature handoff.
