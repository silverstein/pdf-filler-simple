import fs from "node:fs/promises";
import net from "node:net";

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function productRun() {
  const { startRemoteLoopbackMcpMock } = await import(
    "../../helpers/remote-loopback-mcp-mock.mjs"
  );
  const { requestMock } = await import(
    "../../helpers/remote-loopback-test-client.mjs"
  );
  const contract = JSON.parse(await fs.readFile(
    new URL(
      "../../../config/remote-hybrid-trust-boundary.v1.json",
      import.meta.url,
    ),
    "utf8",
  ));
  const mock = await startRemoteLoopbackMcpMock({ contract });
  globalThis.__PDF_LOOPBACK_SET_ALLOWED_PORT_ONCE(mock.port);
  try {
    const statuses = [];
    const requestMeta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": {
        name: "guarded-product-run",
        version: "1"
      },
      "io.modelcontextprotocol/clientCapabilities": {}
    };
    statuses.push((await requestMock(mock)).status);
    statuses.push((await requestMock(mock, {
      body: {
        jsonrpc: "2.0",
        id: "tools-list",
        method: "tools/list",
        params: { _meta: requestMeta }
      }
    })).status);
    const toolRequest = async (id, name, args) => requestMock(mock, {
      body: {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name,
          arguments: args,
          _meta: requestMeta
        }
      }
    });
    statuses.push((await toolRequest(
      "create",
      "create_synthetic_workspace",
      { workspace_id: "workspace_a" },
    )).status);
    const registration = mock.trustedFixtureSetup
      .provisionRegistrationAuthorization({
        authContextId: "tenant_a_owner",
        workspaceId: "workspace_a",
        documentId: "document_a",
        fixtureId: "comparison_base_v1",
        sourceVersionId: "source_v1",
      });
    const registered = await toolRequest(
      "register",
      "register_synthetic_document_identity",
      {
        workspace_id: "workspace_a",
        document_id: "document_a",
        fixture_id: "comparison_base_v1",
        source_version_id: "source_v1",
        authorization_event_id: registration.authorization_event_id,
      },
    );
    statuses.push(registered.status);
    const source =
      registered.body.result.structuredContent.source_version;
    const operationArguments = { guarded: true };
    const authorization = mock.trustedFixtureSetup
      .provisionMutationAuthorization({
        authContextId: "tenant_a_owner",
        workspaceId: "workspace_a",
        documentId: "document_a",
        arguments: operationArguments,
      });
    const mutation = await toolRequest(
      "mutation",
      "simulate_identity_bound_mutation",
      {
        workspace_id: "workspace_a",
        document_id: "document_a",
        source_version_id: source.version_id,
        source_byte_length: source.byte_length,
        source_sha256: source.sha256,
        tool_name: "synthetic_identity_mutator",
        tool_version: "1",
        arguments: operationArguments,
        destination_and_effects: "synthetic_output_version",
        authorization_event_id: authorization.authorization_event_id,
        policy_version: "synthetic-policy-v1",
        idempotency_key: "guarded_key",
      },
    );
    statuses.push(mutation.status);
    statuses.push((await toolRequest(
      "receipt",
      "read_operation_receipt",
      {
        workspace_id: "workspace_a",
        document_id: "document_a",
        operation_id:
          mutation.body.result.structuredContent.operation.operation_id,
      },
    )).status);
    for (const nextState of ["tombstoned", "purge_pending"]) {
      statuses.push((await toolRequest(
        `lifecycle-${nextState}`,
        "simulate_delete_lifecycle",
        {
          workspace_id: "workspace_a",
          document_id: "document_a",
          next_state: nextState,
          policy_version: "synthetic-policy-v1",
        },
      )).status);
    }
    mock.trustedFixtureSetup.attestLifecycleInventoryComplete({
      authContextId: "tenant_a_owner",
      workspaceId: "workspace_a",
      documentId: "document_a",
    });
    statuses.push((await toolRequest(
      "lifecycle-physically-purged",
      "simulate_delete_lifecycle",
      {
        workspace_id: "workspace_a",
        document_id: "document_a",
        next_state: "physically_purged",
        policy_version: "synthetic-policy-v1",
      },
    )).status);
    await new Promise(resolve => setImmediate(resolve));
    emit({
      mode: "product",
      statuses,
      telemetry: globalThis.__PDF_LOOPBACK_EGRESS_RECEIPT(),
    });
  } finally {
    await mock.close();
  }
}

