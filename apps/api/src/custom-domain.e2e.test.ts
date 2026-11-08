import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "@montral/db-pg";
import { createApp } from "./app";
import { montralEdition } from "./montral-edition";
import { migrateMontralSchema } from "./schema-migrate";
import { customDomainRoute, lookupCustomDomain, purgeCustomDomains, setTxtResolver } from "./custom-domain";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = {
  DATABASE_URL: url,
  BETTER_AUTH_SECRET: "montral-e2e-only-secret-not-for-production",
  BETTER_AUTH_URL: origin,
  WEB_ORIGIN: origin,
};

describe.skipIf(!url)("status page custom domains (PostgreSQL)", () => {
  const database = url ? openDatabase(url, { max: 4 }) : null;
  const app = createApp(openDatabase, { edition: montralEdition });
  /** TXT records the stub DNS answers with, by name */
  const txt = new Map<string, string[]>();
  beforeAll(async () => {
    await migrateMontralSchema(database!, montralEdition);
    setTxtResolver(async (name) => (txt.get(name) ?? []).map((v) => [v]));
  });
  afterEach(() => { txt.clear(); purgeCustomDomains(); });
  afterAll(async () => { setTxtResolver(undefined); await database?.close(1); });

  const call = (path: string, init: RequestInit & { cookie?: string } = {}) =>
    app.fetch(new Request(origin + path, {
      ...init,
      headers: { origin, "content-type": "application/json", ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers as Record<string, string> | undefined) },
    }), env as never);
  async function signUp() {
    const email = `montral-domain-${crypto.randomUUID()}@example.com`;
    const res = await call("/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email, name: "Domain QA", password: "correct horse battery staple" }) });
    expect(res.status).toBe(200);
    return { cookie: res.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ") };
  }
  async function newPage(cookie: string) {
    const slug = `dom-${crypto.randomUUID().slice(0, 8)}`;
    const res = await call("/api/status-pages", { method: "POST", cookie, body: JSON.stringify({ slug, title: `Domain ${slug}` }) });
    expect(res.status).toBe(201);
    return { id: ((await res.json()) as { id: string }).id, slug };
  }
  type TxtRecord = { type: "TXT"; name: string; value: string };
  const setDomain = (id: string, domain: string, cookie: string) => call(`/api/status-pages/${id}/domain`, { method: "PUT", cookie, body: JSON.stringify({ domain }) });
  const verify = (id: string, cookie: string) => call(`/api/status-pages/${id}/domain/verify`, { method: "POST", cookie });
  const lookup = (host: string) => { purgeCustomDomains(); return lookupCustomDomain((sql, params) => database!.query(sql, params), host); };
  const host = () => `status-${crypto.randomUUID().slice(0, 8)}.example.com`;

  it("sets, verifies against an exact TXT match, resets on re-set, and clears a domain", async () => {
    const owner = await signUp();
    const page = await newPage(owner.cookie);
    const domain = host();

    for (const bad of ["localhost", "status.example.com:8443", "https://x.example.com", "*.example.com", "10.0.0.1", "a.example.com/x"]) {
      expect((await setDomain(page.id, bad, owner.cookie)).status, bad).toBe(400);
    }

    const set = await setDomain(page.id, domain.toUpperCase(), owner.cookie);
    expect(set.status).toBe(200);
    const first = (await set.json()) as { customDomain: string; customDomainRecord: TxtRecord };
    expect(first.customDomain).toBe(domain);
    expect(first.customDomainRecord).toMatchObject({ type: "TXT", name: `_montral-challenge.${domain}` });
    const shown = (await (await call(`/api/status-pages/${page.id}`, { cookie: owner.cookie })).json()) as { customDomain: string; customDomainVerifiedAt: string | null; customDomainRecord: TxtRecord };
    expect(shown).toMatchObject({ customDomain: domain, customDomainVerifiedAt: null, customDomainRecord: first.customDomainRecord });

    // no record, then a wrong one: not verified, and an unverified domain is never routed
    const missing = await verify(page.id, owner.cookie);
    expect(missing.status).toBe(422);
    expect(await missing.json()).toMatchObject({ verified: false, reason: "missing" });
    txt.set(first.customDomainRecord.name, [`${first.customDomainRecord.value}x`, "unrelated"]);
    expect(await (await verify(page.id, owner.cookie)).json()).toMatchObject({ verified: false, reason: "mismatch" });
    expect(await lookup(domain)).toBeNull();

    txt.set(first.customDomainRecord.name, ["unrelated", first.customDomainRecord.value]);
    const ok = await verify(page.id, owner.cookie);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ verified: true, customDomain: domain });
    expect(await lookup(domain)).toEqual({ id: page.id, slug: page.slug, visibility: "public", domain });

    // feeds name the verified domain as the page's home
    const rss = await (await call(`/api/public/status/${page.slug}/rss.xml`)).text();
    expect(rss).toContain(`http://${domain}/`);

    // setting it again (even to the same name) starts over with a new token
    const again = (await (await setDomain(page.id, domain, owner.cookie)).json()) as { customDomainRecord: TxtRecord; customDomainVerifiedAt: null };
    expect(again.customDomainVerifiedAt).toBeNull();
    expect(again.customDomainRecord.value).not.toBe(first.customDomainRecord.value);
    expect(await lookup(domain)).toBeNull();
    expect((await verify(page.id, owner.cookie)).status).toBe(422); // the old record no longer counts

    const cleared = await call(`/api/status-pages/${page.id}/domain`, { method: "DELETE", cookie: owner.cookie });
    expect(cleared.status).toBe(204);
    const after = await (await call(`/api/status-pages/${page.id}`, { cookie: owner.cookie })).json();
    expect(after).toMatchObject({ customDomain: null, customDomainToken: null, customDomainVerifiedAt: null, customDomainRecord: null });
    expect((await verify(page.id, owner.cookie)).status).toBe(400);
  });

  it("another workspace cannot claim or touch a verified domain; an unverified claim does not block its owner", async () => {
    const owner = await signUp();
    const other = await signUp();
    const mine = await newPage(owner.cookie);
    const theirs = await newPage(other.cookie);
    const domain = host();
    const rec = ((await (await setDomain(mine.id, domain, owner.cookie)).json()) as { customDomainRecord: TxtRecord }).customDomainRecord;
    txt.set(rec.name, [rec.value]);
    expect((await verify(mine.id, owner.cookie)).status).toBe(200);

    const claim = await setDomain(theirs.id, domain, other.cookie);
    expect(claim.status).toBe(409);
    expect(await claim.json()).toMatchObject({ code: "custom_domain_taken" });
    // the owner's page is not even visible to the other workspace
    expect((await setDomain(mine.id, host(), other.cookie)).status).toBe(404);
    expect((await call(`/api/status-pages/${mine.id}/domain`, { method: "DELETE", cookie: other.cookie })).status).toBe(404);
    expect((await verify(mine.id, other.cookie)).status).toBe(404);
    expect((await lookup(domain))?.id).toBe(mine.id);

    // a squatter's unverified claim: the real owner can still claim and verify; the squatter then cannot verify
    const contested = host();
    const squat = ((await (await setDomain(theirs.id, contested, other.cookie)).json()) as { customDomainRecord: TxtRecord }).customDomainRecord;
    const second = await newPage(owner.cookie);
    const real = ((await (await setDomain(second.id, contested, owner.cookie)).json()) as { customDomainRecord: TxtRecord }).customDomainRecord;
    txt.set(real.name, [real.value]);
    expect((await verify(theirs.id, other.cookie)).status).toBe(422); // their token is not in DNS
    expect((await verify(second.id, owner.cookie)).status).toBe(200);
    txt.set(real.name, [real.value, squat.value]); // even with both records present, only one page may hold the domain
    const lost = await verify(theirs.id, other.cookie);
    expect(lost.status).toBe(409);
    expect((await lookup(contested))?.id).toBe(second.id);
  });

  it("members-only pages are not served on their domain; password pages unlock from their own domain only", async () => {
    const owner = await signUp();
    const page = await newPage(owner.cookie);
    const domain = host();
    const rec = ((await (await setDomain(page.id, domain, owner.cookie)).json()) as { customDomainRecord: TxtRecord }).customDomainRecord;
    txt.set(rec.name, [rec.value]);
    expect((await verify(page.id, owner.cookie)).status).toBe(200);

    await call(`/api/status-pages/${page.id}`, { method: "PATCH", cookie: owner.cookie, body: JSON.stringify({ visibility: "members" }) });
    const members = await lookup(domain);
    expect(members?.visibility).toBe("members");
    expect(customDomainRoute("GET", "/", members!)).toEqual({ kind: "not_found" });
    expect(customDomainRoute("GET", `/api/public/status/${page.slug}`, members!)).toEqual({ kind: "not_found" });

    const password = "correct horse battery staple";
    await call(`/api/status-pages/${page.id}`, { method: "PATCH", cookie: owner.cookie, body: JSON.stringify({ visibility: "password", password }) });
    expect(customDomainRoute("GET", "/", (await lookup(domain))!)).toEqual({ kind: "page", url: `/status/${page.slug}` });
    // the Origin differs from the request URL here, so the custom-domain branch of the check decides
    const unlock = (from: string, slug = page.slug) => app.fetch(new Request(`${origin}/api/public/status/_/unlock`, {
      method: "POST",
      headers: { origin: from, "content-type": "application/json" },
      body: JSON.stringify({ slug, password }),
    }), env as never);

    const ok = await unlock(`http://${domain}`);
    expect(ok.status).toBe(204);
    const cookie = ok.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^montral_sa_[0-9a-f]{32}=/);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toMatch(/Domain=/i); // host-only: set by, and sent back to, the custom domain alone

    expect((await unlock("http://evil.example")).status).toBe(403);
    expect((await unlock(`https://${domain}.evil.example`)).status).toBe(403);
    // another page's slug from this page's domain is refused
    const other = await newPage(owner.cookie);
    await call(`/api/status-pages/${other.id}`, { method: "PATCH", cookie: owner.cookie, body: JSON.stringify({ visibility: "password", password }) });
    expect((await unlock(`http://${domain}`, other.slug)).status).toBe(403);
    // an unverified domain's origin is refused
    await setDomain(page.id, domain, owner.cookie);
    expect((await unlock(`http://${domain}`)).status).toBe(403);
    // the main origin keeps working
    const main = await app.fetch(new Request(`${origin}/api/public/status/_/unlock`, {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ slug: page.slug, password }),
    }), env as never);
    expect(main.status).toBe(204);
  });
});
