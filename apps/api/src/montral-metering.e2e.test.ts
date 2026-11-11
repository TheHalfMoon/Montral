import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "@montral/db-pg";
import { createApp } from "./app";
import { montralEdition } from "./montral-edition";
import { migrateMontralSchema } from "./schema-migrate";
import { calendarMonthUtc, createMontralEntitlements } from "./montral-metering";
import { refundBrowserSeconds, reserveBrowserSeconds, unusedBrowserSeconds } from "./scheduler";
import type { Bindings } from "./env";

/**
 * Resource meters against PostgreSQL (SaaS stage 3): captured webhook events and browser-check seconds share the usage
 * ledger (montral_usage, montral_spend_usage). Synthetic catalogs only: no number here describes a real offer.
 */
const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:8787";
const base: Bindings = {
  DATABASE_URL: url, BETTER_AUTH_SECRET: "montral-metering-e2e-only-secret-not-live",
  BETTER_AUTH_URL: ORIGIN, WEB_ORIGIN: ORIGIN,
};
const catalog = (limits: { webhookEvents?: number; browserSeconds?: number; credits?: number }) => JSON.stringify({
  schemaVersion: 1, version: "synthetic-meters-e2e", defaultPlan: "basic",
  plans: [{ id: "basic", name: "Basic", limits: { activeMonitors: 5, minIntervalSec: 60, regions: 1, credits: limits.credits ?? 100, emails: 3, ...limits } }],
});
const metered = (limits: Parameters<typeof catalog>[0]): Bindings => ({ ...base, MONTRAL_METERING_ENABLED: "true", MONTRAL_PLAN_CONFIG_JSON: catalog(limits) });
const app = createApp(openDatabase, { edition: montralEdition });
const db = url ? openDatabase(url, { max: 6 }) : null;

afterAll(async () => { await db?.close(1); });

