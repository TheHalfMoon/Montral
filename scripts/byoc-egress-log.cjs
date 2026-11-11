"use strict";
// Qualification-only preload for scripts/qualify-byoc.sh, never part of a deployment: loaded into the Montral server
// with NODE_OPTIONS="--require /qualify/byoc-egress-log.cjs", it records every outbound connection attempt the process
// makes, before the operating system is asked: TCP/TLS connects (net.Socket#connect carries http, https, fetch/undici,
// http2, SMTP and PostgreSQL), UDP sends, and DNS lookups and resolver queries. Each attempt becomes one stderr line
//   BYOC_EGRESS {"kind":"connect","host":"customer-db","port":5432}
// so the qualification can assert that nothing but the configured database (and loopback) was contacted. It changes
// no behaviour: every wrapped function is called with its original arguments and its result is returned unchanged.
const fs = require("node:fs");
const net = require("node:net");
const dgram = require("node:dgram");
const dns = require("node:dns");

function record(kind, detail) {
  try {
    fs.writeSync(2, `BYOC_EGRESS ${JSON.stringify({ kind, ...detail })}\n`);
  } catch {
    /* never let the probe break the process */
  }
}

// net.Socket#connect(options[, cb]) | (port[, host][, cb]) | (path[, cb]); net.connect passes a normalized [options, cb]
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (first && typeof first === "object") {
    if (!first.path) record("connect", { host: String(first.host ?? "localhost"), port: Number(first.port) });
  } else if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    record("connect", { host: typeof args[1] === "string" ? args[1] : "localhost", port: Number(first) });
  }
  return connect.apply(this, args);
};

const send = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function (...args) {
  // send(msg[, offset, length][, port][, address][, cb]): the address is the first string after the port
  const port = args.find((a, i) => i > 0 && typeof a === "number" && a > 0);
  const address = args.find((a, i) => i > 0 && typeof a === "string");
  record("udp", { host: String(address ?? "localhost"), port: Number(port) });
  return send.apply(this, args);
};

function wrapDns(target, label) {
  for (const key of Object.getOwnPropertyNames(target)) {
    if (!/^(lookup|resolve)/.test(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor || typeof descriptor.value !== "function" || !descriptor.writable) continue;
    const original = descriptor.value;
    target[key] = function (name, ...rest) {
      record("dns", { fn: `${label}.${key}`, name: String(name) });
      return original.call(this, name, ...rest);
    };
  }
}
wrapDns(dns, "dns");
wrapDns(dns.Resolver.prototype, "dns.Resolver");
wrapDns(dns.promises, "dns.promises");
wrapDns(dns.promises.Resolver.prototype, "dns.promises.Resolver");
// ES module `import { lookup } from "node:dns"` sees the wrapped functions too
require("node:module").syncBuiltinESMExports();
