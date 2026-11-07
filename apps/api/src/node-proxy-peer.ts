import { isIP } from "node:net";
import type { IncomingHttpHeaders } from "node:http";

/** Trust only the exact socket address of an explicitly configured Node proxy. */
function canonicalPeer(raw: string | undefined): string | null {
  const address = raw?.trim();
  if (!address || address.length > 64 || address.includes("%")) return null;
  if (address.toLowerCase().startsWith("::ffff:") && isIP(address.slice(7)) === 4) return address.slice(7);
  if (isIP(address) === 4) return address;
  if (isIP(address) !== 6) return null;
  try {
    return new URL("http://[" + address + "]/").hostname.slice(1, -1);
  } catch {
    return null;
  }
}

export type NodeProxyTrust = { TRUST_PROXY?: string; TRUST_PROXY_PEER_IPS?: string };

export function trustedNodeProxyPeer(remoteAddress: string | undefined, config: NodeProxyTrust): boolean {
  if (!["true", "1"].includes(String(config.TRUST_PROXY ?? "").trim().toLowerCase())) return false;
  const remote = canonicalPeer(remoteAddress);
  if (!remote) return false;
  const raw = config.TRUST_PROXY_PEER_IPS?.trim();
  if (!raw || raw.length > 1024) return false;
  const entries = raw.split(",");
  // Refuse the whole configuration if any entry is invalid. Never accept CIDR/wildcards.
  if (entries.length > 16) return false;
  const peers = entries.map((entry) => canonicalPeer(entry));
  return peers.every((peer) => peer !== null) && peers.includes(remote);
}

/** Mutate normalized request headers before Node forwards to Hono or Astro. */
export function scrubUntrustedForwarding(
  request: { headers: IncomingHttpHeaders; socket: { remoteAddress?: string } },
  config: NodeProxyTrust,
): boolean {
  const trusted = trustedNodeProxyPeer(request.socket.remoteAddress, config);
  if (!trusted) {
    for (const name of ["x-forwarded-for", "x-real-ip", "forwarded", "cf-connecting-ip"]) {
      delete request.headers[name];
    }
  }
  return trusted;
}