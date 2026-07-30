let telemetryPort;

export function initialize({ port }) {
  telemetryPort = port;
}

const FIXTURE_DIRECTORY = new URL("./", import.meta.url);
const CHILD = new URL("no-egress-child.mjs", FIXTURE_DIRECTORY).href;
const HELPERS = new URL("../../helpers/", FIXTURE_DIRECTORY);
const MCP_MOCK = new URL("remote-loopback-mcp-mock.mjs", HELPERS).href;
const HTTP = new URL("remote-loopback-http.mjs", HELPERS).href;
const STATE = new URL("remote-loopback-state.mjs", HELPERS).href;
const CLIENT = new URL("remote-loopback-test-client.mjs", HELPERS).href;

const ALLOWED_EDGES = new Map([
  [CHILD, new Set([
    "node:fs/promises",
    "node:net",
    "node:dgram",
    "node:dns",
    "node:tls",
    "../../helpers/remote-loopback-mcp-mock.mjs",
    "../../helpers/remote-loopback-test-client.mjs",
  ])],
  [MCP_MOCK, new Set([
    "./remote-loopback-http.mjs",
    "./remote-loopback-state.mjs",
  ])],
  [HTTP, new Set([
    "node:fs/promises",
    "node:http",
    "./remote-loopback-state.mjs",
  ])],
  [STATE, new Set(["node:crypto"])],
  [CLIENT, new Set([
    "node:http",
    "node:net",
  ])],
]);

export async function resolve(specifier, context, nextResolve) {
  const allowed = ALLOWED_EDGES.get(context.parentURL)?.has(specifier) ??
    (
      context.parentURL === undefined &&
      (specifier === CHILD || specifier === new URL(CHILD).pathname)
    );
  if (allowed) {
    return nextResolve(specifier, context);
  }
  telemetryPort?.postMessage({
    type: "unreviewed_module_import_attempt",
    specifier,
    parent_url: context.parentURL ?? null,
    bare_package: !specifier.startsWith("node:") &&
      !specifier.startsWith("file:") &&
      !specifier.startsWith("./") &&
      !specifier.startsWith("../") &&
      !specifier.startsWith("/"),
  });
  const error = new Error("PDF_LOOPBACK_GUARD_DENIED_MODULE_IMPORT");
  error.code = "PDF_LOOPBACK_GUARD_DENIED_MODULE_IMPORT";
  throw error;
}
