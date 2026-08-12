import fs from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  REMOTE_LOOPBACK_HTTP_CONSTANTS as CONSTANTS,
  startRemoteLoopbackMcpMock,
} from "./helpers/remote-loopback-mcp-mock.mjs";
import {
  requestBody,
  requestMock,
} from "./helpers/remote-loopback-test-client.mjs";

const CONTRACT = JSON.parse(await fs.readFile(
  new URL("../config/remote-hybrid-trust-boundary.v1.json", import.meta.url),
  "utf8",
));

async function callTool(mock, name, args, {
  id = name,
  authContextId = "tenant_a_owner",
} = {}) {
  return requestMock(mock, {
    body: requestBody({
      id,
      method: "tools/call",
      name,
      arguments: args,
    }),
    headers: {
      Authorization: `Synthetic ${authContextId}`,
    },
  });
}

async function expectToolSuccess(request) {
  const response = await request;
  expect(response.status).toBe(200);
  expect(response.body.result).toMatchObject({
    resultType: "complete",
    isError: false,
  });
  return response.body.result.structuredContent;
}

async function expectToolFailure(request, code, status = 200) {
  const response = await request;
  expect(response.status).toBe(status);
  if (status === 200) {
    expect(response.body.result).toMatchObject({
      resultType: "complete",
      isError: true,
      structuredContent: { code },
    });
  } else {
    expect(response.body.error.data.stable_code).toBe(code);
  }
  return response;
}

async function prepareWireDocument(mock, {
  authContextId = "tenant_a_owner",
  workspaceId = "workspace_a",
  documentId = "document_a",
  sourceVersionId = "source_v1",
} = {}) {
  await expectToolSuccess(callTool(
    mock,
    "create_synthetic_workspace",
    { workspace_id: workspaceId },
    { authContextId },
  ));
  const registration = mock.trustedFixtureSetup
    .provisionRegistrationAuthorization({
      authContextId,
      workspaceId,
      documentId,
      fixtureId: "comparison_base_v1",
      sourceVersionId,
    });
  const registered = await expectToolSuccess(callTool(
    mock,
    "register_synthetic_document_identity",
    {
      workspace_id: workspaceId,
      document_id: documentId,
      fixture_id: "comparison_base_v1",
      source_version_id: sourceVersionId,
      authorization_event_id: registration.authorization_event_id,
    },
    { authContextId },
  ));
  return registered.source_version;
}

function mutationArgs({
  source,
  authorizationEventId,
  arguments: args,
  idempotencyKey = "wire_key_1",
  workspaceId = "workspace_a",
  documentId = "document_a",
}) {
  return {
    workspace_id: workspaceId,
    document_id: documentId,
    source_version_id: source.version_id,
    source_byte_length: source.byte_length,
    source_sha256: source.sha256,
    tool_name: CONSTANTS.state_contract.mutation_tool,
    tool_version: CONSTANTS.state_contract.mutation_tool_version,
    arguments: args,
    destination_and_effects:
      CONSTANTS.state_contract.mutation_destination,
    authorization_event_id: authorizationEventId,
    policy_version: CONSTANTS.state_contract.policy_version,
    idempotency_key: idempotencyKey,
  };
}

