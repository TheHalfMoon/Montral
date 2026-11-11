import { openDatabase } from "@montral/db-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { montralEdition } from "./montral-edition";
import { migrateMontralSchema } from "./schema-migrate";

// Runs only when TEST_DATABASE_URL points at a database (shared with the other end-to-end tests).
const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "operator-e2e-only-secret-not-for-production", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin };

type Res = { status: number; body: any; text: string; headers: Headers };

describe.skipIf(!url)("operator control plane and workspace suspension (PostgreSQL)", () => {
  const db = url ? openDatabase(url, { max: 4 }) : null;
  // the core app for everything; the hosted edition's app only for the webhook inbox routes it mounts
  const app = createApp(openDatabase);
  const hooksApp = createApp(openDatabase, { edition: montralEdition });
  const monitorIds: string[] = [];
  beforeAll(async () => {
    await migrateMontralSchema(db!, montralEdition);
  });
  afterAll(async () => {
    // leave nothing due behind for other suites that share the database
    if (monitorIds.length) await db!.query(`UPDATE monitor SET paused = true, next_check_at = now() + interval '30 days' WHERE id = ANY(string_to_array($1::text, ',')::uuid[])`, [monitorIds.join(",")]);
    await db?.close(1);
  });

  async function fetchJson(target: typeof app, path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; env?: Record<string, string> } = {}): Promise<Res> {
    const r = await target.fetch(new Request(`${origin}${path}`, {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
    }), { ...env, ...(init.env ?? {}) } as never);
    const text = await r.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, body, text, headers: r.headers };
  }
  async function account(name: string) {
    const email = `${name}-${crypto.randomUUID()}@example.com`;
    const su = await fetchJson(app, "/api/auth/sign-up/email", { method: "POST", headers: { origin }, body: { email, name, password: "correct horse battery staple" } });
    expect(su.status).toBe(200);
    const cookie = su.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const id = su.body.user.id as string;
    const as = (path: string, init: Parameters<typeof fetchJson>[2] = {}) =>
      fetchJson(app, `/api${path}`, { ...init, headers: { origin, cookie, ...(init.headers ?? {}) } });
    const orgId = (await as("/me")).body.organization.id as string;
    return { email, id, cookie, orgId, as };
  }

  it("admits only 2FA operators with a session, suspends a workspace everywhere and restores it", async () => {
    const operator = await account("operator");
    const outsider = await account("not-operator");
    const owner = await account("customer-owner");
    const other = await account("customer-other");
    const ops = { MONTRAL_OPERATOR_USER_IDS: ` ${operator.id} , ` };

    // ── the customer's workspace: a monitor, a status page, an API key and a webhook inbox ─────────────────────────
    const monitor = await owner.as("/monitors", { method: "POST", body: { name: "Suspended heartbeat", type: "heartbeat", intervalSec: 3600 } });
    expect(monitor.status).toBe(201);
    const otherMonitor = await other.as("/monitors", { method: "POST", body: { name: "Other heartbeat", type: "heartbeat", intervalSec: 3600 } });
    expect(otherMonitor.status).toBe(201);
    monitorIds.push(monitor.body.id, otherMonitor.body.id);
    const slug = `op${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    expect((await owner.as("/status-pages", { method: "POST", body: { slug, title: "Customer status", monitorIds: [monitor.body.id] } })).status).toBe(201);
    const key = await owner.as("/auth/api-key/create", { method: "POST", body: { name: "customer-key", metadata: { organizationId: owner.orgId } } });
    expect(key.status).toBe(200);
    const withKey = (path: string) => fetchJson(app, `/api${path}`, { headers: { "x-api-key": key.body.key } });
    const inbox = await fetchJson(hooksApp, "/api/hooks/inboxes", { method: "POST", headers: { origin, cookie: owner.cookie }, body: { name: "Customer inbox" } });
    expect(inbox.status).toBe(201);
    const deliver = () => fetchJson(hooksApp, inbox.body.path, { method: "POST", body: '{"event":"while-suspended"}' });
    const storedEvents = async () => (await db!.query<{ n: number }>(`SELECT count(*)::int AS n FROM montral_hook_event WHERE inbox_id = $1::uuid`, [inbox.body.id]))[0].n;
    const [{ heartbeat_token: heartbeat }] = await db!.query<{ heartbeat_token: string }>(`SELECT heartbeat_token FROM monitor WHERE id = $1::uuid`, [monitor.body.id]);

    // ── who is an operator ──────────────────────────────────────────────────────────────────────────────────────
    const operatorCall = (who: { cookie: string } | null, path: string, init: Parameters<typeof fetchJson>[2] = {}) =>
      fetchJson(app, `/api/operator${path}`, { ...init, headers: { origin, ...(who ? { cookie: who.cookie } : {}), ...(init.headers ?? {}) }, env: { ...ops, ...(init.env ?? {}) } });
    const forbidden = (r: Res) => {
      expect(r.status).toBe(403);
      // the refusal is the same for everyone and names nothing
      expect(r.body).toEqual({ error: "Forbidden" });
      expect(r.headers.get("cache-control")).toBe("no-store");
    };
    forbidden(await operatorCall(null, "/workspaces"));
    forbidden(await operatorCall(outsider, "/workspaces"));
    forbidden(await operatorCall(outsider, `/workspaces/${owner.orgId}`));
    forbidden(await operatorCall(outsider, `/workspaces/${owner.orgId}/suspend`, { method: "POST", body: { reason: "abuse" } }));
    expect(await db!.query(`SELECT 1 FROM workspace_suspension WHERE organization_id = $1`, [owner.orgId])).toHaveLength(0);
    // listed, but no two-factor authentication yet
    forbidden(await operatorCall(operator, "/workspaces"));
    await db!.query(`UPDATE "user" SET two_factor_enabled = true WHERE id = $1`, [operator.id]);
    // with two-factor, but not listed (empty variable: no operators at all)
    forbidden(await operatorCall(operator, "/workspaces", { env: { MONTRAL_OPERATOR_USER_IDS: "" } }));
    forbidden(await operatorCall(operator, "/workspaces", { env: { MONTRAL_OPERATOR_USER_IDS: outsider.id } }));
    // the operator's own API key is not an operator credential, alone or next to the session cookie
    const opKey = await operator.as("/auth/api-key/create", { method: "POST", body: { name: "operator-key", metadata: { organizationId: operator.orgId } } });
    expect(opKey.status).toBe(200);
    forbidden(await operatorCall(null, "/workspaces", { headers: { "x-api-key": opKey.body.key } }));
    forbidden(await operatorCall(null, "/workspaces", { headers: { authorization: `Bearer ${opKey.body.key}` } }));
    forbidden(await operatorCall(operator, "/workspaces", { headers: { "x-api-key": opKey.body.key } }));
    // a write from another site is refused even with the operator's cookie
    forbidden(await operatorCall(operator, `/workspaces/${owner.orgId}/suspend`, { method: "POST", headers: { origin: "https://evil.example" }, body: { reason: "abuse" } }));

    // ── list and search ─────────────────────────────────────────────────────────────────────────────────────────
    const listed = await operatorCall(operator, `/workspaces?q=${encodeURIComponent(owner.email)}`);
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    expect(listed.body.workspaces).toEqual([expect.objectContaining({ id: owner.orgId, memberCount: 1, monitorCount: 1, ownerEmail: owner.email, suspended: false, plan: null })]);
    const page1 = await operatorCall(operator, "/workspaces?limit=1");
    expect(page1.body.workspaces).toHaveLength(1);
    expect(typeof page1.body.next).toBe("string");
    const page2 = await operatorCall(operator, `/workspaces?limit=1&cursor=${page1.body.next}`);
    expect(page2.status).toBe(200);
    expect(page2.body.workspaces[0].id).not.toBe(page1.body.workspaces[0].id);
    expect((await operatorCall(operator, "/workspaces?cursor=not-a-cursor")).status).toBe(400);
    expect((await operatorCall(operator, "/workspaces?q=" + "x".repeat(101))).status).toBe(400);
    expect((await operatorCall(operator, "/workspaces/does-not-exist")).status).toBe(404);
    const before = await operatorCall(operator, `/workspaces/${owner.orgId}`);
    expect(before.body).toMatchObject({ id: owner.orgId, suspended: false, suspension: null, usage: { credits: null, emails: null } });

    // ── suspend ─────────────────────────────────────────────────────────────────────────────────────────────────
    expect((await operatorCall(operator, `/workspaces/${owner.orgId}/suspend`, { method: "POST", body: { reason: "because" } })).status).toBe(400);
    expect((await operatorCall(operator, `/workspaces/${owner.orgId}/suspend`, { method: "POST", body: { reason: "abuse", note: "x".repeat(501) } })).status).toBe(400);
    expect((await operatorCall(operator, `/workspaces/nope/suspend`, { method: "POST", body: { reason: "abuse" } })).status).toBe(404);
    const NOTE = "internal ticket 4711: phishing kit";
    const suspended = await operatorCall(operator, `/workspaces/${owner.orgId}/suspend`, { method: "POST", body: { reason: "abuse", note: NOTE } });
    expect(suspended.status).toBe(200);
    expect(suspended.body).toEqual({ id: owner.orgId, suspended: true, reason: "abuse" });
    const detail = await operatorCall(operator, `/workspaces/${owner.orgId}`);
    expect(detail.body).toMatchObject({ suspended: true, suspension: { reason: "abuse", note: NOTE, suspendedBy: operator.id } });

    // the member API refuses sessions and API keys alike, reads and writes
    for (const r of [await owner.as("/monitors"), await owner.as("/me"), await owner.as("/monitors", { method: "POST", body: { name: "x", type: "heartbeat", intervalSec: 3600 } }), await withKey("/monitors")]) {
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("workspace_suspended");
      expect(r.text).not.toContain(NOTE);
    }
    // other workspaces are untouched
    expect((await other.as("/monitors")).status).toBe(200);

    // the scheduler does not claim the suspended workspace's monitors: the earliest due monitor is skipped
    await db!.query(`UPDATE monitor SET paused = false, next_check_at = '1970-01-01T00:00:00Z' WHERE id = $1::uuid`, [monitor.body.id]);
    await db!.query(`UPDATE monitor SET paused = false, next_check_at = '1970-01-01T00:00:01Z' WHERE id = $1::uuid`, [otherMonitor.body.id]);
    expect((await db!.repo.claimDue(1)).map((m) => m.id)).toEqual([otherMonitor.body.id]);
    await db!.query(`UPDATE monitor SET next_check_at = now() + interval '30 days' WHERE id = $1::uuid`, [otherMonitor.body.id]);

    // webhook capture is refused before anything is stored; a wrong secret still gets the plain 404
    expect((await deliver()).status).toBe(403);
    expect((await deliver()).body.code).toBe("workspace_suspended");
    expect(await storedEvents()).toBe(0);
    expect((await fetchJson(hooksApp, inbox.body.path.slice(0, -1) + (inbox.body.path.endsWith("0") ? "1" : "0"), { method: "POST", body: "{}" })).status).toBe(404);

    // heartbeats are not recorded
    expect((await fetchJson(app, `/api/heartbeat/${heartbeat}`, { method: "POST" })).status).toBe(403);

    // the public status page, its summary and its feeds do not exist while suspended
    for (const path of ["", "/summary", "/rss.xml", "/maintenance.ics"]) {
      expect((await fetchJson(app, `/api/public/status/${slug}${path}`)).status, path).toBe(404);
    }
    // the badge answers like it does for a page that does not exist: "unknown"
    const badge = await fetchJson(app, `/api/public/status/${slug}/badge.svg`);
    expect(badge.text).toContain("unknown");
    expect(badge.text).not.toContain(">operational<");
    expect((await fetchJson(app, `/api/public/status/${slug}/subscribe`, { method: "POST", body: { email: "visitor@example.com" } })).status).toBe(404);

    // ── unsuspend restores everything; the data was kept ────────────────────────────────────────────────────────
    expect((await operatorCall(outsider, `/workspaces/${owner.orgId}/unsuspend`, { method: "POST" })).status).toBe(403);
    const restored = await operatorCall(operator, `/workspaces/${owner.orgId}/unsuspend`, { method: "POST" });
    expect(restored.status).toBe(200);
    expect(restored.body).toEqual({ id: owner.orgId, suspended: false });
    const monitors = await owner.as("/monitors");
    expect(monitors.status).toBe(200);
    expect(JSON.stringify(monitors.body)).toContain(monitor.body.id);
    expect((await withKey("/monitors")).status).toBe(200);
    expect((await db!.repo.claimDue(1)).map((m) => m.id)).toEqual([monitor.body.id]);
    expect((await deliver()).status).toBe(202);
    expect(await storedEvents()).toBe(1);
    expect((await fetchJson(app, `/api/public/status/${slug}`)).status).toBe(200);
    expect((await fetchJson(app, `/api/heartbeat/${heartbeat}`, { method: "POST" })).status).toBe(200);
    // unsuspending again changes and records nothing
    expect((await operatorCall(operator, `/workspaces/${owner.orgId}/unsuspend`, { method: "POST" })).status).toBe(200);

    // ── the customer sees both actions in their own audit log, attributed to the operator role, without the note ──
    const audit = await owner.as("/audit-events?action=workspace&limit=50");
    expect(audit.status).toBe(200);
    const events = audit.body.events as { action: string; actorType: string; actorId: string | null; actorLabel: string; changes: any; targetId: string }[];
    expect(events.map((e) => e.action).sort()).toEqual(["workspace.suspend", "workspace.unsuspend"]);
    for (const e of events) {
      expect(e).toMatchObject({ actorType: "system", actorId: null, actorLabel: "Montral operator", targetId: owner.orgId, changes: { values: { reason: "abuse" } } });
    }
    expect(audit.text).not.toContain(NOTE);
    expect(audit.text).not.toContain(operator.id);
    // nothing about the operator plane reached the other workspace's log
    expect((await other.as("/audit-events?action=workspace")).body.events).toEqual([]);
  });
});
