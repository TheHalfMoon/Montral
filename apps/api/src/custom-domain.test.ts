import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appHosts, challengeName, customDomainCookies, customDomainOrigin, customDomainRoute, lookupCustomDomain, newDomainToken,
  purgeCustomDomains, routingHost, setTxtResolver, statusPageDomain, verifyDomainToken,
} from "./custom-domain";

const own = appHosts({ WEB_ORIGIN: "https://app.montral.example", BETTER_AUTH_URL: "https://auth.montral.example/api/auth" });

describe("statusPageDomain", () => {
  it("accepts and lowercases fully qualified hostnames", () => {
    expect(statusPageDomain("status.example.com", own)).toEqual({ domain: "status.example.com" });
    expect(statusPageDomain("  Status.Example.COM ", own)).toEqual({ domain: "status.example.com" });
    expect(statusPageDomain("a-b.c-d.example.co.uk", own)).toEqual({ domain: "a-b.c-d.example.co.uk" });
    expect(statusPageDomain("xn--bcher-kva.example", own)).toEqual({ domain: "xn--bcher-kva.example" });
  });

  it.each([
    ["", "empty"],
    ["localhost", "single label"],
    ["example", "single label"],
    ["status.example.com:8443", "port"],
    ["https://status.example.com", "scheme"],
    ["status.example.com/path", "path"],
    ["user@status.example.com", "userinfo"],
    ["*.example.com", "wildcard"],
    ["192.168.1.10", "IPv4"],
    ["10.0.0.1.", "IPv4 trailing dot"],
    ["[::1]", "IPv6"],
    ["::1", "IPv6 bare"],
    ["status.example.com.", "trailing dot"],
    ["-bad.example.com", "leading hyphen"],
    ["bad-.example.com", "trailing hyphen"],
    ["a..example.com", "empty label"],
    ["status example.com", "space"],
    ["status.localhost", "localhost"],
    ["bücher.example", "unicode (must be punycode)"],
    [`${"a".repeat(64)}.example.com`, "label over 63"],
    [`${"abcdefghi.".repeat(25)}example.com`, "over 253"],
    ["app.montral.example", "the app's own host"],
    ["auth.montral.example", "the auth host"],
    [42, "not a string"],
  ] as [unknown, string][])("refuses %s (%s)", (value) => {
    expect(statusPageDomain(value, own)).toHaveProperty("error");
  });

  it("collects the app's own hosts from WEB_ORIGIN and BETTER_AUTH_URL, ignoring junk", () => {
    expect([...own].sort()).toEqual(["app.montral.example", "auth.montral.example"]);
    expect([...appHosts({ WEB_ORIGIN: "not a url" })]).toEqual([]);
  });
});

describe("routingHost", () => {
  it("uses the Host header, without port, case or trailing dot", () => {
    expect(routingHost({ host: "Status.Example.com:443" }, false)).toBe("status.example.com");
    expect(routingHost({ host: "status.example.com." }, false)).toBe("status.example.com");
  });
  it("ignores X-Forwarded-Host from an untrusted peer", () => {
    expect(routingHost({ host: "app.montral.example", "x-forwarded-host": "status.example.com" }, false)).toBe("app.montral.example");
  });
  it("honours the first X-Forwarded-Host value from a trusted proxy", () => {
    expect(routingHost({ host: "127.0.0.1:8080", "x-forwarded-host": "status.example.com, evil.example" }, true)).toBe("status.example.com");
    expect(routingHost({ host: "app.montral.example" }, true)).toBe("app.montral.example");
  });
  it("refuses missing or malformed hosts", () => {
    expect(routingHost({}, false)).toBeNull();
    expect(routingHost({ host: "evil.example/<script>" }, false)).toBeNull();
    expect(routingHost({ host: "a".repeat(300) }, false)).toBeNull();
  });
});

