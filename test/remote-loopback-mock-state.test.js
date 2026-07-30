import fs from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  createRemoteLoopbackState,
  REMOTE_LOOPBACK_STATE_CONSTANTS as STATE_CONTRACT,
  SYNTHETIC_AUTH_CONTEXTS as AUTH,
  syntheticSha256,
} from "./helpers/remote-loopback-mcp-mock.mjs";

const CONTRACT = JSON.parse(await fs.readFile(
  new URL("../config/remote-hybrid-trust-boundary.v1.json", import.meta.url),
  "utf8",
));
const FIXTURE = Object.freeze({
  id: "comparison_base_v1",
  byte_length: 1_024,
  sha256: "a".repeat(64),
});

function createState(options = {}) {
  return createRemoteLoopbackState({
    contract: CONTRACT,
    fixtures: new Map([[FIXTURE.id, FIXTURE]]),
    ...options,
  });
}

async function expectSuccess(call) {
  const result = await call;
  expect(result.ok).toBe(true);
  return result.value;
}

async function expectFailure(call, code) {
  const result = await call;
  expect(result).toMatchObject({ ok: false, code });
  return result;
}

async function prepareDocument(state, {
  context = AUTH.tenant_a_owner,
  authContextId = "tenant_a_owner",
  workspaceId = "workspace_a",
  documentId = "document_a",
  sourceVersionId = "source_v1",
} = {}) {
  await expectSuccess(state.callTool(
    context,
    "create_synthetic_workspace",
    { workspace_id: workspaceId },
  ));
  const registration = state.trustedFixtureSetup
    .provisionRegistrationAuthorization({
      authContextId,
      workspaceId,
      documentId,
      fixtureId: FIXTURE.id,
      sourceVersionId,
    });
  await expectSuccess(state.callTool(
    context,
    "register_synthetic_document_identity",
    {
      workspace_id: workspaceId,
      document_id: documentId,
      fixture_id: FIXTURE.id,
      source_version_id: sourceVersionId,
      authorization_event_id: registration.authorization_event_id,
    },
  ));
  return {
    context,
    authContextId,
    workspaceId,
    documentId,
    sourceVersionId,
  };
}

function mutationArguments({
  workspaceId = "workspace_a",
  documentId = "document_a",
  sourceVersionId = "source_v1",
  sourceByteLength = FIXTURE.byte_length,
  sourceSha256 = FIXTURE.sha256,
  authorizationEventId,
  idempotencyKey = "mutation_key_1",
  arguments: args = { field: "synthetic-value", page: 1 },
} = {}) {
  return {
    workspace_id: workspaceId,
    document_id: documentId,
    source_version_id: sourceVersionId,
    source_byte_length: sourceByteLength,
    source_sha256: sourceSha256,
    tool_name: STATE_CONTRACT.mutation_tool,
    tool_version: STATE_CONTRACT.mutation_tool_version,
    arguments: args,
    destination_and_effects: STATE_CONTRACT.mutation_destination,
    authorization_event_id: authorizationEventId,
    policy_version: STATE_CONTRACT.policy_version,
    idempotency_key: idempotencyKey,
  };
}

function provisionMutation(state, {
  authContextId = "tenant_a_owner",
  workspaceId = "workspace_a",
  documentId = "document_a",
  arguments: args = { field: "synthetic-value", page: 1 },
  expiresInMs,
} = {}) {
  return state.trustedFixtureSetup.provisionMutationAuthorization({
    authContextId,
    workspaceId,
    documentId,
    arguments: args,
    expiresInMs,
  });
}