describe("remote loopback MCP mock wire state paths", () => {
  const mocks = new Set();

  async function start(options = {}) {
    const mock = await startRemoteLoopbackMcpMock({
      contract: CONTRACT,
      ...options,
    });
    mocks.add(mock);
    return mock;
  }

  afterEach(async () => {
    for (const mock of mocks) await mock.close();
    mocks.clear();
  });

  it("executes all five tools through HTTP and preserves identity through physical purge", async () => {
    const mock = await start();
    const source = await prepareWireDocument(mock);
    const operationArguments = { wire_vertical: true };
    const event = mock.trustedFixtureSetup.provisionMutationAuthorization({
      authContextId: "tenant_a_owner",
      workspaceId: "workspace_a",
      documentId: "document_a",
      arguments: operationArguments,
    });
    const mutation = await expectToolSuccess(callTool(
      mock,
      "simulate_identity_bound_mutation",
      mutationArgs({
        source,
        authorizationEventId: event.authorization_event_id,
        arguments: operationArguments,
      }),
    ));
    const read = await expectToolSuccess(callTool(
      mock,
      "read_operation_receipt",
      {
        workspace_id: "workspace_a",
        document_id: "document_a",
        operation_id: mutation.operation.operation_id,
      },
    ));
    expect(read.receipt).toEqual(mutation.receipt);

    for (const nextState of ["tombstoned", "purge_pending"]) {
      const transition = await expectToolSuccess(callTool(
        mock,
        "simulate_delete_lifecycle",
        {
          workspace_id: "workspace_a",
          document_id: "document_a",
          next_state: nextState,
          policy_version: CONSTANTS.state_contract.policy_version,
        },
      ));
      expect(transition.document.lifecycle_state).toBe(nextState);
    }
    mock.trustedFixtureSetup.attestLifecycleInventoryComplete({
      authContextId: "tenant_a_owner",
      workspaceId: "workspace_a",
      documentId: "document_a",
    });
    const purged = await expectToolSuccess(callTool(
      mock,
      "simulate_delete_lifecycle",
      {
        workspace_id: "workspace_a",
        document_id: "document_a",
        next_state: "physically_purged",
        policy_version: CONSTANTS.state_contract.policy_version,
      },
    ));
    expect(purged.document.lifecycle_state).toBe("physically_purged");
    await expectToolFailure(
      callTool(mock, "read_operation_receipt", {
        workspace_id: "workspace_a",
        document_id: "document_a",
        operation_id: mutation.operation.operation_id,
      }),
      "AUTHORIZATION_OR_IDENTITY_FAILED",
    );
  });

  it("never aliases or overwrites a caller-selected generated version ID", async () => {
    const mock = await start();
    const source = await prepareWireDocument(mock, {
      sourceVersionId: "synthetic_version_1",
    });
    const operationArguments = { preserve_source: true };
    const event = mock.trustedFixtureSetup.provisionMutationAuthorization({
      authContextId: "tenant_a_owner",
      workspaceId: "workspace_a",
      documentId: "document_a",
      arguments: operationArguments,
    });
    const mutation = await expectToolSuccess(callTool(
      mock,
      "simulate_identity_bound_mutation",
      mutationArgs({
        source,
        authorizationEventId: event.authorization_event_id,
        arguments: operationArguments,
      }),
    ));

    expect(mutation.receipt.source_version_id).toBe("synthetic_version_1");
    expect(mutation.receipt.output_version_id).toBe("synthetic_version_2");
    expect(mutation.receipt.output_version_id)
      .not.toBe(mutation.receipt.source_version_id);
    const versions = mock.snapshot().data_plane.versions;
    expect(versions).toHaveLength(2);
    expect(versions.find(version =>
      version.version_id === source.version_id
    )).toEqual(source);
    expect(versions.find(version =>
      version.version_id === mutation.receipt.output_version_id
    )?.parent_version_id).toBe(source.version_id);
  });

  it("fails every cross-tenant object path closed without changing either plane", async () => {
    const mock = await start();
    const source = await prepareWireDocument(mock);
    await expectToolSuccess(callTool(
      mock,
      "create_synthetic_workspace",
      { workspace_id: "workspace_a" },
      { authContextId: "tenant_b_owner" },
    ));
    const operationArguments = { cross_tenant: false };
    const event = mock.trustedFixtureSetup.provisionMutationAuthorization({
      authContextId: "tenant_a_owner",
      workspaceId: "workspace_a",
      documentId: "document_a",
      arguments: operationArguments,
    });
    const mutation = await expectToolSuccess(callTool(
      mock,
      "simulate_identity_bound_mutation",
      mutationArgs({
        source,
        authorizationEventId: event.authorization_event_id,
        arguments: operationArguments,
      }),
    ));
    const registration = mock.trustedFixtureSetup
      .provisionRegistrationAuthorization({
        authContextId: "tenant_a_owner",
        workspaceId: "workspace_a",
        documentId: "document_b",
        fixtureId: "comparison_base_v1",
        sourceVersionId: "source_v1",
      });
    const hostileCalls = [
      () => callTool(
        mock,
        "register_synthetic_document_identity",
        {
          workspace_id: "workspace_a",
          document_id: "document_b",
          fixture_id: "comparison_base_v1",
          source_version_id: "source_v1",
          authorization_event_id: registration.authorization_event_id,
        },
        { authContextId: "tenant_b_owner" },
      ),
      () => callTool(
        mock,
        "simulate_identity_bound_mutation",
        mutationArgs({
          source,
          authorizationEventId: event.authorization_event_id,
          arguments: operationArguments,
        }),
        { authContextId: "tenant_b_owner" },
      ),
      () => callTool(
        mock,
        "read_operation_receipt",
        {
          workspace_id: "workspace_a",
          document_id: "document_a",
          operation_id: mutation.operation.operation_id,
        },
        { authContextId: "tenant_b_owner" },
      ),
      () => callTool(
        mock,
        "read_operation_receipt",
        {
          workspace_id: "workspace_a",
          document_id: "document_a",
          operation_id: mutation.operation.operation_id,
        },
        { authContextId: "tenant_a_collaborator" },
      ),
      () => callTool(
        mock,
        "simulate_delete_lifecycle",
        {
          workspace_id: "workspace_a",
          document_id: "document_a",
          next_state: "tombstoned",
          policy_version: CONSTANTS.state_contract.policy_version,
        },
        { authContextId: "tenant_b_owner" },
      ),
    ];
    for (const hostileCall of hostileCalls) {
      const before = mock.snapshot();
      await expectToolFailure(
        hostileCall(),
        "AUTHORIZATION_OR_IDENTITY_FAILED",
      );
      const after = mock.snapshot();
      expect(after.data_plane).toEqual(before.data_plane);
      expect(after.evidence_plane).toEqual(before.evidence_plane);
    }
  });

  it("proves tenant and actor idempotency namespaces independently over HTTP", async () => {
    const mock = await start();
    const ownerSource = await prepareWireDocument(mock, {
      authContextId: "tenant_a_owner",
      workspaceId: "shared_workspace",
      documentId: "shared_document",
    });
    const collaboratorSource = await prepareWireDocument(mock, {
      authContextId: "tenant_a_collaborator",
      workspaceId: "shared_workspace",
      documentId: "actor_document",
    });
    const otherTenantSource = await prepareWireDocument(mock, {
      authContextId: "tenant_b_same_actor",
      workspaceId: "shared_workspace",
      documentId: "shared_document",
    });
    const operationArguments = { independent_scope: true };
    const cases = [
      {
        authContextId: "tenant_a_owner",
        source: ownerSource,
        documentId: "shared_document",
      },
      {
        authContextId: "tenant_a_collaborator",
        source: collaboratorSource,
        documentId: "actor_document",
      },
      {
        authContextId: "tenant_b_same_actor",
        source: otherTenantSource,
        documentId: "shared_document",
      },
    ];
    for (const row of cases) {
      row.event = mock.trustedFixtureSetup
        .provisionMutationAuthorization({
          authContextId: row.authContextId,
          workspaceId: "shared_workspace",
          documentId: row.documentId,
          arguments: operationArguments,
        });
    }
    const results = await Promise.all(cases.map((row, index) =>
      expectToolSuccess(callTool(
        mock,
        "simulate_identity_bound_mutation",
        mutationArgs({
          source: row.source,
          authorizationEventId: row.event.authorization_event_id,
          arguments: operationArguments,
          idempotencyKey: "independent_scope_key",
          workspaceId: "shared_workspace",
          documentId: row.documentId,
        }),
        {
          id: `independent_scope_${index}`,
          authContextId: row.authContextId,
        },
      ))
    ));
    expect(results.map(result => [
      result.receipt.tenant_id,
      result.receipt.verified_actor_id,
      result.receipt.document_id,
    ])).toEqual([
      [
        "synthetic_tenant_a",
        "synthetic_actor_a",
        "shared_document",
      ],
      [
        "synthetic_tenant_a",
        "synthetic_actor_b",
        "actor_document",
      ],
      [
        "synthetic_tenant_b",
        "synthetic_actor_a",
        "shared_document",
      ],
    ]);
    expect(new Set(results.map(result =>
      result.operation.operation_id
    )).size).toBe(3);
    expect(mock.snapshot().data_plane.effects).toBe(3);
  });

  it("forces real HTTP same-key overlap and returns one exact receipt", async () => {
    let release;
    let entered;
    const enteredPromise = new Promise(resolve => {
      entered = resolve;
    });
    const releasePromise = new Promise(resolve => {
      release = resolve;
    });
    let hookCalls = 0;
    const mock = await start({
      beforeActivation: async () => {
        hookCalls += 1;
        entered();
        await releasePromise;
      },
    });
    const source = await prepareWireDocument(mock);
    const operationArguments = { wire_concurrent: true };
    const event = mock.trustedFixtureSetup.provisionMutationAuthorization({
      authContextId: "tenant_a_owner",
      workspaceId: "workspace_a",
      documentId: "document_a",
      arguments: operationArguments,
    });
    const request = mutationArgs({
      source,
      authorizationEventId: event.authorization_event_id,
      arguments: operationArguments,
    });
    const first = callTool(
      mock,
      "simulate_identity_bound_mutation",
      request,
      { id: "first" },
    );
    await enteredPromise;
    const retries = Array.from({ length: 15 }, (_, index) =>
      callTool(
        mock,
        "simulate_identity_bound_mutation",
        request,
        { id: `retry_${index}` },
      )
    );
    release();
    const responses = await Promise.all([first, ...retries]);
    expect(responses.every(response =>
      response.status === 200 &&
      response.body.result.isError === false
    )).toBe(true);
    const results = responses.map(response =>
      response.body.result.structuredContent
    );
    expect(new Set(results.map(result =>
      result.operation.operation_id
    )).size).toBe(1);
    expect(new Set(results.map(result =>
      result.receipt.output_version_id
    )).size).toBe(1);
    expect(hookCalls).toBe(1);
    const snapshot = mock.snapshot();
    expect(snapshot.data_plane.effects).toBe(1);
    expect(snapshot.data_plane.receipts).toHaveLength(1);
    expect(snapshot.evidence_plane.operations).toHaveLength(1);
    expect(snapshot.evidence_plane.control_state.event_reservations)
      .toEqual([]);
    expect(snapshot.evidence_plane.control_state.source_reservations)
      .toEqual([]);
  });

  it("replays a running failure with the same wire error classification and operation", async () => {
    const mock = await start({
      beforeActivation: async () => {
        throw new Error("injected wire failure");
      },
    });
    const source = await prepareWireDocument(mock);
    const operationArguments = { wire_failure: true };
    const event = mock.trustedFixtureSetup.provisionMutationAuthorization({
      authContextId: "tenant_a_owner",
      workspaceId: "workspace_a",
      documentId: "document_a",
      arguments: operationArguments,
    });
    const request = mutationArgs({
      source,
      authorizationEventId: event.authorization_event_id,
      arguments: operationArguments,
    });
    const before = mock.snapshot();
    const first = await expectToolFailure(
      callTool(mock, "simulate_identity_bound_mutation", request),
      "SYNTHETIC_EFFECT_FAILED",
    );
    const afterFirst = mock.snapshot();
    expect(afterFirst.data_plane).toEqual(before.data_plane);
    const retry = await expectToolFailure(
      callTool(mock, "simulate_identity_bound_mutation", request),
      "SYNTHETIC_EFFECT_FAILED",
    );
    expect(retry.body.result.structuredContent).toEqual({
      ...first.body.result.structuredContent,
      replayed: true,
    });
    expect(mock.snapshot().data_plane).toEqual(before.data_plane);
    expect(mock.snapshot().evidence_plane).toEqual(afterFirst.evidence_plane);
  });
});