describe("customDomainRoute", () => {
  const pub = { slug: "acme", visibility: "public" as const };
  const pw = { slug: "acme", visibility: "password" as const };

  it("renders the page at the root, keeping the query", () => {
    expect(customDomainRoute("GET", "/", pub)).toEqual({ kind: "page", url: "/status/acme" });
    expect(customDomainRoute("HEAD", "/?before=2026-01-01", pub)).toEqual({ kind: "page", url: "/status/acme?before=2026-01-01" });
    expect(customDomainRoute("POST", "/", pub)).toEqual({ kind: "not_found" });
  });

  it("maps the root feeds to the page's public API", () => {
    expect(customDomainRoute("GET", "/rss.xml", pub)).toEqual({ kind: "api", url: "/api/public/status/acme/rss.xml" });
    expect(customDomainRoute("GET", "/maintenance.ics", pub)).toEqual({ kind: "api", url: "/api/public/status/acme/maintenance.ics" });
    expect(customDomainRoute("GET", "/badge.svg?lang=zh", pub)).toEqual({ kind: "api", url: "/api/public/status/acme/badge.svg?lang=zh" });
    expect(customDomainRoute("GET", "/llms.txt", pub)).toEqual({ kind: "api", url: "/api/public/status/acme/llms.txt" });
  });

  it("keeps the page's own public API (board, history, subscribe) working", () => {
    expect(customDomainRoute("GET", "/api/public/status/acme", pub)).toEqual({ kind: "api", url: "/api/public/status/acme" });
    expect(customDomainRoute("GET", "/api/public/status/acme/incidents?before=x", pub)).toEqual({ kind: "api", url: "/api/public/status/acme/incidents?before=x" });
    expect(customDomainRoute("POST", "/api/public/status/acme/subscribe", pub)).toEqual({ kind: "api", url: "/api/public/status/acme/subscribe" });
  });

  it("serves the page's static assets only", () => {
    expect(customDomainRoute("GET", "/_astro/index.Ab12_c.css", pub)).toEqual({ kind: "asset", url: "/_astro/index.Ab12_c.css" });
    expect(customDomainRoute("GET", "/favicon.svg", pub)).toEqual({ kind: "asset", url: "/favicon.svg" });
    for (const p of ["/manifest.webmanifest", "/sw.js", "/embed.js", "/index.html", "/robots.txt", "/_astro/a/b.js"]) {
      expect(customDomainRoute("GET", p, pub), p).toEqual({ kind: "not_found" });
    }
  });

  it("404s the app, sign-in, private API, webhooks, docs and other pages on the custom host", () => {
    for (const p of [
      "/app", "/app/status-pages", "/login", "/signup", "/forgot-password", "/reset-password", "/accept-invite", "/docs", "/docs/api",
      "/status/acme", "/status/other", "/locked-status?slug=acme", "/zh-Hans", "/zh-Hans/status/acme", "/api/me", "/api/auth/sign-in/email",
      "/api/auth/get-session", "/api/status-pages", "/api/hooks/abc", "/hooks/abc", "/internal/migrate", "/health", "/.well-known/oauth-authorization-server",
      "/api/public/status/other", "/api/public/status/other/rss.xml", "/api/public/status/_/access?t=x", "/api/public/status/_/confirm?token=x",
      "/api/public/status/acme/../../me", "/api/public/status/acme/%2e%2e/%2e%2e/me", "/api/public/status/acme%2f..%2fother",
      "/_astro/../app", "//evil.example/", "http://custom.invalid/app",
    ]) {
      expect(customDomainRoute("GET", p, pub), p).toEqual({ kind: "not_found" });
      expect(customDomainRoute("POST", p, pub), `POST ${p}`).toEqual({ kind: "not_found" });
    }
  });

  it("only a password page accepts the unlock POST on its domain", () => {
    expect(customDomainRoute("POST", "/api/public/status/_/unlock", pw)).toEqual({ kind: "api", url: "/api/public/status/_/unlock" });
    expect(customDomainRoute("GET", "/api/public/status/_/unlock", pw)).toEqual({ kind: "not_found" });
    expect(customDomainRoute("POST", "/api/public/status/_/unlock", pub)).toEqual({ kind: "not_found" });
    expect(customDomainRoute("GET", "/", pw)).toEqual({ kind: "page", url: "/status/acme" });
  });

  it("a members-only page is a 404 for every path", () => {
    const members = { slug: "acme", visibility: "members" as const };
    for (const p of ["/", "/rss.xml", "/api/public/status/acme", "/_astro/x.js", "/favicon.svg"]) {
      expect(customDomainRoute("GET", p, members), p).toEqual({ kind: "not_found" });
    }
  });
});