async function calibrationRun() {
  const dgram = (await import("node:dgram")).default;
  const dns = (await import("node:dns")).default;
  const net = (await import("node:net")).default;
  const tls = (await import("node:tls")).default;
  const denials = [];
  for (const [name, attempt] of [
    ["socket", () => net.connect({ host: "192.0.2.1", port: 9 })],
    ["dns", () => dns.lookup("example.com", () => {})],
    ["dns_promise", () => dns.promises.lookup("example.com")],
    ["fetch", () => fetch("https://example.com")],
    ["tls", () => tls.connect({ host: "192.0.2.1", port: 443 })],
    ["datagram", () => {
      const socket = dgram.createSocket("udp4");
      try {
        socket.send(Buffer.from("x"), 9, "192.0.2.1");
      } finally {
        socket.close();
      }
    }],
    ["package_import", () => import("@modelcontextprotocol/server")],
    ["subprocess_escape", () => process.getBuiltinModule("node:child_process")
      .spawn("curl", ["https://example.com"], { stdio: "ignore" })],
    ["internal_binding_escape", () => process.binding("spawn_sync")],
  ]) {
    try {
      await attempt();
      denials.push({ name, denied: false });
    } catch (error) {
      denials.push({
        name,
        denied: error.code?.startsWith("PDF_LOOPBACK_GUARD_DENIED_") ?? false,
        code: error.code,
      });
    }
  }
  await new Promise(resolve => setImmediate(resolve));
  emit({
    mode: "calibration",
    denials,
    telemetry: globalThis.__PDF_LOOPBACK_EGRESS_RECEIPT(),
  });
}

async function socketAllowlistCalibrationRun() {
  const { startRemoteLoopbackMcpMock } = await import(
    "../../helpers/remote-loopback-mcp-mock.mjs"
  );
  const contract = JSON.parse(await fs.readFile(
    new URL(
      "../../../config/remote-hybrid-trust-boundary.v1.json",
      import.meta.url,
    ),
    "utf8",
  ));
  const mock = await startRemoteLoopbackMcpMock({ contract });
  globalThis.__PDF_LOOPBACK_SET_ALLOWED_PORT_ONCE(mock.port);
  const denials = [];
  try {
    for (const [name, options] of [
      ["wrong_host_exact_port", { host: "127.0.0.2", port: mock.port }],
      ["exact_host_wrong_port", {
        host: "127.0.0.1",
        port: mock.port === 65_535 ? mock.port - 1 : mock.port + 1,
      }],
    ]) {
      try {
        net.connect(options);
        denials.push({ name, denied: false });
      } catch (error) {
        denials.push({
          name,
          denied: error.code === "PDF_LOOPBACK_GUARD_DENIED_SOCKET",
          code: error.code,
        });
      }
    }
    await new Promise((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port: mock.port });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", reject);
    });
    emit({
      mode: "socket_allowlist_calibration",
      denials,
      exact_tuple_allowed: true,
      telemetry: globalThis.__PDF_LOOPBACK_EGRESS_RECEIPT(),
    });
  } finally {
    await mock.close();
  }
}

async function dynamicLoaderCalibrationRun() {
  const hiddenLoader = globalThis["ev" + "al"];
  const sentinelUrl = new URL(
    "./unreviewed-loader-sentinel.mjs",
    import.meta.url,
  ).href;
  const attempts = [
    {
      name: "indirect_eval_builtin",
      run: () => hiddenLoader(
        "import(\"node:\" + \"child_process\")",
      ),
    },
    {
      name: "function_constructor_builtin",
      run: () => (() => {}).constructor(
        "return import(\"node:\" + \"child_process\")",
      )(),
    },
    {
      name: "indirect_eval_file",
      run: () => hiddenLoader(
        `import(${JSON.stringify(sentinelUrl)})`,
      ),
    },
  ];
  const denials = [];
  for (const { name, run } of attempts) {
    try {
      await run();
      denials.push({ name, denied: false });
    } catch (error) {
      denials.push({
        name,
        denied: error.code === "PDF_LOOPBACK_GUARD_DENIED_MODULE_IMPORT",
        code: error.code,
      });
    }
  }
  await new Promise(resolve => setImmediate(resolve));
  emit({
    mode: "dynamic_loader_calibration",
    denials,
    telemetry: globalThis.__PDF_LOOPBACK_EGRESS_RECEIPT(),
  });
}

if (process.argv[2] === "product") {
  await productRun();
} else if (process.argv[2] === "calibration") {
  await calibrationRun();
} else if (process.argv[2] === "socket_allowlist_calibration") {
  await socketAllowlistCalibrationRun();
} else if (process.argv[2] === "dynamic_loader_calibration") {
  await dynamicLoaderCalibrationRun();
} else {
  throw new Error(
    "Expected a product or calibration mode",
  );
}
