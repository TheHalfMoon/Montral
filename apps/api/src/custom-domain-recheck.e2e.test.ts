import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "@montral/db-pg";
import { createApp } from "./app";
import { montralEdition } from "./montral-edition";
import { migrateMontralSchema } from "./schema-migrate";
import { DOMAIN_RECHECK, lookupCustomDomain, purgeCustomDomains, recheckCustomDomains, setTxtResolver, type TxtResolver } from "./custom-domain";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = {
  DATABASE_URL: url,
  BETTER_AUTH_SECRET: "montral-e2e-only-secret-not-for-production",
  BETTER_AUTH_URL: origin,
  WEB_ORIGIN: origin,
};
const H = 3600_000;

/**
 * Scheduled re-verification of verified custom domains, on real PostgreSQL with a stub resolver and an explicit clock.
 * Every re-check is scoped to the test's own page (pageIds), so other test files' domains in the shared database are
 * never claimed or changed.
 */
describe.skipIf(!url)("custom domain re-verification (PostgreSQL)", () => {
  const database = url ? openDatabase(url, { max: 6 }) : null;
  const app = createApp(openDatabase, { edition: montralEdition });
  const txt = new Map<string, string[]>();
  /** what the stub DNS answers for a name: records, or a resolver error code */
  const stub: TxtResolver = async (name) => (txt.get(name) ?? []).map((v) => [v]);
  const failing = (code: string): TxtResolver => async () => { throw Object.assign(new Error(code), { code }); };
  beforeAll(async () => {
    await migrateMontralSchema(database!, montralEdition);
    setTxtResolver(stub); // the verify route resolves through the module resolver
  });
  afterEach(() => { txt.clear(); purgeCustomDomains(); });
  afterAll(async () => { setTxtResolver(undefined); await database?.close(1); });

  const q = <T,>(sql: string, params?: unknown[]) => database!.query<T>(sql, params);
  const call = (path: string, init: RequestInit & { cookie?: string } = {}) =>
    app.fetch(new Request(origin + path, {
      ...init,
      headers: { origin, "content-type": "application/json", ...(init.cookie ? { cookie: init.cookie } : {}) },
    }), env as never);
  async function signUp() {
    const email = `montral-recheck-${crypto.randomUUID()}@example.com`;
    const res = await call("/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email, name: "Recheck QA", password: "correct horse battery staple" }) });
    expect(res.status).toBe(200);
    return res.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
  }
  type Rec = { name: string; value: string };
  /** a page with a verified domain; returns its id, domain, TXT record and the time verification stamped */
  async function verifiedPage(cookie?: string) {
    cookie ??= await signUp();
    const slug = `rck-${crypto.randomUUID().slice(0, 8)}`;
    const created = await call("/api/status-pages", { method: "POST", cookie, body: JSON.stringify({ slug, title: `Recheck ${slug}` }) });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { id: string }).id;
    const domain = `status-${crypto.randomUUID().slice(0, 8)}.example.com`;
    const set = await call(`/api/status-pages/${id}/domain`, { method: "PUT", cookie, body: JSON.stringify({ domain }) });
    const rec = ((await set.json()) as { customDomainRecord: Rec }).customDomainRecord;
    txt.set(rec.name, [rec.value]);
    expect((await call(`/api/status-pages/${id}/domain/verify`, { method: "POST", cookie })).status).toBe(200);
    const [row] = await q<{ checked: Date }>("SELECT custom_domain_checked_at AS checked FROM status_page WHERE id = $1", [id]);
    return { id, domain, rec, cookie, t0: new Date(row.checked).getTime() };
  }
  const state = async (id: string) => (await q<{ verified: Date | null; checked: Date | null; since: Date | null; failures: number; error: string | null; domain: string | null }>(
    `SELECT custom_domain_verified_at AS verified, custom_domain_checked_at AS checked, custom_domain_failing_since AS since,
            custom_domain_failures AS failures, custom_domain_check_error AS error, custom_domain AS domain FROM status_page WHERE id = $1`, [id]))[0];
  const recheck = (id: string, at: number, resolver: TxtResolver = stub) => recheckCustomDomains(q, { now: new Date(at), resolver, pageIds: [id] });
  const routed = async (domain: string) => { purgeCustomDomains(); return (await lookupCustomDomain(q, domain))?.id ?? null; };

  it("verification stamps a check; the next re-check is due only after the healthy interval and a match keeps the domain", async () => {
    const p = await verifiedPage();
    expect(await recheck(p.id, p.t0 + DOMAIN_RECHECK.healthyMs - 60_000)).toMatchObject({ checked: 0 });
    expect(await recheck(p.id, p.t0 + DOMAIN_RECHECK.healthyMs + 1000)).toEqual({ checked: 1, matched: 1, failed: 0, withdrawn: 0 });
    const s = await state(p.id);
    expect(s).toMatchObject({ failures: 0, error: null, since: null });
    expect(new Date(s.checked!).getTime()).toBe(p.t0 + DOMAIN_RECHECK.healthyMs + 1000);
    expect(await routed(p.domain)).toBe(p.id);
  });

  it("a record that disappears briefly keeps the page served, is re-checked sooner, and the streak clears when it returns", async () => {
    const p = await verifiedPage();
    txt.delete(p.rec.name);
    const t1 = p.t0 + 7 * H;
    expect(await recheck(p.id, t1)).toMatchObject({ checked: 1, failed: 1, withdrawn: 0 });
    expect(await state(p.id)).toMatchObject({ failures: 1, error: "missing" });
    expect(new Date((await state(p.id)).since!).getTime()).toBe(t1);
    expect(await routed(p.domain)).toBe(p.id); // still served during the grace period
    // failing rows come back after the shorter interval, not the healthy one
    expect(await recheck(p.id, t1 + DOMAIN_RECHECK.failingMs - 1000)).toMatchObject({ checked: 0 });
    txt.set(p.rec.name, [p.rec.value]);
    expect(await recheck(p.id, t1 + DOMAIN_RECHECK.failingMs + 1000)).toMatchObject({ checked: 1, matched: 1 });
    expect(await state(p.id)).toMatchObject({ failures: 0, error: null, since: null });
  });

  it("withdraws a domain whose record has been missing for 24 hours over at least three checks, and the admin sees why", async () => {
    const p = await verifiedPage();
    txt.delete(p.rec.name);
    const t1 = p.t0 + 7 * H;
    await recheck(p.id, t1); // 1
    await recheck(p.id, t1 + 12 * H); // 2
    expect(await recheck(p.id, t1 + 24 * H - 60_000)).toMatchObject({ withdrawn: 0 }); // 3, but under 24 h
    expect((await state(p.id)).verified).not.toBeNull();
    expect(await recheck(p.id, t1 + 24 * H)).toMatchObject({ failed: 1, withdrawn: 1 }); // 4, at 24 h
    expect(await routed(p.domain)).toBeNull();
    const shown = (await (await call(`/api/status-pages/${p.id}`, { cookie: p.cookie })).json()) as Record<string, unknown>;
    expect(shown).toMatchObject({ customDomain: p.domain, customDomainVerifiedAt: null, customDomainCheckError: "missing" });
    // a withdrawn domain is not re-checked any more; verifying again restores it and clears the reason
    expect(await recheck(p.id, t1 + 48 * H)).toMatchObject({ checked: 0 });
    txt.set(p.rec.name, [p.rec.value]);
    expect((await call(`/api/status-pages/${p.id}/domain/verify`, { method: "POST", cookie: p.cookie })).status).toBe(200);
    expect(await state(p.id)).toMatchObject({ failures: 0, error: null, since: null });
    expect(await routed(p.domain)).toBe(p.id);
  });

  it("24 hours alone is not enough: a scheduler that was down needs three failed checks before it withdraws", async () => {
    const p = await verifiedPage();
    txt.delete(p.rec.name);
    const t1 = p.t0 + 7 * H;
    await recheck(p.id, t1); // 1
    expect(await recheck(p.id, t1 + 30 * H)).toMatchObject({ withdrawn: 0 }); // 2, after a long outage
    expect(await recheck(p.id, t1 + 30 * H + DOMAIN_RECHECK.failingMs)).toMatchObject({ withdrawn: 1 }); // 3
  });

  it("a record that now holds another value counts like a missing one", async () => {
    const p = await verifiedPage();
    txt.set(p.rec.name, ["montral-verify=someone-else"]);
    const t1 = p.t0 + 7 * H;
    for (const dt of [0, 12 * H, 23 * H]) await recheck(p.id, t1 + dt);
    expect(await state(p.id)).toMatchObject({ failures: 3, error: "mismatch" });
    expect(await recheck(p.id, t1 + 24 * H)).toMatchObject({ withdrawn: 1 });
  });

  it("an unreachable DNS keeps the domain for seven days, then withdraws it; a later answer in between resets the streak", async () => {
    const p = await verifiedPage();
    const t1 = p.t0 + 7 * H;
    const servfail = failing("ESERVFAIL");
    await recheck(p.id, t1, servfail);
    await recheck(p.id, t1 + 2 * 24 * H, servfail);
    expect(await recheck(p.id, t1 + 7 * 24 * H - 60_000, servfail)).toMatchObject({ withdrawn: 0 });
    expect(await state(p.id)).toMatchObject({ error: "lookup_failed", failures: 3 });
    expect(await routed(p.domain)).toBe(p.id);
    expect(await recheck(p.id, t1 + 7 * 24 * H, servfail)).toMatchObject({ withdrawn: 1 });
    expect((await state(p.id)).error).toBe("lookup_failed");

    const r = await verifiedPage();
    const u1 = r.t0 + 7 * H;
    await recheck(r.id, u1, failing("ETIMEOUT"));
    await recheck(r.id, u1 + 6 * 24 * H, failing("ETIMEOUT"));
    expect(await recheck(r.id, u1 + 6 * 24 * H + DOMAIN_RECHECK.failingMs)).toMatchObject({ matched: 1 });
    expect(await recheck(r.id, u1 + 8 * 24 * H, failing("ETIMEOUT"))).toMatchObject({ withdrawn: 0 }); // a new streak
  });

  it("a streak that switches from unreachable DNS to a missing record starts over instead of withdrawing at once", async () => {
    const p = await verifiedPage();
    const t1 = p.t0 + 7 * H;
    await recheck(p.id, t1, failing("ESERVFAIL"));
    await recheck(p.id, t1 + 3 * 24 * H, failing("ESERVFAIL"));
    await recheck(p.id, t1 + 6 * 24 * H, failing("ESERVFAIL"));
    txt.delete(p.rec.name);
    const t2 = t1 + 6 * 24 * H + DOMAIN_RECHECK.failingMs;
    expect(await recheck(p.id, t2)).toMatchObject({ failed: 1, withdrawn: 0 }); // NXDOMAIN after 6 days of SERVFAIL
    const s = await state(p.id);
    expect(s).toMatchObject({ failures: 1, error: "missing" });
    expect(new Date(s.since!).getTime()).toBe(t2);
    await recheck(p.id, t2 + 12 * H);
    expect(await recheck(p.id, t2 + 24 * H)).toMatchObject({ withdrawn: 1 }); // the missing-record rule, from t2
  });

  it("a stale failure cannot land on a domain that was set again and re-verified with a new token during the lookup", async () => {
    const p = await verifiedPage();
    // three failures put the page one check away from withdrawal
    txt.delete(p.rec.name);
    const t1 = p.t0 + 7 * H;
    for (const dt of [0, 12 * H, 23 * H]) await recheck(p.id, t1 + dt);
    expect(await state(p.id)).toMatchObject({ failures: 3 });
    const reVerify: TxtResolver = async () => {
      const set = await call(`/api/status-pages/${p.id}/domain`, { method: "PUT", cookie: p.cookie, body: JSON.stringify({ domain: p.domain }) });
      const rec = ((await set.json()) as { customDomainRecord: Rec }).customDomainRecord;
      txt.set(rec.name, [rec.value]);
      expect((await call(`/api/status-pages/${p.id}/domain/verify`, { method: "POST", cookie: p.cookie })).status).toBe(200);
      return []; // the in-flight lookup still reports the old token missing
    };
    expect(await recheck(p.id, t1 + 24 * H, reVerify)).toMatchObject({ checked: 1, failed: 1, withdrawn: 0 });
    // verified again under the new token: still routed, with a clean streak (only the token binding blocked the write)
    expect(await state(p.id)).toMatchObject({ failures: 0, error: null, since: null });
    expect((await state(p.id)).verified).not.toBeNull();
    expect(await routed(p.domain)).toBe(p.id);
  });

  it("a re-check never touches a domain that was set again, removed or taken over while it was looking it up", async () => {
    // set again (new token) during the lookup: the stale failure must not land on the new claim
    const p = await verifiedPage();
    txt.delete(p.rec.name);
    const reSet: TxtResolver = async (name) => {
      await call(`/api/status-pages/${p.id}/domain`, { method: "PUT", cookie: p.cookie, body: JSON.stringify({ domain: p.domain }) });
      return stub(name);
    };
    expect(await recheck(p.id, p.t0 + 7 * H, reSet)).toMatchObject({ checked: 1, failed: 1, withdrawn: 0 });
    expect(await state(p.id)).toMatchObject({ verified: null, failures: 0, error: null, since: null, domain: p.domain });

    // taken over by another workspace's proven record during the lookup: neither page is harmed by the stale write
    const mine = await verifiedPage();
    const theirs = await verifiedPage();
    const steal = await call(`/api/status-pages/${theirs.id}/domain`, { method: "PUT", cookie: theirs.cookie, body: JSON.stringify({ domain: mine.domain }) });
    const theirRec = ((await steal.json()) as { customDomainRecord: Rec }).customDomainRecord;
    const takeover: TxtResolver = async () => {
      txt.set(theirRec.name, [theirRec.value]);
      expect((await call(`/api/status-pages/${theirs.id}/domain/verify`, { method: "POST", cookie: theirs.cookie })).status).toBe(200);
      return [];
    };
    expect(await recheck(mine.id, mine.t0 + 7 * H, takeover)).toMatchObject({ checked: 1, withdrawn: 0 });
    expect(await routed(mine.domain)).toBe(theirs.id);
    expect(await state(theirs.id)).toMatchObject({ failures: 0, error: null });
    expect(await state(mine.id)).toMatchObject({ verified: null, failures: 0 });
  });

  it("servers re-checking at the same moment look each domain up once", async () => {
    const p = await verifiedPage();
    let lookups = 0;
    const slow: TxtResolver = async (name) => { lookups++; await new Promise((r) => setTimeout(r, 300)); return stub(name); };
    const at = p.t0 + 7 * H;
    const results = await Promise.all([recheck(p.id, at, slow), recheck(p.id, at, slow), recheck(p.id, at, slow)]);
    expect(lookups).toBe(1);
    expect(results.reduce((n, r) => n + r.checked, 0)).toBe(1);
  });
});