describe("customDomainCookies", () => {
  const id = "0b7e4c1e-1111-4222-8333-944445555666";
  it("keeps only the page's access cookie", () => {
    const access = "montral_sa_0b7e4c1e111142228333944445555666=payload.sig";
    expect(customDomainCookies(`better-auth.session_token=abc; ${access}; montral_lang=zh-CN`, id)).toBe(access);
    expect(customDomainCookies("montral_sa_ffff=1; better-auth.session_token=abc", id)).toBeUndefined();
    expect(customDomainCookies(undefined, id)).toBeUndefined();
  });
});

describe("verifyDomainToken", () => {
  afterEach(() => setTxtResolver(undefined));
  const token = newDomainToken();

  it("issues unguessable, distinct tokens", () => {
    expect(token).toMatch(/^montral-verify=[0-9a-f]{40}$/);
    expect(newDomainToken()).not.toBe(token);
  });

  it("asks for the TXT record at _montral-challenge.<domain> and needs an exact match", async () => {
    const asked: string[] = [];
    setTxtResolver(async (name) => { asked.push(name); return [["v=spf1 -all"], [token]]; });
    expect(await verifyDomainToken("status.example.com", token)).toEqual({ ok: true });
    expect(asked).toEqual([challengeName("status.example.com")]);
    expect(asked[0]).toBe("_montral-challenge.status.example.com");
  });

  it("joins a record split into several character strings", async () => {
    expect(await verifyDomainToken("s.example.com", token, async () => [[token.slice(0, 10), token.slice(10)]])).toEqual({ ok: true });
  });

  it("refuses prefixes, substrings, case changes and other pages' tokens", async () => {
    for (const records of [[[token.slice(0, -1)]], [[`${token}x`]], [[`x ${token}`]], [[token.toUpperCase()]], [[newDomainToken()]]]) {
      expect(await verifyDomainToken("s.example.com", token, async () => records)).toEqual({ ok: false, reason: "mismatch" });
    }
  });

  it("tells a missing record from a failed lookup", async () => {
    expect(await verifyDomainToken("s.example.com", token, async () => [])).toEqual({ ok: false, reason: "missing" });
    const nx = Object.assign(new Error("queryTxt ENOTFOUND"), { code: "ENOTFOUND" });
    expect(await verifyDomainToken("s.example.com", token, async () => { throw nx; })).toEqual({ ok: false, reason: "missing" });
    const timeout = Object.assign(new Error("queryTxt ETIMEOUT"), { code: "ETIMEOUT" });
    expect(await verifyDomainToken("s.example.com", token, async () => { throw timeout; })).toEqual({ ok: false, reason: "lookup_failed" });
  });
});

describe("lookupCustomDomain", () => {
  afterEach(() => purgeCustomDomains());

  it("asks only for verified domains and caches hits and misses until purged", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).toMatch(/custom_domain_verified_at IS NOT NULL/);
      return params?.[0] === "status.example.com" ? [{ id: "p1", slug: "acme", visibility: "public" }] : [];
    }) as unknown as <T>(sql: string, params?: unknown[]) => Promise<T[]>;
    expect(await lookupCustomDomain(query, "status.example.com")).toEqual({ id: "p1", slug: "acme", visibility: "public", domain: "status.example.com" });
    expect(await lookupCustomDomain(query, "status.example.com")).toMatchObject({ slug: "acme" });
    expect(await lookupCustomDomain(query, "unknown.example.com")).toBeNull();
    expect(await lookupCustomDomain(query, "unknown.example.com")).toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
    purgeCustomDomains();
    await lookupCustomDomain(query, "status.example.com");
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("propagates database errors so the router fails closed", async () => {
    const broken = (async () => { throw new Error("db down"); }) as <T>(sql: string, params?: unknown[]) => Promise<T[]>;
    await expect(lookupCustomDomain(broken, "status.example.com")).rejects.toThrow("db down");
  });
});

describe("customDomainOrigin", () => {
  it("uses https unless the instance itself runs on http", () => {
    expect(customDomainOrigin("status.example.com", "https://app.example")).toBe("https://status.example.com");
    expect(customDomainOrigin("status.example.com", undefined)).toBe("https://status.example.com");
    expect(customDomainOrigin("status.example.com", "http://localhost:8080")).toBe("http://status.example.com");
  });
});
