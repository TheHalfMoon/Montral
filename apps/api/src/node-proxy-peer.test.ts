import { describe, expect, it } from "vitest";
import { scrubUntrustedForwarding, trustedNodeProxyPeer } from "./node-proxy-peer";
import { clientIp } from "./ratelimit";

const request = (remoteAddress: string | undefined, lastHop = "203.0.113.99") => ({
  socket: { remoteAddress },
  headers: {
    "x-forwarded-for": "198.51.100.10, " + lastHop,
    "x-real-ip": "198.51.100.10",
    forwarded: "for=198.51.100.10",
    "cf-connecting-ip": "198.51.100.10",
    "x-unrelated": "keep",
  } as Record<string, string>,
});

describe("Node proxy socket peer authorization", () => {
  const config = { TRUST_PROXY: "true", TRUST_PROXY_PEER_IPS: "127.0.0.1, 2001:db8::2" };

  it("refuses unlisted direct sockets and removes spoofed forwarding headers", () => {
    const req = request("203.0.113.5", "192.0.2.5");
    expect(scrubUntrustedForwarding(req, config)).toBe(false);
    for (const header of ["x-forwarded-for", "x-real-ip", "forwarded", "cf-connecting-ip"]) {
      expect(req.headers[header]).toBeUndefined();
    }
    expect(req.headers["x-unrelated"]).toBe("keep");
    expect(clientIp({ req: { header: (key: string) => req.headers[key] }, env: { TRUST_PROXY: "true" } } as never)).toBeNull();
  });

  it("preserves proxy-appended XFF only for a listed socket peer", () => {
    const req = request("127.0.0.1", "192.0.2.5");
    expect(scrubUntrustedForwarding(req, config)).toBe(true);
    expect(req.headers["x-forwarded-for"]).toBe("198.51.100.10, 192.0.2.5");
    expect(clientIp({ req: { header: (key: string) => req.headers[key] }, env: { TRUST_PROXY: "true" } } as never)).toBe("192.0.2.5");
  });

  it("canonicalizes common IPv4-mapped Node sockets and IPv6", () => {
    expect(trustedNodeProxyPeer("::ffff:127.0.0.1", config)).toBe(true);
    expect(trustedNodeProxyPeer("2001:0DB8:0:0:0:0:0:2", config)).toBe(true);
    expect(trustedNodeProxyPeer("2001:db8::3", config)).toBe(false);
  });

  it("fails closed with missing, malformed or broad proxy configuration", () => {
    for (const conf of [
      { TRUST_PROXY: "", TRUST_PROXY_PEER_IPS: "127.0.0.1" },
      { TRUST_PROXY: "true" },
      { TRUST_PROXY: "true", TRUST_PROXY_PEER_IPS: "127.0.0.0/8" },
      { TRUST_PROXY: "true", TRUST_PROXY_PEER_IPS: "127.0.0.1, garbage" },
      { TRUST_PROXY: "true", TRUST_PROXY_PEER_IPS: "127.0.0.1," },
      { TRUST_PROXY: "true", TRUST_PROXY_PEER_IPS: "127.0.0.1, 127.0.0.01" },
    ]) {
      const req = request("127.0.0.1");
      expect(trustedNodeProxyPeer("127.0.0.1", conf)).toBe(false);
      expect(scrubUntrustedForwarding(req, conf)).toBe(false);
      expect(req.headers["x-forwarded-for"]).toBeUndefined();
    }
    expect(trustedNodeProxyPeer(undefined, config)).toBe(false);
  });
});