import dgram from "node:dgram";
import dns from "node:dns";
import { register } from "node:module";
import net from "node:net";
import tls from "node:tls";
import { MessageChannel } from "node:worker_threads";

const telemetry = {
  allowed_loopback_socket_attempts: 0,
  external_socket_attempts: 0,
  dns_attempts: 0,
  literal_loopback_lookup_shortcuts: 0,
  fetch_attempts: 0,
  tls_attempts: 0,
  datagram_attempts: 0,
  bare_package_import_attempts: 0,
  unreviewed_module_import_attempts: 0,
  builtin_module_retrieval_attempts: 0,
  subprocess_escape_attempts: 0,
  process_binding_attempts: 0,
};
let allowedPort = null;
let allowedPortSet = false;
Object.defineProperty(globalThis, "__PDF_LOOPBACK_SET_ALLOWED_PORT_ONCE", {
  value(port) {
    if (
      allowedPortSet ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535
    ) {
      throw new Error("PDF_LOOPBACK_ALLOWED_PORT_ALREADY_SET_OR_INVALID");
    }
    allowedPort = port;
    allowedPortSet = true;
  },
  configurable: false,
  enumerable: false,
  writable: false,
});
Object.defineProperty(globalThis, "__PDF_LOOPBACK_EGRESS_RECEIPT", {
  value() {
    return Object.freeze(structuredClone(telemetry));
  },
  configurable: false,
  enumerable: false,
  writable: false,
});

const { port1, port2 } = new MessageChannel();
port1.on("message", message => {
  if (message?.type === "unreviewed_module_import_attempt") {
    telemetry.unreviewed_module_import_attempts += 1;
    if (message.bare_package === true) {
      telemetry.bare_package_import_attempts += 1;
    }
  }
});
port1.unref();
register("./no-package-loader.mjs", import.meta.url, {
  data: { port: port2 },
  transferList: [port2],
});

function guardError(kind) {
  const error = new Error(`PDF_LOOPBACK_GUARD_DENIED_${kind}`);
  error.code = `PDF_LOOPBACK_GUARD_DENIED_${kind}`;
  return error;
}

Object.defineProperty(process, "getBuiltinModule", {
  value(specifier) {
    telemetry.builtin_module_retrieval_attempts += 1;
    if (
      specifier === "child_process" ||
      specifier === "node:child_process" ||
      specifier === "cluster" ||
      specifier === "node:cluster" ||
      specifier === "worker_threads" ||
      specifier === "node:worker_threads"
    ) {
      telemetry.subprocess_escape_attempts += 1;
    }
    throw guardError("BUILTIN_MODULE_RETRIEVAL");
  },
  configurable: false,
  enumerable: false,
  writable: false,
});
for (const name of ["binding", "_linkedBinding"]) {
  if (typeof process[name] === "function") {
    Object.defineProperty(process, name, {
      value() {
        telemetry.process_binding_attempts += 1;
        throw guardError("PROCESS_BINDING");
      },
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }
}

function connectTuple(args) {
  if (Array.isArray(args[0])) {
    return connectTuple(args[0]);
  }
  if (typeof args[0] === "object" && args[0] !== null) {
    return {
      host: args[0].host ?? args[0].hostname,
      port: Number(args[0].port),
    };
  }
  if (typeof args[0] === "number") {
    return {
      host: typeof args[1] === "string" ? args[1] : undefined,
      port: args[0],
    };
  }
  return { host: undefined, port: NaN };
}

const originalSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const tuple = connectTuple(args);
  if (
    tuple.host === "127.0.0.1" &&
    tuple.port === allowedPort
  ) {
    telemetry.allowed_loopback_socket_attempts += 1;
    return Reflect.apply(originalSocketConnect, this, args);
  }
  telemetry.external_socket_attempts += 1;
  throw guardError("SOCKET");
};

for (const name of [
  "lookup",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTxt",
  "reverse",
]) {
  if (typeof dns[name] === "function") {
    dns[name] = function guardedDns(...args) {
      if (name === "lookup" && args[0] === "127.0.0.1") {
        telemetry.literal_loopback_lookup_shortcuts += 1;
        const callback = args.findLast(value => typeof value === "function");
        const options = args.find(value =>
          value && typeof value === "object" && !Array.isArray(value)
        );
        queueMicrotask(() => {
          if (options?.all === true) {
            callback?.(null, [{ address: "127.0.0.1", family: 4 }]);
          } else {
            callback?.(null, "127.0.0.1", 4);
          }
        });
        return;
      }
      telemetry.dns_attempts += 1;
      throw guardError("DNS");
    };
  }
  if (typeof dns.promises[name] === "function") {
    dns.promises[name] = async function guardedPromiseDns(...args) {
      if (name === "lookup" && args[0] === "127.0.0.1") {
        telemetry.literal_loopback_lookup_shortcuts += 1;
        return { address: "127.0.0.1", family: 4 };
      }
      telemetry.dns_attempts += 1;
      throw guardError("DNS");
    };
  }
}

globalThis.fetch = async function guardedFetch() {
  telemetry.fetch_attempts += 1;
  throw guardError("FETCH");
};

tls.connect = function guardedTlsConnect() {
  telemetry.tls_attempts += 1;
  throw guardError("TLS");
};

for (const name of ["connect", "send"]) {
  dgram.Socket.prototype[name] = function guardedDatagram(...args) {
    telemetry.datagram_attempts += 1;
    if (typeof args.at(-1) === "function") {
      queueMicrotask(() => args.at(-1)(guardError("DATAGRAM")));
      return this;
    }
    throw guardError("DATAGRAM");
  };
}
