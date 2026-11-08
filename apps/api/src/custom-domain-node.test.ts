import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DomainSite } from "./custom-domain";
import { routeCustomDomain, STATUS_DOMAIN_HEADER } from "./custom-domain-node";
import { scrubUntrustedForwarding } from "./node-proxy-peer";

/**
 * A real Node HTTP server wired like server.ts: scrub forwarding headers, drop the internal header, then let the
 * custom-domain router decide. The app, API, web build and assets are stand-ins that report what reached them.
 */
const sites: Record<string, DomainSite> = {
  "status.acme.example": { id: "0b7e4c1e-1111-4222-8333-944445555666", slug: "acme", visibility: "public", domain: "status.acme.example" },
  "locked.acme.example": { id: "1b7e4c1e-1111-4222-8333-944445555666", slug: "locked", visibility: "password", domain: "locked.acme.example" },
  "private.acme.example": { id: "2b7e4c1e-1111-4222-8333-944445555666", slug: "private", visibility: "members", domain: "private.acme.example" },
};
let trust: { TRUST_PROXY?: string; TRUST_PROXY_PEER_IPS?: string } = {};
let lookups: string[] = [];
let failLookup = false;

function reply(target: string) {
  return (req: { url?: string; headers: IncomingHttpHeaders }, res: import("node:http").ServerResponse) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ target, url: req.url, cookie: req.headers.cookie ?? null, authorization: req.headers.authorization ?? null, domain: req.headers[STATUS_DOMAIN_HEADER] ?? null }));
  };
}

let server: Server;
let port = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    const trustedPeer = scrubUntrustedForwarding(req, trust);
    delete req.headers[STATUS_DOMAIN_HEADER];
    void routeCustomDomain(req, res, {
      trustedPeer,
      ownHosts: new Set(["app.montral.example"]),
      lookup: async (host) => {
        lookups.push(host);
        if (failLookup) throw new Error("db down");
        return sites[host] ?? null; // only verified domains are ever returned (lookupCustomDomain's query)
      },
      api: reply("api"),
      page: reply("page"),
      asset: reply("asset"),
    }).then((handled) => { if (!handled) reply("app")(req, res); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { trust = {}; lookups = []; failLookup = false; });

type Answer = { status: number; headers: IncomingHttpHeaders; body: { target: string; url: string; cookie: string | null; authorization: string | null; domain: string | null } | string };
function call(path: string, headers: Record<string, string>, method = "GET"): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers, setHost: false }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let body: Answer["body"] = text;
        try { body = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode!, headers: res.headers, body });
      });
    });
    req.on("error", reject);
    req.end();
  });
}
const target = (a: Answer) => (typeof a.body === "string" ? `${a.status}` : a.body.target);

