# Node reverse-proxy peer identity guard (engineering-only)

## Threat model
With TRUST_PROXY=true, the shared rate limiter parses the final X-Forwarded-For
entry. A directly reachable backend can receive an attacker-controlled
X-Forwarded-For header, regardless of correctly configured external proxies.
Header parsing alone cannot distinguish the actual proxy socket from an
untrusted direct connection.

## Change
Node now checks the real TCP remoteAddress against TRUST_PROXY_PEER_IPS: a
comma-separated list of exact addresses. It accepts no CIDRs or wildcards.
Any missing, invalid, or mismatched trust configuration discards forwarding
headers before passing the request to Hono/Astro. Authorization, quotas and
the separate Worker/Cloudflare edge logic remain unchanged; no fallback to a
client-chosen address. Common IPv4-mapped Node socket notation and IPv6
canonicalization are handled. Docker Compose passes through the explicit
configuration; the example documents that it is required when TRUST_PROXY
is enabled.

## Regression
Pure Node unit tests cover a direct spoofed request, trusted proxy forwarding,
mapped IPv4, canonical IPv6, missing/malformed/broad trust configurations,
the actual downstream clientIp() quota-key behavior, and a real loopback Node HTTP socket proving forged forwarding is scrubbed before application dispatch. All required hosted
app CI and source integrity workflows must pass on exact PR head before merge.

## Remaining release gates
This is defense in depth, not proof that a live reverse proxy correctly appends
the actual client TCP peer or that firewall rules prevent direct backend access.
Operators must pin the proxy's actual *socket* address as observed by Node;
dynamic proxy container IPs require a stable design. Never put public
client addresses in the allowlist. The proxy must append (not replace or trust)
the real outer client address as the final X-Forwarded-For entry.
The hosted ingress/abuse, identity, accessibility, external SMTP, cloud probes,
merchant onboarding, DR and explicit public-release gates all remain OPEN.
No publication, deployment, customer data, or paid services authorized.