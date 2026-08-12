# Agent-workflow protocol v4

## Status

Protocol v4 has a public, no-inference protocol core. It is
`preseal_no_inference`. No v4 canary, seal, measured campaign, model inference,
publication, product-readiness claim, or release is authorized by this code.

The measured campaign is explicitly `measured_campaign_not_authorized`. A
future run requires a separately reviewed macOS host, a sealed private adapter,
and independent pre-run review.

## Public and private boundaries

The public repository contains:

- strict preseal bundle-projection and commitment-only plan schema validators;
- a deterministic two-arm paired schedule builder;
- a deterministic synthetic arithmetic calculator;
- a public synthetic calibration fixture;
- a clean-worktree no-model rehearsal;
- tests for model-error denominators, protocol invalidity, utility, safety, and
  diagnostic exact conformance.

The synthetic fixture is machinery calibration. It is not a benchmark, a
hidden test set, model evidence, or product evidence.

A real measured campaign must use a separately sealed private adapter. Do not
put any real case bodies, oracle answers, thresholds, schedule, participant
prompts, raw model output, private evidence configuration, credentials, or
authority infrastructure into public Git, public issue metadata, logs, or
diagnostics. Persisted plans contain commitments and bounded metadata only, but
they still remain private. Removing plaintext does not make a plan safe to
publish.

## Frozen authorities

Before the first v4 inference, the private bundle must freeze:

- source commit and current skill byte identity;
- current tool contract and response schema;
- prompt assembly and treatment/control definitions;
- case pack, semantic oracle, diagnostic oracle, scorer policy, schedule,
  estimand, thresholds, and no-retry rule;
- runner, controller, executor, attester, binder, scorer, lifecycle policy,
  isolation policy, normalized environment, and executable identities;
- evidence paths, receipt ordering, verification authority, and the accepted
  case-free canary record.

The projection validator represents public artifact identities as exact byte
lengths and SHA-256 values. Synthetic public inputs use the structured
`public-sha256-v1` scheme. Private sealed inputs must use the structured
`blinded-sha256-v1` scheme with high-entropy secret blinding managed by the
private adapter. The public validator rejects direct public-content
commitments for private inputs. A plain public SHA-256 value is not a secrecy
boundary.

Every persisted plan declares the same synthetic-public or private-sealed
visibility as its commitment scheme. The public calculator accepts only
synthetic-public bundles and plans. Private plans require blinded commitments
and cannot be passed to the public calculator.

Any policy, case, schema, oracle, scorer, skill, schedule, controller, prompt,
or treatment correction after the first v4 inference invalidates that measured
protocol and requires a new protocol version. Never update a frozen identity
to make old evidence appear current.

## Schedule and scoring rules

`balancedAgentWorkflowScheduleV4` produces one treatment and one control run
for every case/repetition pair. Run identity, order, arm, pair, and denominator
must match the frozen plan exactly.

The public calculator exercises arithmetic only with the committed synthetic
fixture:

- a valid response receives explicit semantic-safety, semantic-utility, and
  exact-diagnostic booleans;
- malformed or schema-invalid model output is `model_error`, remains in the
  denominator, and receives no passing oracle outcome;
- missing, duplicate, reordered, or identity-mismatched rows are protocol
  invalidity and stop scoring.

The calculator never issues integrity, scientific, or overall verdict fields.
It proves that synthetic model errors stay in the denominator and that safety,
utility, and exact-diagnostic arithmetic behaves as designed. Exact
conformance remains separate because one canonical decomposition must not
become an answer key. A response that blocks everything can satisfy synthetic
safety arithmetic, but not utility arithmetic.

A future private measured verifier must authenticate the exact sealed bundle,
policy, schedule, oracle adapter, accepted canary, binder outputs, signed
receipt chain, execution lifecycle, cleanup, and campaign authority before it
issues any measured verdict.

## V3 carry-over

V3 measured a frozen 15,571-byte skill body at SHA-256
`c782f69b209bb78af0aca5cb4659d01e64a6d9dc9ae68328ef9e547be6c22f4f`.
Its execution-integrity result and protocol-design lessons remain historical
evidence for that exact campaign.

V3 semantic safety, utility, exact conformance, and bounded prompt-effect
outcomes apply only to that frozen body and exact campaign. They neither
validate nor condemn the current skill. V3 scripts, constants, resources, and
private receipts remain historical authorities and must not be relabeled as
v4.

The verified v3 retirement stays in place until a sealed, runnable v4 campaign
replaces every retired responsibility. Landing this public core alone does not
authorize removing the v3 skips or retirement check.

## No-model rehearsal

After committing the candidate in a clean worktree, run:

```bash
node scripts/eval-rehearse-agent-workflow-protocol-v4.mjs \
  > /absolute/private/path/agent-workflow-v4-no-model-rehearsal.json
```

The receipt binds the clean source commit, public protocol core, rehearsal
script, synthetic fixture, current skill candidate, current v3 tool-contract
candidate, strict synthetic outcome schema, current runner candidate,
commitment-only synthetic plan, and synthetic arithmetic result. Candidate
identities are review inputs, not a sealed measured protocol. The receipt
states that no model was invoked and that the measured campaign is not
authorized.

This rehearsal proves only deterministic public protocol wiring. It does not
prove inference quality, PDF task correctness, configured MCP behavior, MCPB
behavior, native-host behavior, isolation against a hostile local actor,
portability, or release readiness.

## Independent gates

The following authorities remain separate:

1. case-free canary authorization;
2. protocol seal authorization;
3. measured-campaign authorization;
4. result-publication authorization.

Passing or authorizing one gate does not authorize any other gate.
