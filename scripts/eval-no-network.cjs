"use strict";

// Loaded into the benchmark candidate with NODE_OPTIONS before application
// code. The gate exercises local extraction only; any network attempt is a
// harness violation, even when the candidate would otherwise have credentials.
const deny = () => {
  throw new Error("olmOCR-bench candidate network access is disabled");
};

globalThis.fetch = deny;
globalThis.WebSocket = class DisabledWebSocket {
  constructor() {
    deny();
  }
};

const net = require("node:net");
const tls = require("node:tls");
const dns = require("node:dns");
const dgram = require("node:dgram");
const http = require("node:http");
const https = require("node:https");

net.connect = deny;
net.createConnection = deny;
net.Socket.prototype.connect = deny;
tls.connect = deny;
dns.lookup = deny;
dns.resolve = deny;
dgram.createSocket = deny;
http.request = deny;
http.get = deny;
https.request = deny;
https.get = deny;