describe.skipIf(!url)("Montral resource meters PostgreSQL verification", () => {
  beforeAll(async () => {
    await migrateMontralSchema(db!, montralEdition);
  });

  async function signup() {
    const response = await app.fetch(new Request(ORIGIN + "/api/auth/sign-up/email", {
      method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ name: "Meter test", email: `meters-${crypto.randomUUID()}@example.com`, password: "correct horse battery staple" }),
    }), base as never);
    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie().map((x) => x.split(";")[0]).join("; ");
    const me = await app.fetch(new Request(ORIGIN + "/api/me", { headers: { cookie } }), base as never);
    const user = await me.json() as { organization: { id: string } };
    const call = async (method: string, path: string, body?: unknown, env: Bindings = base) => {
      const res = await app.fetch(new Request(ORIGIN + "/api" + path, {
        method, headers: { origin: ORIGIN, cookie, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }), env as never);
      return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) as any };
    };
    return { cookie, org: user.organization.id, call };
  }
  async function inbox(call: Awaited<ReturnType<typeof signup>>["call"]) {
    const created = await call("POST", "/hooks/inboxes", { name: "Meter inbox" });
    expect(created.status).toBe(201);
    return created.body as { id: string; path: string };
  }
  const capture = (path: string, env: Bindings, body = '{"synthetic":true}') => app.fetch(new Request(ORIGIN + path, {
    method: "POST", headers: { "content-type": "application/json" }, body,
  }), env as never);
  const stored = async (inboxId: string) => Number((await db!.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM montral_hook_event WHERE inbox_id=$1", [inboxId]))[0].n);
  const used = async (org: string, kind: string, start = calendarMonthUtc().start) => Number((await db!.query<{ used: number }>(
    "SELECT used FROM montral_usage WHERE organization_id=$1 AND period_start=$2::timestamptz AND kind=$3", [org, start.toISOString(), kind]))[0]?.used ?? 0);

  it("widens the ledger's kind check idempotently, replacing a legacy check found by its definition", async () => {
    // simulate a table created before the resource meters: the original two-kind check under PostgreSQL's own name
    await db!.query(`ALTER TABLE montral_usage DROP CONSTRAINT IF EXISTS montral_usage_kind_v2,
      ADD CONSTRAINT montral_usage_kind_check CHECK (kind IN ('credits','emails')) NOT VALID`);
    await migrateMontralSchema(db!, montralEdition);
    await migrateMontralSchema(db!, montralEdition); // a restart changes nothing
    const checks = await db!.query<{ conname: string }>(
      "SELECT conname FROM pg_constraint WHERE conrelid = to_regclass('montral_usage') AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%kind%'");
    expect(checks.map((c) => c.conname)).toEqual(["montral_usage_kind_v2"]);
    const { org } = await signup();
    await db!.query("INSERT INTO montral_usage(organization_id,period_start,kind,used) VALUES($1,$2::timestamptz,'browser_seconds',1)", [org, calendarMonthUtc().start.toISOString()]);
    await expect(db!.query("INSERT INTO montral_usage(organization_id,period_start,kind,used) VALUES($1,$2::timestamptz,'anything',1)", [org, calendarMonthUtc().start.toISOString()])).rejects.toThrow();
    await expect(db!.query("SELECT montral_spend_usage_v2($1::text,$2::timestamptz,'anything'::text,1,5)", [org, calendarMonthUtc().start.toISOString()])).rejects.toThrow(/invalid usage request/);
    // the previous release's function is left exactly as it was: two kinds only
    await expect(db!.query("SELECT montral_spend_usage($1::text,$2::timestamptz,'webhook_events'::text,1,5)", [org, calendarMonthUtc().start.toISOString()])).rejects.toThrow(/invalid usage request/);
    expect(await db!.query("SELECT montral_spend_usage_v2($1::text,$2::timestamptz,'webhook_events'::text,1,5) AS granted", [org, calendarMonthUtc().start.toISOString()])).toEqual([{ granted: 1 }]);
  });

  it("keeps metering webhooks and browser seconds after a previous-release replica re-creates its spend function", async () => {
    // exactly what the previous release's migration runs on every restart (main before the resource meters)
    await db!.query(`
      CREATE OR REPLACE FUNCTION montral_spend_usage(
        p_org text, p_start timestamptz, p_kind text, p_count integer, p_limit integer
      ) RETURNS integer LANGUAGE plpgsql AS $montral$
      DECLARE previous integer := 0; granted integer := 0;
      BEGIN
        IF p_count < 0 OR p_limit < 0 OR p_kind NOT IN ('credits','emails')
          THEN RAISE EXCEPTION 'invalid usage request';
        END IF;
        IF p_count = 0 THEN RETURN 0; END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended(p_org || ':' || p_start::text || ':' || p_kind,0));
        SELECT used INTO previous FROM montral_usage
          WHERE organization_id=p_org AND period_start=p_start AND kind=p_kind FOR UPDATE;
        granted := GREATEST(0,LEAST(p_count,p_limit-COALESCE(previous,0)));
        IF granted > 0 THEN
          INSERT INTO montral_usage(organization_id,period_start,kind,used)
            VALUES(p_org,p_start,p_kind,granted)
          ON CONFLICT (organization_id,period_start,kind)
            DO UPDATE SET used=montral_usage.used + EXCLUDED.used;
        END IF;
        RETURN granted;
      END;
      $montral$
    `);
    const { org, call } = await signup();
    const { id, path } = await inbox(call);
    const env = metered({ webhookEvents: 1, browserSeconds: 40 });
    expect((await capture(path, env)).status).toBe(202);
    expect((await capture(path, env)).status).toBe(429);
    expect(await stored(id)).toBe(1);
    const e = createMontralEntitlements(db!, env);
    expect(await reserveBrowserSeconds(org, { browser: { steps: [], timeoutMs: 30_000 } } as never, e, new Date())).toEqual({ ok: true, seconds: 30 });
    expect(await e.spendCredits(org, 2)).toBe(2);
    // an old replica spending credits through its own function shares the ledger and the limit
    expect(await db!.query("SELECT montral_spend_usage($1::text,$2::timestamptz,'credits'::text,500,100) AS granted", [org, calendarMonthUtc().start.toISOString()])).toEqual([{ granted: 98 }]);
    expect(await e.spendCredits(org, 1)).toBe(0);
  });

  it("charges one webhook event per capture before storing; exhausted answers 429 until the next month and stores nothing", async () => {
    const { org, call } = await signup();
    const { id, path } = await inbox(call);
    const env = metered({ webhookEvents: 2 });
    expect((await capture(path, env)).status).toBe(202);
    expect((await capture(path, env)).status).toBe(202);
    const refused = await capture(path, env);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("cache-control")).toBe("private, no-store");
    expect(await refused.json()).toMatchObject({ code: "webhook_quota_exhausted" });
    const retry = Number(refused.headers.get("retry-after"));
    const untilNext = Math.ceil((calendarMonthUtc().end.getTime() - Date.now()) / 1000);
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(untilNext + 1);
    expect(await stored(id)).toBe(2);
    expect(await used(org, "webhook_events")).toBe(2);
    // the usage API reports the meter
    const usage = await call("GET", "/usage", undefined, env);
    expect(usage.body).toMatchObject({ metered: true, webhookEvents: { limit: 2, used: 2 }, browserSeconds: { used: 0 } });
  });

  it("never captures more than the allowance under concurrent requests", async () => {
    const { org, call } = await signup();
    const { id, path } = await inbox(call);
    const env = metered({ webhookEvents: 3 });
    const statuses = (await Promise.all(Array.from({ length: 8 }, () => capture(path, env)))).map((r) => r.status).sort();
    expect(statuses).toEqual([202, 202, 202, 429, 429, 429, 429, 429]);
    expect(await stored(id)).toBe(3);
    expect(await used(org, "webhook_events")).toBe(3);
  });

  it("fails closed: a broken plan catalog answers 503 metering_unavailable and stores nothing", async () => {
    const { org, call } = await signup();
    const { id, path } = await inbox(call);
    const broken: Bindings = { ...base, MONTRAL_METERING_ENABLED: "true", MONTRAL_PLAN_CONFIG_JSON: "{ not json" };
    const res = await capture(path, broken);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "metering_unavailable" });
    expect(await stored(id)).toBe(0);
    expect(await used(org, "webhook_events")).toBe(0);
  });

  it("self-hosted (unmetered) captures are not counted or refused", async () => {
    const { org, call } = await signup();
    const { id, path } = await inbox(call);
    for (let i = 0; i < 4; i++) expect((await capture(path, base)).status).toBe(202);
    expect(await stored(id)).toBe(4);
    expect(await used(org, "webhook_events")).toBe(0);
    expect((await call("GET", "/usage")).body).toEqual({ metered: false });
  });

  it("reserves browser seconds at the configured timeout and refunds the unused part to the month of the charge", async () => {
    const { org } = await signup();
    const e = createMontralEntitlements(db!, metered({ browserSeconds: 100 }));
    const current = calendarMonthUtc();
    const previous = calendarMonthUtc(new Date(current.start.getTime() - 1));
    // a check reserved one second before midnight UTC on the 1st, whose refund is booked after the boundary
    const spentAt = new Date(current.start.getTime() - 1_000);
    const monitor = { browser: { steps: [], timeoutMs: 29_500 } } as never;
    expect(await reserveBrowserSeconds(org, monitor, e, spentAt)).toEqual({ ok: true, seconds: 30 });
    expect(await used(org, "browser_seconds", previous.start)).toBe(30);
    await refundBrowserSeconds(org, unusedBrowserSeconds(30, 10_200, "done"), e, spentAt);
    expect(await used(org, "browser_seconds", previous.start)).toBe(11);
    expect(await used(org, "browser_seconds", current.start)).toBe(0);
    // a deferred run gives everything back
    const now = new Date();
    expect(await reserveBrowserSeconds(org, monitor, e, now)).toEqual({ ok: true, seconds: 30 });
    await refundBrowserSeconds(org, unusedBrowserSeconds(30, 4_000, "deferred"), e, now);
    expect(await used(org, "browser_seconds", current.start)).toBe(0);
    // a refund never takes the ledger below zero
    await refundBrowserSeconds(org, 500, e, now);
    expect(await used(org, "browser_seconds", current.start)).toBe(0);
  });

  it("concurrent reservations never exceed the browser-seconds limit; a partial grant is given back", async () => {
    const { org } = await signup();
    const e = createMontralEntitlements(db!, metered({ browserSeconds: 100 }));
    const at = new Date();
    const results = await Promise.all(Array.from({ length: 8 }, () => reserveBrowserSeconds(org, { browser: { steps: [], timeoutMs: 30_000 } } as never, e, at)));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "exhausted")).toBe(true);
    expect(await used(org, "browser_seconds")).toBe(90);
    expect(await e.meterBalance!(org, "browserSeconds")).toMatchObject({ limit: 100, used: 90 });
  });

  it("refuses a manual browser check without browser seconds (402), giving its credit back; a check that did not run refunds everything", async () => {
    const { org, call } = await signup();
    const created = await call("POST", "/monitors", { name: "Journey", type: "heartbeat", intervalSec: 3600 });
    expect(created.status).toBe(201);
    // a browser monitor without needing Chromium here: the journey is stored directly
    await db!.query(`UPDATE monitor SET type='browser', target='https://example.com/', interval_sec=600,
      browser='{"steps":[{"action":"goto","url":"https://example.com/"}],"timeoutMs":30000,"screenshot":"never"}'::jsonb WHERE id=$1`, [created.body.id]);
    const short = await call("POST", `/monitors/${created.body.id}/check`, {}, metered({ browserSeconds: 10 }));
    expect(short.status).toBe(402);
    expect(short.body).toMatchObject({ code: "browser_quota_exhausted" });
    expect(await used(org, "credits")).toBe(0);
    expect(await used(org, "browser_seconds")).toBe(0);
    // enough seconds: the check is attempted; browser checks are not enabled on this server, so it did not run and
    // its credit and every reserved second come back
    const tried = await call("POST", `/monitors/${created.body.id}/check`, {}, metered({ browserSeconds: 100 }));
    expect(tried.status).toBe(200);
    expect(await used(org, "credits")).toBe(0);
    expect(await used(org, "browser_seconds")).toBe(0);
  });
});