describe("remote loopback MCP mock state", () => {
  it("derives tenant and actor only from synthetic auth and rejects unknown authority fields", async () => {
    const state = createState();
    await expectFailure(
      state.callTool(AUTH.anonymous, "create_synthetic_workspace", {
        workspace_id: "workspace_a",
      }),
      "INSUFFICIENT_SCOPE",
    );
    await expectFailure(
      state.callTool(AUTH.tenant_a_revoked, "create_synthetic_workspace", {
        workspace_id: "workspace_a",
      }),
      "INSUFFICIENT_SCOPE",
    );
    await expectFailure(
      state.callTool(AUTH.tenant_a_owner, "create_synthetic_workspace", {
        workspace_id: "workspace_a",
        tenant_id: "synthetic_tenant_b",
      }),
      "INVALID_ARGUMENTS",
    );
    expect(state.snapshot().data_plane.workspaces).toEqual([]);
  });

  it("registers only an allowlisted fixture under a single-use exact trusted event", async () => {
    const state = createState();
    await expectSuccess(state.callTool(
      AUTH.tenant_a_owner,
      "create_synthetic_workspace",
      { workspace_id: "workspace_a" },
    ));
    const event = state.trustedFixtureSetup
      .provisionRegistrationAuthorization({
        authContextId: "tenant_a_owner",
        workspaceId: "workspace_a",
        documentId: "document_a",
        fixtureId: FIXTURE.id,
        sourceVersionId: "source_v1",
      });
    const before = state.snapshot();
    await expectFailure(
      state.callTool(
        AUTH.tenant_a_owner,
        "register_synthetic_document_identity",
        {
          workspace_id: "workspace_a",
          document_id: "document_a",
          fixture_id: "not_allowlisted",
          source_version_id: "source_v1",
          authorization_event_id: event.authorization_event_id,
        },
      ),
      "SYNTHETIC_FIXTURE_NOT_ALLOWED",
    );
    expect(state.snapshot()).toEqual(before);

    const registered = await expectSuccess(state.callTool(
      AUTH.tenant_a_owner,
      "register_synthetic_document_identity",
      {
        workspace_id: "workspace_a",
        document_id: "document_a",
        fixture_id: FIXTURE.id,
        source_version_id: "source_v1",
        authorization_event_id: event.authorization_event_id,
      },
    ));
    expect(registered.source_version).toMatchObject({
      byte_length: FIXTURE.byte_length,
      sha256: FIXTURE.sha256,
      parent_version_id: null,
      created_by_operation_id: null,
    });
    const after = state.snapshot();
    expect(after.evidence_plane.authorization_events[0].consumed_at)
      .not.toBeNull();
    await expectFailure(
      state.callTool(
        AUTH.tenant_a_owner,
        "register_synthetic_document_identity",
        {
          workspace_id: "workspace_a",
          document_id: "document_b",
          fixture_id: FIXTURE.id,
          source_version_id: "source_v1",
          authorization_event_id: event.authorization_event_id,
        },
      ),
      "AUTHORIZATION_OR_IDENTITY_FAILED",
    );
  });

  it("binds every mutation authority field and preserves exact no-effect state on denial", async () => {
    const state = createState();
    await prepareDocument(state);
    const operationArguments = { alpha: 1, nested: { beta: "two" } };
    const event = provisionMutation(state, {
      arguments: operationArguments,
    });
    const valid = mutationArguments({
      authorizationEventId: event.authorization_event_id,
      arguments: operationArguments,
    });
    const mutants = [
      value => {
        value.workspace_id = "workspace_b";
      },
      value => {
        value.document_id = "document_b";
      },
      value => {
        value.source_version_id = "source_v2";
      },
      value => {
        value.source_byte_length += 1;
      },
      value => {
        value.source_sha256 = "b".repeat(64);
      },
      value => {
        value.tool_name = "other_tool";
      },
      value => {
        value.tool_version = "2";
      },
      value => {
        value.arguments.alpha = 2;
      },
      value => {
        value.destination_and_effects = "other_destination";
      },
      value => {
        value.authorization_event_id = "other_event";
      },
      value => {
        value.policy_version = "other_policy";
      },
      value => {
        value.tenant_id = "synthetic_tenant_b";
      },
      value => {
        value.verified_actor_id = "synthetic_actor_b";
      },
    ];
    for (const mutate of mutants) {
      const candidate = structuredClone(valid);
      mutate(candidate);
      const before = state.snapshot();
      const result = await state.callTool(
        AUTH.tenant_a_owner,
        "simulate_identity_bound_mutation",
        candidate,
      );
      expect(result.ok).toBe(false);
      expect([
        "AUTHORIZATION_OR_IDENTITY_FAILED",
        "INVALID_ARGUMENTS",
      ]).toContain(result.code);
      expect(state.snapshot()).toEqual(before);
    }
    expect(
      state.snapshot().evidence_plane.authorization_events.at(-1).consumed_at,
    ).toBeNull();
  });

  it("creates one immutable child version and an exact server-derived receipt", async () => {
    const state = createState();
    await prepareDocument(state);
    const args = { alpha: 1, nested: { beta: "two" } };
    const event = provisionMutation(state, { arguments: args });
    const result = await expectSuccess(state.callTool(
      AUTH.tenant_a_owner,
      "simulate_identity_bound_mutation",
      mutationArguments({
        authorizationEventId: event.authorization_event_id,
        arguments: args,
      }),
    ));
    const snapshot = state.snapshot();
    expect(snapshot.data_plane.effects).toBe(1);
    expect(snapshot.data_plane.versions).toHaveLength(2);
    expect(snapshot.data_plane.versions[0]).toMatchObject({
      version_id: "source_v1",
      byte_length: FIXTURE.byte_length,
      sha256: FIXTURE.sha256,
      parent_version_id: null,
    });
    expect(snapshot.data_plane.versions[1]).toMatchObject({
      version_id: result.receipt.output_version_id,
      parent_version_id: "source_v1",
      created_by_operation_id: result.operation.operation_id,
    });
    expect(result.receipt).toMatchObject({
      operation_id: result.operation.operation_id,
      verified_actor_id: AUTH.tenant_a_owner.verified_actor_id,
      tenant_id: AUTH.tenant_a_owner.tenant_id,
      workspace_id: "workspace_a",
      document_id: "document_a",
      source_version_id: "source_v1",
      source_byte_length: FIXTURE.byte_length,
      source_sha256: FIXTURE.sha256,
      tool_name: STATE_CONTRACT.mutation_tool,
      tool_version: STATE_CONTRACT.mutation_tool_version,
      canonical_arguments_sha256: syntheticSha256(args),
      authorization_event_id: event.authorization_event_id,
      policy_version: STATE_CONTRACT.policy_version,
      policy_result: "allow",
      idempotency_key: "mutation_key_1",
    });
    expect(result.receipt.output_sha256)
      .toBe(snapshot.data_plane.versions[1].sha256);
    expect(result.receipt.output_byte_length)
      .toBe(snapshot.data_plane.versions[1].byte_length);
    expect(Object.keys(result.receipt).sort()).toEqual(
      [...CONTRACT.bounded_vertical_slice.record_schemas.receipt].sort(),
    );
  });

  it("treats reordered object keys as the same request and array order as material", async () => {
    const state = createState();
    await prepareDocument(state);
    const args = { alpha: 1, nested: { beta: 2 }, rows: [1, 2] };
    const event = provisionMutation(state, { arguments: args });
    const request = mutationArguments({
      authorizationEventId: event.authorization_event_id,
      arguments: args,
    });
    const first = await expectSuccess(state.callTool(
      AUTH.tenant_a_owner,
      "simulate_identity_bound_mutation",
      request,
    ));
    const reordered = {
      rows: [1, 2],
      nested: { beta: 2 },
      alpha: 1,
    };
    const replay = await expectSuccess(state.callTool(
      AUTH.tenant_a_owner,
      "simulate_identity_bound_mutation",
      mutationArguments({
        ...request,
        authorizationEventId: event.authorization_event_id,
        arguments: reordered,
      }),
    ));
    expect(replay.replayed).toBe(true);
    expect(replay.operation).toEqual(first.operation);
    expect(replay.receipt).toEqual(first.receipt);

    await expectFailure(
      state.callTool(
        AUTH.tenant_a_owner,
        "simulate_identity_bound_mutation",
        mutationArguments({
          ...request,
          authorizationEventId: event.authorization_event_id,
          arguments: { ...reordered, rows: [2, 1] },
        }),
      ),
      "IDEMPOTENCY_CONFLICT",
    );
    expect(state.snapshot().data_plane.effects).toBe(1);
  });

  it("linearizes forced concurrent same-key requests to exactly one effect", async () => {
    let release;
    let entered;
    const enteredPromise = new Promise(resolve => {
      entered = resolve;
    });
    const releasePromise = new Promise(resolve => {
      release = resolve;
    });
    let hookCalls = 0;
    const state = createState({
      beforeActivation: async () => {
        hookCalls += 1;
        entered();
        await releasePromise;
      },
    });
    await prepareDocument(state);
    const args = { concurrent: true };
    const event = provisionMutation(state, { arguments: args });
    const request = mutationArguments({
      authorizationEventId: event.authorization_event_id,
      arguments: args,
    });
    const beforeRunning = state.snapshot();
    const first = state.callTool(
      AUTH.tenant_a_owner,
      "simulate_identity_bound_mutation",
      request,
    );
    await enteredPromise;
    const whileRunning = state.snapshot();
    expect(whileRunning.data_plane).toEqual(beforeRunning.data_plane);
    expect(whileRunning.evidence_plane.operations).toHaveLength(1);
    expect(whileRunning.evidence_plane.operations[0]).toMatchObject({
      status: "running",
      output_version_id: null,
    });
    expect(whileRunning.evidence_plane.authorization_events.at(-1).consumed_at)
      .not.toBeNull();
    expect(
      whileRunning.evidence_plane.control_state.idempotency_reservations,
    ).toHaveLength(1);
    expect(
      whileRunning.evidence_plane.control_state.event_reservations,
    ).toHaveLength(1);
    expect(
      whileRunning.evidence_plane.control_state.source_reservations,
    ).toHaveLength(1);
    expect(whileRunning.evidence_plane.counters.version)
      .toBe(beforeRunning.evidence_plane.counters.version + 1);
    expect(whileRunning.evidence_plane.counters.operation)
      .toBe(beforeRunning.evidence_plane.counters.operation + 1);
    const retries = Array.from({ length: 31 }, () =>
      state.callTool(
        AUTH.tenant_a_owner,
        "simulate_identity_bound_mutation",
        request,
      )
    );
    release();
    const results = await Promise.all([first, ...retries]);
    expect(results.every(result => result.ok)).toBe(true);
    const values = results.map(result => result.value);
    expect(new Set(values.map(value => value.operation.operation_id)).size)
      .toBe(1);
    expect(new Set(values.map(value => value.receipt.output_version_id)).size)
      .toBe(1);
    expect(hookCalls).toBe(1);
    const snapshot = state.snapshot();
    expect(snapshot.data_plane.effects).toBe(1);
    expect(snapshot.data_plane.versions).toHaveLength(2);
    expect(snapshot.data_plane.receipts).toHaveLength(1);
    expect(snapshot.evidence_plane.operations).toHaveLength(1);
    expect(snapshot.evidence_plane.authorization_events.at(-1).consumed_at)
      .not.toBeNull();
  });

  it("conflicts rather than replaying a receipt across documents or workspaces", async () => {
    const state = createState();
    await prepareDocument(state, {
      workspaceId: "workspace_a",
      documentId: "document_a",
    });
    await prepareDocument(state, {
      workspaceId: "workspace_a",
      documentId: "document_b",
    });
    await prepareDocument(state, {
      workspaceId: "workspace_b",
      documentId: "document_a",
    });
    const args = { object_confusion: false };
    const firstEvent = provisionMutation(state, {
      workspaceId: "workspace_a",
      documentId: "document_a",
      arguments: args,
    });
    const first = await expectSuccess(state.callTool(
      AUTH.tenant_a_owner,
      "simulate_identity_bound_mutation",
      mutationArguments({
        workspaceId: "workspace_a",
        documentId: "document_a",
        authorizationEventId: firstEvent.authorization_event_id,
        idempotencyKey: "shared_object_key",
        arguments: args,
      }),
    ));
    for (const [workspaceId, documentId] of [
      ["workspace_a", "document_b"],
      ["workspace_b", "document_a"],
    ]) {
      const event = provisionMutation(state, {
        workspaceId,
        documentId,
        arguments: args,
      });
      const before = state.snapshot();
      await expectFailure(
        state.callTool(
          AUTH.tenant_a_owner,
          "simulate_identity_bound_mutation",
          mutationArguments({
            workspaceId,
            documentId,
            authorizationEventId: event.authorization_event_id,
            idempotencyKey: "shared_object_key",
            arguments: args,
          }),
        ),
        "IDEMPOTENCY_CONFLICT",
      );
      expect(state.snapshot()).toEqual(before);
    }
    expect(first.receipt.document_id).toBe("document_a");
    expect(first.receipt.workspace_id).toBe("workspace_a");
    expect(state.snapshot().data_plane.effects).toBe(1);
  });

  it("allocates an absent child ID without overwriting a colliding source ID", async () => {
    const state = createState();
    await prepareDocument(state, { sourceVersionId: "synthetic_version_1" });
    const args = { preserve_source: true };
    const event = provisionMutation(state, { arguments: args });
    const sourceBefore = state.snapshot().data_plane.versions[0];
    const mutation = await expectSuccess(state.callTool(
      AUTH.tenant_a_owner,
      "simulate_identity_bound_mutation",
      mutationArguments({
        sourceVersionId: "synthetic_version_1",
        authorizationEventId: event.authorization_event_id,
        arguments: args,
      }),
    ));

    expect(mutation.receipt.source_version_id).toBe("synthetic_version_1");
    expect(mutation.receipt.output_version_id).toBe("synthetic_version_2");
    const versions = state.snapshot().data_plane.versions;
    expect(versions).toHaveLength(2);
    expect(versions.find(version =>
      version.version_id === "synthetic_version_1"
    )).toEqual(sourceBefore);
    expect(versions.find(version =>
      version.version_id === "synthetic_version_2"
    )?.parent_version_id).toBe("synthetic_version_1");
  });

  it("skips a future collision with an older immutable source version", async () => {
    const state = createState();
    await prepareDocument(state, { sourceVersionId: "synthetic_version_2" });
    const immutableSource = state.snapshot().data_plane.versions[0];
    const firstArgs = { operation: 1 };
    const firstEvent = provisionMutation(state, { arguments: firstArgs });
    const first = await expectSuccess(state.callTool(
      AUTH.tenant_a_owner,
      "simulate_identity_bound_mutation",
      mutationArguments({
        sourceVersionId: "synthetic_version_2",
        authorizationEventId: firstEvent.authorization_event_id,
        idempotencyKey: "future_collision_1",
        arguments: firstArgs,
      }),
    ));
    expect(first.receipt.output_version_id).toBe("synthetic_version_1");

    const secondArgs = { operation: 2 };
    const secondEvent = provisionMutation(state, { arguments: secondArgs });
    const second = await expectSuccess(state.callTool(
      AUTH.tenant_a_owner,
      "simulate_identity_bound_mutation",
      mutationArguments({
        sourceVersionId: first.receipt.output_version_id,
        sourceByteLength: first.receipt.output_byte_length,
        sourceSha256: first.receipt.output_sha256,
        authorizationEventId: secondEvent.authorization_event_id,
        idempotencyKey: "future_collision_2",
        arguments: secondArgs,
      }),
    ));

    expect(second.receipt.output_version_id).toBe("synthetic_version_3");
    expect(second.receipt.output_version_id)
      .not.toBe(second.receipt.source_version_id);
    const versions = state.snapshot().data_plane.versions;
    expect(versions).toHaveLength(3);
    expect(versions.find(version =>
      version.version_id === "synthetic_version_2"
    )).toEqual(immutableSource);
    expect(versions.find(version =>
      version.version_id === "synthetic_version_3"
    )?.parent_version_id).toBe("synthetic_version_1");
  });

  it("scopes identical idempotency keys independently by tenant and actor", async () => {
    const state = createState();
    await prepareDocument(state, {
      context: AUTH.tenant_a_owner,
      authContextId: "tenant_a_owner",
      workspaceId: "shared_workspace",
      documentId: "shared_document",
    });
    await prepareDocument(state, {
      context: AUTH.tenant_a_collaborator,
      authContextId: "tenant_a_collaborator",
      workspaceId: "shared_workspace",
      documentId: "actor_document",
    });
    await prepareDocument(state, {
      context: AUTH.tenant_b_same_actor,
      authContextId: "tenant_b_same_actor",
      workspaceId: "shared_workspace",
      documentId: "shared_document",
    });
    const args = { tenant_scope: true };
    const ownerEvent = provisionMutation(state, {
      authContextId: "tenant_a_owner",
      workspaceId: "shared_workspace",
      documentId: "shared_document",
      arguments: args,
    });
    const collaboratorEvent = provisionMutation(state, {
      authContextId: "tenant_a_collaborator",
      workspaceId: "shared_workspace",
      documentId: "actor_document",
      arguments: args,
    });
    const otherTenantEvent = provisionMutation(state, {
      authContextId: "tenant_b_same_actor",
      workspaceId: "shared_workspace",
      documentId: "shared_document",
      arguments: args,
    });
    const request = (event, documentId) => mutationArguments({
      workspaceId: "shared_workspace",
      documentId,
      authorizationEventId: event.authorization_event_id,
      idempotencyKey: "same_key",
      arguments: args,
    });
    const [ownerResult, collaboratorResult, otherTenantResult] =
      await Promise.all([
      expectSuccess(state.callTool(
        AUTH.tenant_a_owner,
        "simulate_identity_bound_mutation",
        request(ownerEvent, "shared_document"),
      )),
      expectSuccess(state.callTool(
        AUTH.tenant_a_collaborator,
        "simulate_identity_bound_mutation",
        request(collaboratorEvent, "actor_document"),
      )),
      expectSuccess(state.callTool(
        AUTH.tenant_b_same_actor,
        "simulate_identity_bound_mutation",
        request(otherTenantEvent, "shared_document"),
      )),
    ]);
    expect(ownerResult.receipt).toMatchObject({
      tenant_id: "synthetic_tenant_a",
      verified_actor_id: "synthetic_actor_a",
      document_id: "shared_document",
    });
    expect(collaboratorResult.receipt).toMatchObject({
      tenant_id: "synthetic_tenant_a",
      verified_actor_id: "synthetic_actor_b",
      document_id: "actor_document",
    });
    expect(otherTenantResult.receipt).toMatchObject({
      tenant_id: "synthetic_tenant_b",
      verified_actor_id: "synthetic_actor_a",
      document_id: "shared_document",
    });
    expect(new Set([
      ownerResult.operation.operation_id,
      collaboratorResult.operation.operation_id,
      otherTenantResult.operation.operation_id,
    ]).size).toBe(3);
    expect(state.snapshot().data_plane.effects).toBe(3);
  });

  it("rejects forced-overlap same-key different-request contenders without effect", async () => {
    let release;
    let entered;
    const enteredPromise = new Promise(resolve => {
      entered = resolve;
    });
    const releasePromise = new Promise(resolve => {
      release = resolve;
    });
    const state = createState({
      beforeActivation: async () => {
        entered();
        await releasePromise;
      },
    });
    await prepareDocument(state);
    const firstArgs = { winner: true };
    const contenderArgs = { winner: false };
    const firstEvent = provisionMutation(state, { arguments: firstArgs });
    const contenderEvent = provisionMutation(state, {
      arguments: contenderArgs,
    });
    const first = state.callTool(
      AUTH.tenant_a_owner,
      "simulate_identity_bound_mutation",
      mutationArguments({
        authorizationEventId: firstEvent.authorization_event_id,
        idempotencyKey: "contested_key",
        arguments: firstArgs,
      }),
    );
    await enteredPromise;
    const contenders = await Promise.all(Array.from({ length: 16 }, () =>
      state.callTool(
        AUTH.tenant_a_owner,
        "simulate_identity_bound_mutation",
        mutationArguments({
          authorizationEventId: contenderEvent.authorization_event_id,
          idempotencyKey: "contested_key",
          arguments: contenderArgs,
        }),
      )
    ));
    expect(contenders.every(result =>
      !result.ok && result.code === "IDEMPOTENCY_CONFLICT"
    )).toBe(true);
    release();
    await expectSuccess(first);
    const snapshot = state.snapshot();
    expect(snapshot.data_plane.effects).toBe(1);
    expect(snapshot.data_plane.receipts).toHaveLength(1);
    expect(
      snapshot.evidence_plane.authorization_events.find(event =>
        event.authorization_event_id ===
          contenderEvent.authorization_event_id
      ).consumed_at,
    ).toBeNull();
  });

  it("allows one winner when different keys race the same event or current source", async () => {
    for (const raceSameEvent of [true, false]) {
      let release;
      let entered;
      const enteredPromise = new Promise(resolve => {
        entered = resolve;
      });
      const releasePromise = new Promise(resolve => {
        release = resolve;
      });
      const state = createState({
        beforeActivation: async () => {
          entered();
          await releasePromise;
        },
      });
      await prepareDocument(state);
      const args = { race: raceSameEvent ? "event" : "source" };
      const event1 = provisionMutation(state, { arguments: args });
      const event2 = raceSameEvent
        ? event1
        : provisionMutation(state, { arguments: args });
      const first = state.callTool(
        AUTH.tenant_a_owner,
        "simulate_identity_bound_mutation",
        mutationArguments({
          authorizationEventId: event1.authorization_event_id,
          idempotencyKey: "race_key_1",
          arguments: args,
        }),
      );
      await enteredPromise;
      const loser = await state.callTool(
        AUTH.tenant_a_owner,
        "simulate_identity_bound_mutation",
        mutationArguments({
          authorizationEventId: event2.authorization_event_id,
          idempotencyKey: "race_key_2",
          arguments: args,
        }),
      );
      expect(loser).toMatchObject({
        ok: false,
        code: "AUTHORIZATION_OR_IDENTITY_FAILED",
      });
      release();
      await expectSuccess(first);
      const snapshot = state.snapshot();
      expect(snapshot.data_plane.effects).toBe(1);
      expect(snapshot.data_plane.versions).toHaveLength(2);
      expect(snapshot.data_plane.receipts).toHaveLength(1);
      expect(snapshot.evidence_plane.control_state.event_reservations)
        .toEqual([]);
      expect(snapshot.evidence_plane.control_state.source_reservations)
        .toEqual([]);
      if (!raceSameEvent) {
        expect(
          snapshot.evidence_plane.authorization_events.find(event =>
            event.authorization_event_id === event2.authorization_event_id
          ).consumed_at,
        ).toBeNull();
      }
    }
  });

  it("returns the prior result for a same request with a new event without consuming it", async () => {
    const state = createState();
    await prepareDocument(state);
    const args = { replay: true };
    const firstEvent = provisionMutation(state, { arguments: args });
    const first = await expectSuccess(state.callTool(
      AUTH.tenant_a_owner,
      "simulate_identity_bound_mutation",
      mutationArguments({
        authorizationEventId: firstEvent.authorization_event_id,
        arguments: args,
      }),
    ));
    const secondEvent = provisionMutation(state, {
      arguments: args,
    });
    const replay = await expectSuccess(state.callTool(
      AUTH.tenant_a_owner,
      "simulate_identity_bound_mutation",
      mutationArguments({
        authorizationEventId: secondEvent.authorization_event_id,
        arguments: args,
      }),
    ));
    expect(replay.replayed).toBe(true);
    expect(replay.receipt).toEqual(first.receipt);
    const secondStored = state.snapshot().evidence_plane.authorization_events
      .find(event =>
        event.authorization_event_id === secondEvent.authorization_event_id
      );
    expect(secondStored.consumed_at).toBeNull();
    expect(state.snapshot().data_plane.effects).toBe(1);
  });

  it("rejects a stale existing source without consuming its fresh approval", async () => {
    const state = createState();
    await prepareDocument(state);
    const args = { stale_source: false };
    const winningEvent = provisionMutation(state, { arguments: args });
    const staleEvent = provisionMutation(state, { arguments: args });
    await expectSuccess(state.callTool(
      AUTH.tenant_a_owner,
      "simulate_identity_bound_mutation",
      mutationArguments({
        authorizationEventId: winningEvent.authorization_event_id,
        idempotencyKey: "advance_current_source",
        arguments: args,
      }),
    ));
    const beforeStaleAttempt = state.snapshot();
    await expectFailure(
      state.callTool(
        AUTH.tenant_a_owner,
        "simulate_identity_bound_mutation",
        mutationArguments({
          authorizationEventId: staleEvent.authorization_event_id,
          idempotencyKey: "stale_existing_source",
          arguments: args,
        }),
      ),
      "AUTHORIZATION_OR_IDENTITY_FAILED",
    );
    expect(state.snapshot()).toEqual(beforeStaleAttempt);
    expect(
      state.snapshot().evidence_plane.authorization_events.find(event =>
        event.authorization_event_id === staleEvent.authorization_event_id
      ).consumed_at,
    ).toBeNull();
    expect(state.snapshot().data_plane.versions).toHaveLength(2);
  });

  it("separates failed running evidence from an unchanged data plane", async () => {
    const state = createState({
      beforeActivation: async () => {
        throw new Error("injected failure");
      },
    });
    await prepareDocument(state);
    const args = { fail: true };
    const event = provisionMutation(state, { arguments: args });
    const before = state.snapshot();
    const firstFailure = await expectFailure(
      state.callTool(
        AUTH.tenant_a_owner,
        "simulate_identity_bound_mutation",
        mutationArguments({
          authorizationEventId: event.authorization_event_id,
          arguments: args,
        }),
      ),
      "SYNTHETIC_EFFECT_FAILED",
    );
    const after = state.snapshot();
    expect(after.data_plane).toEqual(before.data_plane);
    expect(after.evidence_plane.operations).toHaveLength(1);
    expect(after.evidence_plane.operations[0]).toMatchObject({
      status: "failed",
      output_version_id: null,
    });
    expect(after.evidence_plane.authorization_events.at(-1).consumed_at)
      .not.toBeNull();
    expect(after.evidence_plane.control_state.event_reservations).toEqual([]);
    expect(after.evidence_plane.control_state.source_reservations).toEqual([]);
    expect(after.evidence_plane.control_state.idempotency_reservations)
      .toHaveLength(1);
    expect(
      after.evidence_plane.control_state.idempotency_reservations[0]
        .terminal_error,
    ).toMatchObject({ code: "SYNTHETIC_EFFECT_FAILED" });

    const retry = await expectFailure(
      state.callTool(
        AUTH.tenant_a_owner,
        "simulate_identity_bound_mutation",
        mutationArguments({
          authorizationEventId: event.authorization_event_id,
          arguments: args,
        }),
      ),
      "SYNTHETIC_EFFECT_FAILED",
    );
    expect(firstFailure.details).toMatchObject({
      replayed: false,
      receipt: null,
      operation: { status: "failed" },
    });
    expect(retry.details).toEqual({
      ...firstFailure.details,
      replayed: true,
    });
    expect(state.snapshot().data_plane).toEqual(before.data_plane);
    const deletion = await expectSuccess(state.callTool(
      AUTH.tenant_a_owner,
      "simulate_delete_lifecycle",
      {
        workspace_id: "workspace_a",
        document_id: "document_a",
        next_state: "tombstoned",
        policy_version: STATE_CONTRACT.policy_version,
      },
    ));
    expect(deletion.document.lifecycle_state).toBe("tombstoned");
  });

  it("rechecks current authority before activation and preserves the terminal denial on retry", async () => {
    let release;
    let entered;
    const enteredPromise = new Promise(resolve => {
      entered = resolve;
    });
    const releasePromise = new Promise(resolve => {
      release = resolve;
    });
    const state = createState({
      beforeActivation: async () => {
        entered();
        await releasePromise;
      },
    });
    await prepareDocument(state);
    const args = { revoke_before_activation: true };
    const event = provisionMutation(state, { arguments: args });
    const before = state.snapshot();
    const running = state.callTool(
      AUTH.tenant_a_owner,
      "simulate_identity_bound_mutation",
      mutationArguments({
        authorizationEventId: event.authorization_event_id,
        arguments: args,
      }),
    );
    await enteredPromise;
    state.trustedFixtureSetup.revokeSyntheticMembership({
      authContextId: "tenant_a_owner",
    });
    release();
    const denied = await expectFailure(
      running,
      "AUTHORITY_REVOKED_BEFORE_ACTIVATION",
    );
    expect(denied.httpStatus).toBe(200);
    const after = state.snapshot();
    expect(after.data_plane).toEqual(before.data_plane);
    expect(after.evidence_plane.operations).toHaveLength(1);
    expect(after.evidence_plane.operations[0].status).toBe("failed");
    expect(after.evidence_plane.authorization_events.at(-1).consumed_at)
      .not.toBeNull();

    await expectFailure(
      state.callTool(
        AUTH.tenant_a_owner,
        "simulate_identity_bound_mutation",
        mutationArguments({
          authorizationEventId: event.authorization_event_id,
          arguments: args,
        }),
      ),
      "INSUFFICIENT_SCOPE",
    );
    expect(state.snapshot().data_plane).toEqual(before.data_plane);
  });

  it("serializes a running mutation against deletion in both legal orders", async () => {
    let release;
    let entered;
    const enteredPromise = new Promise(resolve => {
      entered = resolve;
    });
    const releasePromise = new Promise(resolve => {
      release = resolve;
    });
    const state = createState({
      beforeActivation: async () => {
        entered();
        await releasePromise;
      },
    });
    await prepareDocument(state);
    const args = { race_delete: true };
    const event = provisionMutation(state, { arguments: args });
    const running = state.callTool(
      AUTH.tenant_a_owner,
      "simulate_identity_bound_mutation",
      mutationArguments({
        authorizationEventId: event.authorization_event_id,
        arguments: args,
      }),
    );
    await enteredPromise;
    const deleteRequest = {
      workspace_id: "workspace_a",
      document_id: "document_a",
      next_state: "tombstoned",
      policy_version: STATE_CONTRACT.policy_version,
    };
    const beforeDeniedDelete = state.snapshot();
    await expectFailure(
      state.callTool(
        AUTH.tenant_a_owner,
        "simulate_delete_lifecycle",
        deleteRequest,
      ),
      "AUTHORIZATION_OR_IDENTITY_FAILED",
    );
    expect(state.snapshot()).toEqual(beforeDeniedDelete);
    release();
    await expectSuccess(running);
    await expectSuccess(state.callTool(
      AUTH.tenant_a_owner,
      "simulate_delete_lifecycle",
      deleteRequest,
    ));

    const deletionFirst = createState();
    await prepareDocument(deletionFirst);
    const laterArgs = { deletion_first: true };
    const laterEvent = provisionMutation(deletionFirst, {
      arguments: laterArgs,
    });
    await expectSuccess(deletionFirst.callTool(
      AUTH.tenant_a_owner,
      "simulate_delete_lifecycle",
      deleteRequest,
    ));
    const afterDelete = deletionFirst.snapshot();
    await expectFailure(
      deletionFirst.callTool(
        AUTH.tenant_a_owner,
        "simulate_identity_bound_mutation",
        mutationArguments({
          authorizationEventId: laterEvent.authorization_event_id,
          arguments: laterArgs,
        }),
      ),
      "AUTHORIZATION_OR_IDENTITY_FAILED",
    );
    expect(deletionFirst.snapshot()).toEqual(afterDelete);
  });

  it("does not leak receipts cross-tenant, cross-actor, or to revoked and wrong-object callers", async () => {
    const state = createState();
    await prepareDocument(state);
    const args = { receipt: true };
    const event = provisionMutation(state, { arguments: args });
    const completed = await expectSuccess(state.callTool(
      AUTH.tenant_a_owner,
      "simulate_identity_bound_mutation",
      mutationArguments({
        authorizationEventId: event.authorization_event_id,
        arguments: args,
      }),
    ));
    const exact = {
      workspace_id: "workspace_a",
      document_id: "document_a",
      operation_id: completed.operation.operation_id,
    };
    const read = await expectSuccess(state.callTool(
      AUTH.tenant_a_owner,
      "read_operation_receipt",
      exact,
    ));
    expect(read.receipt).toEqual(completed.receipt);
    for (const [context, request, code] of [
      [AUTH.tenant_b_owner, exact, "AUTHORIZATION_OR_IDENTITY_FAILED"],
      [
        AUTH.tenant_a_collaborator,
        exact,
        "AUTHORIZATION_OR_IDENTITY_FAILED",
      ],
      [AUTH.tenant_a_revoked, exact, "INSUFFICIENT_SCOPE"],
      [
        AUTH.tenant_a_owner,
        { ...exact, document_id: "document_b" },
        "AUTHORIZATION_OR_IDENTITY_FAILED",
      ],
    ]) {
      await expectFailure(
        state.callTool(context, "read_operation_receipt", request),
        code,
      );
    }
  });

  it("enforces distinct terminal delete states and trusted purge inventory", async () => {
    const state = createState();
    await prepareDocument(state);
    const transition = next_state => state.callTool(
      AUTH.tenant_a_owner,
      "simulate_delete_lifecycle",
      {
        workspace_id: "workspace_a",
        document_id: "document_a",
        next_state,
        policy_version: STATE_CONTRACT.policy_version,
      },
    );
    await expectFailure(
      transition("physically_purged"),
      "AUTHORIZATION_OR_IDENTITY_FAILED",
    );
    await expectSuccess(transition("tombstoned"));
    await expectSuccess(transition("purge_pending"));
    const beforeFinal = state.snapshot();
    await expectFailure(
      transition("physically_purged"),
      "AUTHORIZATION_OR_IDENTITY_FAILED",
    );
    expect(state.snapshot()).toEqual(beforeFinal);
    state.trustedFixtureSetup.attestLifecycleInventoryComplete({
      authContextId: "tenant_a_owner",
      workspaceId: "workspace_a",
      documentId: "document_a",
    });
    await expectSuccess(transition("physically_purged"));
    await expectFailure(
      transition("tombstoned"),
      "AUTHORIZATION_OR_IDENTITY_FAILED",
    );
    expect(
      state.snapshot().data_plane.lifecycle_events.map(event => [
        event.prior_state,
        event.next_state,
      ]),
    ).toEqual([
      ["active", "tombstoned"],
      ["tombstoned", "purge_pending"],
      ["purge_pending", "physically_purged"],
    ]);
  });

  it("authorizes receipt reads by lifecycle state but denies mutation cache replay after deletion", async () => {
    const state = createState();
    await prepareDocument(state);
    const args = { lifecycle_replay: false };
    const event = provisionMutation(state, { arguments: args });
    const request = mutationArguments({
      authorizationEventId: event.authorization_event_id,
      arguments: args,
    });
    const completed = await expectSuccess(state.callTool(
      AUTH.tenant_a_owner,
      "simulate_identity_bound_mutation",
      request,
    ));
    const receiptRequest = {
      workspace_id: "workspace_a",
      document_id: "document_a",
      operation_id: completed.operation.operation_id,
    };
    const transition = next_state => state.callTool(
      AUTH.tenant_a_owner,
      "simulate_delete_lifecycle",
      {
        workspace_id: "workspace_a",
        document_id: "document_a",
        next_state,
        policy_version: STATE_CONTRACT.policy_version,
      },
    );
    await expectSuccess(transition("tombstoned"));
    const tombstoned = state.snapshot();
    await expectFailure(
      state.callTool(
        AUTH.tenant_a_owner,
        "simulate_identity_bound_mutation",
        request,
      ),
      "AUTHORIZATION_OR_IDENTITY_FAILED",
    );
    expect(state.snapshot()).toEqual(tombstoned);
    await expectSuccess(state.callTool(
      AUTH.tenant_a_owner,
      "read_operation_receipt",
      receiptRequest,
    ));

    await expectSuccess(transition("purge_pending"));
    await expectSuccess(state.callTool(
      AUTH.tenant_a_owner,
      "read_operation_receipt",
      receiptRequest,
    ));
    state.trustedFixtureSetup.attestLifecycleInventoryComplete({
      authContextId: "tenant_a_owner",
      workspaceId: "workspace_a",
      documentId: "document_a",
    });
    await expectSuccess(transition("physically_purged"));
    await expectFailure(
      state.callTool(
        AUTH.tenant_a_owner,
        "read_operation_receipt",
        receiptRequest,
      ),
      "AUTHORIZATION_OR_IDENTITY_FAILED",
    );
  });

  it("treats authorization expiry as denial, not deletion", async () => {
    const state = createState();
    await prepareDocument(state);
    const args = { expired: true };
    const event = provisionMutation(state, {
      arguments: args,
      expiresInMs: -1,
    });
    const before = state.snapshot();
    await expectFailure(
      state.callTool(
        AUTH.tenant_a_owner,
        "simulate_identity_bound_mutation",
        mutationArguments({
          authorizationEventId: event.authorization_event_id,
          arguments: args,
        }),
      ),
      "AUTHORIZATION_OR_IDENTITY_FAILED",
    );
    expect(state.snapshot()).toEqual(before);
    expect(
      state.snapshot().data_plane.documents[0].lifecycle_state,
    ).toBe("active");
  });

  it("enforces deterministic JSON-domain and record-count ceilings", async () => {
    const state = createState();
    for (let index = 0; index < 256; index += 1) {
      await expectSuccess(state.callTool(
        AUTH.tenant_a_owner,
        "create_synthetic_workspace",
        { workspace_id: `workspace_${index}` },
      ));
    }
    const beforeCapacityFailure = state.snapshot();
    await expectFailure(
      state.callTool(AUTH.tenant_a_owner, "create_synthetic_workspace", {
        workspace_id: "workspace_over_capacity",
      }),
      "SYNTHETIC_CAPACITY_EXCEEDED",
    );
    expect(state.snapshot()).toEqual(beforeCapacityFailure);

    const mutationState = createState();
    await prepareDocument(mutationState);
    const ordinary = { bounded: true };
    const event = provisionMutation(mutationState, { arguments: ordinary });
    const base = mutationArguments({
      authorizationEventId: event.authorization_event_id,
      arguments: ordinary,
    });
    let tooDeep = "leaf";
    for (let depth = 0; depth < 10; depth += 1) tooDeep = { nested: tooDeep };
    const hostileArguments = [
      null,
      "schema-invalid",
      ["schema-invalid"],
      tooDeep,
      Array.from({ length: 129 }, (_, index) => index),
      Object.fromEntries(Array.from(
        { length: 129 },
        (_, index) => [`key_${index}`, index],
      )),
      JSON.parse('{"__proto__":{"polluted":true}}'),
    ];
    for (const args of hostileArguments) {
      const before = mutationState.snapshot();
      await expectFailure(
        mutationState.callTool(
          AUTH.tenant_a_owner,
          "simulate_identity_bound_mutation",
          { ...base, arguments: args },
        ),
        "INVALID_ARGUMENTS",
      );
      expect(mutationState.snapshot()).toEqual(before);
    }

    for (const args of [null, "schema-invalid", ["schema-invalid"]]) {
      expect(() => provisionMutation(mutationState, { arguments: args }))
        .toThrow();
    }

    const nestedState = createState();
    await prepareDocument(nestedState);
    const exactNested = { nested: { value: "é".repeat(256) } };
    const exactNestedEvent = provisionMutation(nestedState, {
      arguments: exactNested,
    });
    expect(exactNestedEvent.authorization_event_id).toMatch(
      /^synthetic_authorization_/,
    );
    const overlongNested = { nested: { value: `${"é".repeat(256)}x` } };
    const beforeOverlongProvision = nestedState.snapshot();
    expect(() => provisionMutation(nestedState, {
      arguments: overlongNested,
    })).toThrow();
    expect(nestedState.snapshot()).toEqual(beforeOverlongProvision);
    await expectFailure(
      nestedState.callTool(
        AUTH.tenant_a_owner,
        "simulate_identity_bound_mutation",
        mutationArguments({
          authorizationEventId:
            exactNestedEvent.authorization_event_id,
          arguments: overlongNested,
        }),
      ),
      "INVALID_ARGUMENTS",
    );
    expect(nestedState.snapshot()).toEqual(beforeOverlongProvision);

    const authorizationState = createState();
    for (let index = 0; index < 256; index += 1) {
      authorizationState.trustedFixtureSetup
        .provisionRegistrationAuthorization({
          authContextId: "tenant_a_owner",
          workspaceId: "workspace_a",
          documentId: "document_a",
          fixtureId: FIXTURE.id,
          sourceVersionId: `source_${index}`,
        });
    }
    const beforeAuthorizationCapacityFailure = authorizationState.snapshot();
    expect(() => authorizationState.trustedFixtureSetup
      .provisionRegistrationAuthorization({
        authContextId: "tenant_a_owner",
        workspaceId: "workspace_a",
        documentId: "document_a",
        fixtureId: FIXTURE.id,
        sourceVersionId: "source_over_capacity",
      })).toThrow("SYNTHETIC_CAPACITY_EXCEEDED");
    expect(authorizationState.snapshot())
      .toEqual(beforeAuthorizationCapacityFailure);
  });
});