describe("custom domain routing over Node HTTP", () => {
  it("serves the verified page at the root and its feeds, with security headers", async () => {
    const page = await call("/?before=2026-01-01", { host: "status.acme.example" });
    expect(page.body).toMatchObject({ target: "page", url: "/status/acme?before=2026-01-01", domain: "status.acme.example" });
    expect(page.headers["content-security-policy"]).toContain("object-src 'none'");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    const rss = await call("/rss.xml", { host: "status.acme.example:443" });
    expect(rss.body).toMatchObject({ target: "api", url: "/api/public/status/acme/rss.xml" });
    expect((await call("/api/public/status/acme/incidents", { host: "status.acme.example" })).body).toMatchObject({ target: "api", url: "/api/public/status/acme/incidents" });
    expect((await call("/api/public/status/acme/subscribe", { host: "status.acme.example" }, "POST")).body).toMatchObject({ target: "api" });
    expect((await call("/_astro/page.abc.css", { host: "status.acme.example" })).body).toMatchObject({ target: "asset" });
  });

  it("404s the app, sign-in, private API and webhook receivers on the custom host", async () => {
    for (const path of ["/app", "/login", "/signup", "/docs", "/api/me", "/api/auth/sign-in/email", "/api/status-pages", "/api/hooks/x", "/hooks/x", "/status/acme", "/api/public/status/other"]) {
      for (const method of ["GET", "POST"]) {
        const res = await call(path, { host: "status.acme.example", cookie: "better-auth.session_token=s" }, method);
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(res.body, `${method} ${path}`).toBe("Not found");
        expect(res.headers["set-cookie"], `${method} ${path}`).toBeUndefined();
        expect(res.headers["cache-control"]).toBe("private, no-store");
      }
    }
  });

  it("never passes a session, Authorization or a client-supplied domain header through", async () => {
    const res = await call("/api/public/status/acme", {
      host: "status.acme.example",
      cookie: "better-auth.session_token=s; montral_sa_0b7e4c1e111142228333944445555666=grant; other=1",
      authorization: "Bearer montral_key",
      [STATUS_DOMAIN_HEADER]: "evil.example",
    });
    expect(res.body).toMatchObject({ target: "api", cookie: "montral_sa_0b7e4c1e111142228333944445555666=grant", authorization: null, domain: null });
    // on the main host a forged internal header never reaches the web build either
    const app = await call("/status/acme", { host: "app.montral.example", [STATUS_DOMAIN_HEADER]: "status.acme.example" });
    expect(app.body).toMatchObject({ target: "app", domain: null });
  });

  it("a domain that is not verified (no lookup hit) is not routed: the request is the app's", async () => {
    const res = await call("/login", { host: "pending.acme.example" });
    expect(target(res)).toBe("app");
    expect(lookups).toEqual(["pending.acme.example"]);
  });

  it("the app's own host, IP literals and localhost never touch the lookup", async () => {
    for (const host of ["app.montral.example", "127.0.0.1:8080", "localhost:8080", "[::1]:8080", "montral"]) {
      expect(target(await call("/health", { host })), host).toBe("app");
    }
    expect(lookups).toEqual([]);
  });

  it("ignores X-Forwarded-Host from an untrusted peer", async () => {
    const res = await call("/", { host: "app.montral.example", "x-forwarded-host": "status.acme.example" });
    expect(res.body).toMatchObject({ target: "app", url: "/" });
    // and the reverse: a forwarded app host cannot take a custom host back to the app
    const custom = await call("/login", { host: "status.acme.example", "x-forwarded-host": "app.montral.example" });
    expect(custom.status).toBe(404);
  });

  it("honours X-Forwarded-Host only from a configured trusted proxy", async () => {
    trust = { TRUST_PROXY: "true", TRUST_PROXY_PEER_IPS: "127.0.0.1" };
    const res = await call("/", { host: "127.0.0.1:8080", "x-forwarded-host": "status.acme.example" });
    expect(res.body).toMatchObject({ target: "page", url: "/status/acme" });
    trust = { TRUST_PROXY: "true", TRUST_PROXY_PEER_IPS: "10.0.0.9" };
    expect(target(await call("/", { host: "app.montral.example", "x-forwarded-host": "status.acme.example" }))).toBe("app");
  });

  it("a members-only page is 404 on its custom domain, even at the root", async () => {
    for (const path of ["/", "/rss.xml", "/api/public/status/private", "/_astro/x.js"]) {
      expect((await call(path, { host: "private.acme.example", cookie: "better-auth.session_token=s" })).status, path).toBe(404);
    }
  });

  it("a password page renders and accepts the unlock POST on its domain", async () => {
    expect((await call("/", { host: "locked.acme.example" })).body).toMatchObject({ target: "page", url: "/status/locked" });
    expect((await call("/api/public/status/_/unlock", { host: "locked.acme.example" }, "POST")).body).toMatchObject({ target: "api", url: "/api/public/status/_/unlock" });
    expect((await call("/api/public/status/_/unlock", { host: "status.acme.example" }, "POST")).status).toBe(404);
  });

  it("fails closed with 503 when the lookup is unavailable", async () => {
    failLookup = true;
    const res = await call("/login", { host: "status.acme.example" });
    expect(res.status).toBe(503);
    expect(target(await call("/login", { host: "app.montral.example" }))).toBe("app");
  });
});
