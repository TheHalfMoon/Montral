import { openDatabase } from "@montral/db-pg";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { deliverDomainNotices } from "./domain-notice";
import { montralEdition } from "./montral-edition";
import { migrateMontralSchema } from "./schema-migrate";

// Runs only when TEST_DATABASE_URL points at a database (shared with the other end-to-end tests).
const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "operator-e2e-only-secret-not-for-production", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin };
const PASSWORD = "correct horse battery staple";

type Res = { status: number; body: any; text: string; headers: Headers };

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) from the base32 secret of an otpauth:// URI. */
function totp(uri: string, at = Date.now()): string {
  const secret = new URL(uri).searchParams.get("secret")!.replace(/=+$/, "").toUpperCase();
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** Cookie jar: later Set-Cookie headers replace earlier values; an emptied cookie is dropped. */
function jar(current: string, res: Res): string {
  const map = new Map(current.split("; ").filter(Boolean).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)] as const));
  for (const c of res.headers.getSetCookie()) {
    const kv = c.split(";")[0];
    const name = kv.slice(0, kv.indexOf("="));
    const value = kv.slice(kv.indexOf("=") + 1);
    if (!value || /max-age=0/i.test(c)) map.delete(name);
    else map.set(name, value);
  }
  return [...map].map(([k, v]) => `${k}=${v}`).join("; ");
}

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
  const authCall = (cookie: string, path: string, body?: unknown, method = "POST") =>
    fetchJson(app, `/api/auth${path}`, { method, headers: { origin, ...(cookie ? { cookie } : {}) }, body });
  async function account(name: string) {
    const email = `${name}-${crypto.randomUUID()}@example.com`;
    const su = await fetchJson(app, "/api/auth/sign-up/email", { method: "POST", headers: { origin }, body: { email, name, password: PASSWORD } });
    expect(su.status).toBe(200);
    const cookie = jar("", su);
    const id = su.body.user.id as string;
    const as = (path: string, init: Parameters<typeof fetchJson>[2] = {}) =>
      fetchJson(app, `/api${path}`, { ...init, headers: { origin, cookie, ...(init.headers ?? {}) } });
    const orgId = (await as("/me")).body.organization.id as string;
    return { email, id, cookie, orgId, as };
  }

  it("admits only operators signed in with a second factor, suspends a workspace everywhere and restores it", async () => {
    const operator = await account("operator");
    const outsider = await account("not-operator");
    const owner = await account("customer-owner");
    const other = await account("customer-other");
    const ops = { MONTRAL_OPERATOR_USER_IDS: ` ${operator.id} , ` };

    // ── the customer's workspace: a monitor, a status page, API key, webhook inbox and on-call calendar link ────────
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
    const calendar = await owner.as("/oncall/calendar", { method: "POST" });
    expect(calendar.status).toBe(201);
    const calendarPath = new URL(calendar.body.url).pathname;
    expect((await fetchJson(app, calendarPath)).status).toBe(200);

    // ── who is an operator ──────────────────────────────────────────────────────────────────────────────────────
    const operatorCall = (cookie: string | null, path: string, init: Parameters<typeof fetchJson>[2] = {}) =>
      fetchJson(app, `/api/operator${path}`, { ...init, headers: { origin, ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) }, env: { ...ops, ...(init.env ?? {}) } });
    const forbidden = (r: Res) => {
      expect(r.status).toBe(403);
      // the refusal is the same for everyone and names nothing
      expect(r.body).toEqual({ error: "Forbidden" });
      expect(r.headers.get("cache-control")).toBe("no-store");
    };
    forbidden(await operatorCall(null, "/workspaces"));
    forbidden(await operatorCall(outsider.cookie, "/workspaces"));
    forbidden(await operatorCall(outsider.cookie, `/workspaces/${owner.orgId}`));
    forbidden(await operatorCall(outsider.cookie, `/workspaces/${owner.orgId}/suspend`, { method: "POST", body: { reason: "abuse" } }));
    expect(await db!.query(`SELECT 1 FROM workspace_suspension WHERE organization_id = $1`, [owner.orgId])).toHaveLength(0);
    // listed, but no two-factor authentication yet
    forbidden(await operatorCall(operator.cookie, "/workspaces"));

    // two-factor is turned on from the sign-up session: the session this mints did NOT pass a second factor at sign-in
    const enabled = await authCall(operator.cookie, "/two-factor/enable", { password: PASSWORD });
    expect(enabled.status).toBe(200);
    const confirmed = await authCall(operator.cookie, "/two-factor/verify-totp", { code: totp(enabled.body.totpURI) });
    expect(confirmed.status).toBe(200);
    const enrolledCookie = jar(operator.cookie, confirmed);
    expect((await db!.query<{ on: boolean }>(`SELECT two_factor_enabled AS on FROM "user" WHERE id = $1`, [operator.id]))[0].on).toBe(true);
    // two-factor enabled, but this session never passed a second factor (like a GitHub, SSO or handoff sign-in): refused
    forbidden(await operatorCall(enrolledCookie, "/workspaces"));
    // a session made without the second factor, even with the flag set directly, is refused
    const plainSession = await authCall("", "/sign-in/email", { email: operator.email, password: PASSWORD });
    expect(plainSession.body.twoFactorRedirect).toBe(true);
    expect(jar("", plainSession)).not.toMatch(/session_token=/);

    // a real second-factor sign-in (password, then a backup code) is recorded and admitted
    const verified = await authCall(jar("", plainSession), "/two-factor/verify-backup-code", { code: enabled.body.backupCodes[0] });
    expect(verified.status).toBe(200);
    const opCookie = jar("", verified);
    expect(opCookie).toMatch(/session_token=/);
    const recorded = await db!.query<{ session_id: string }>(`SELECT m.session_id FROM operator_mfa_session m JOIN session s ON s.id = m.session_id WHERE s.user_id = $1`, [operator.id]);
    expect(recorded).toHaveLength(1);
    expect((await operatorCall(opCookie, "/workspaces")).status).toBe(200);
    // it expires: an old second-factor sign-in no longer counts
    await db!.query(`UPDATE operator_mfa_session SET verified_at = now() - interval '13 hours' WHERE session_id = $1`, [recorded[0].session_id]);
    forbidden(await operatorCall(opCookie, "/workspaces"));
    await db!.query(`UPDATE operator_mfa_session SET verified_at = now() WHERE session_id = $1`, [recorded[0].session_id]);
    // turning two-factor off ends it at once (the session is read fresh, not from the cookie cache)
    await db!.query(`UPDATE "user" SET two_factor_enabled = false WHERE id = $1`, [operator.id]);
    forbidden(await operatorCall(opCookie, "/workspaces"));
    await db!.query(`UPDATE "user" SET two_factor_enabled = true WHERE id = $1`, [operator.id]);
    // with two-factor, but not listed (empty variable: no operators at all)
    forbidden(await operatorCall(opCookie, "/workspaces", { env: { MONTRAL_OPERATOR_USER_IDS: "" } }));
    forbidden(await operatorCall(opCookie, "/workspaces", { env: { MONTRAL_OPERATOR_USER_IDS: outsider.id } }));
    // the operator's own API key is not an operator credential, alone or next to the session cookie
    const opKey = await authCall(opCookie, "/api-key/create", { name: "operator-key", metadata: { organizationId: operator.orgId } });
    expect(opKey.status).toBe(200);
    forbidden(await operatorCall(null, "/workspaces", { headers: { "x-api-key": opKey.body.key } }));
    forbidden(await operatorCall(null, "/workspaces", { headers: { authorization: `Bearer ${opKey.body.key}` } }));
    forbidden(await operatorCall(opCookie, "/workspaces", { headers: { "x-api-key": opKey.body.key } }));
    // a write from another site is refused even with the operator's cookie
    forbidden(await operatorCall(opCookie, `/workspaces/${owner.orgId}/suspend`, { method: "POST", headers: { origin: "https://evil.example" }, body: { reason: "abuse" } }));

    // ── list and search ─────────────────────────────────────────────────────────────────────────────────────────
    const listed = await operatorCall(opCookie, `/workspaces?q=${encodeURIComponent(owner.email)}`);
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    expect(listed.body.workspaces).toEqual([expect.objectContaining({ id: owner.orgId, memberCount: 1, monitorCount: 1, ownerEmail: owner.email, suspended: false, plan: null })]);
    const page1 = await operatorCall(opCookie, "/workspaces?limit=1");
    expect(page1.body.workspaces).toHaveLength(1);
    expect(typeof page1.body.next).toBe("string");
    const page2 = await operatorCall(opCookie, `/workspaces?limit=1&cursor=${page1.body.next}`);
    expect(page2.status).toBe(200);
    expect(page2.body.workspaces[0].id).not.toBe(page1.body.workspaces[0].id);
    expect((await operatorCall(opCookie, "/workspaces?cursor=not-a-cursor")).status).toBe(400);
    expect((await operatorCall(opCookie, "/workspaces?q=" + "x".repeat(101))).status).toBe(400);
    expect((await operatorCall(opCookie, "/workspaces/does-not-exist")).status).toBe(404);
    const before = await operatorCall(opCookie, `/workspaces/${owner.orgId}`);
    expect(before.body).toMatchObject({ id: owner.orgId, suspended: false, suspension: null, usage: { credits: null, emails: null } });

    // ── suspend ─────────────────────────────────────────────────────────────────────────────────────────────────
    expect((await operatorCall(opCookie, `/workspaces/${owner.orgId}/suspend`, { method: "POST", body: { reason: "because" } })).status).toBe(400);
    expect((await operatorCall(opCookie, `/workspaces/${owner.orgId}/suspend`, { method: "POST", body: { reason: "abuse", note: "x".repeat(501) } })).status).toBe(400);
    expect((await operatorCall(opCookie, `/workspaces/nope/suspend`, { method: "POST", body: { reason: "abuse" } })).status).toBe(404);
    const NOTE = "internal ticket 4711: phishing kit";
    const suspended = await operatorCall(opCookie, `/workspaces/${owner.orgId}/suspend`, { method: "POST", body: { reason: "abuse", note: NOTE } });
    expect(suspended.status).toBe(200);
    expect(suspended.body).toEqual({ id: owner.orgId, suspended: true, reason: "abuse" });
    const detail = await operatorCall(opCookie, `/workspaces/${owner.orgId}`);
    expect(detail.body).toMatchObject({ suspended: true, suspension: { reason: "abuse", note: NOTE, suspendedBy: operator.id } });

    // the member API refuses sessions and API keys alike, reads and writes
    for (const r of [await owner.as("/monitors"), await owner.as("/me"), await owner.as("/monitors", { method: "POST", body: { name: "x", type: "heartbeat", intervalSec: 3600 } }), await withKey("/monitors")]) {
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("workspace_suspended");
      expect(r.text).not.toContain(NOTE);
    }
    // other workspaces are untouched
    expect((await other.as("/monitors")).status).toBe(200);

    // Better Auth's own workspace endpoints: no invitations, renames, deletion, new or changed keys, account deletion
    // switching to the suspended workspace is allowed (and makes it the session's active workspace, which Better Auth
    // falls back to when a call names no organizationId)
    const activated = await authCall(owner.cookie, "/organization/set-active", { organizationId: owner.orgId });
    expect(activated.status).toBe(200);
    const ownerCookie = jar(owner.cookie, activated);
    const refusedAuth = async (path: string, body: unknown, status = 403) => {
      const r = await authCall(ownerCookie, path, body);
      expect(r.status, path).toBe(status);
      if (status === 403) expect(r.body?.code, path).toBe("workspace_suspended");
    };
    const invitee = () => `invitee-${crypto.randomUUID()}@example.com`;
    const invitations = async () => (await db!.query(`SELECT 1 FROM invitation WHERE organization_id = $1`, [owner.orgId])).length;
    const name = async () => (await db!.query<{ name: string }>(`SELECT name FROM organization WHERE id = $1`, [owner.orgId]))[0].name;
    const nameBefore = await name();
    await refusedAuth("/organization/invite-member", { organizationId: owner.orgId, email: invitee(), role: "member" });
    await refusedAuth("/organization/invite-member", { email: invitee(), role: "member" });
    await refusedAuth("/organization/update", { organizationId: owner.orgId, data: { name: "Renamed while suspended" } });
    await refusedAuth("/organization/update", { data: { name: "Renamed via active workspace" } });
    // decoy fields that Better Auth ignores never replace the active workspace: a real slug or invitation of another
    // workspace adds that workspace to the check, the active one is still checked; an unknown one is refused outright
    const [{ slug: otherSlug }] = await db!.query<{ slug: string }>(`SELECT slug FROM organization WHERE id = $1`, [other.orgId]);
    const otherInvite = await authCall(other.cookie, "/organization/invite-member", { organizationId: other.orgId, email: invitee(), role: "member" });
    expect(otherInvite.status).toBe(200);
    await refusedAuth("/organization/invite-member", { email: invitee(), role: "member", organizationSlug: otherSlug });
    await refusedAuth("/organization/invite-member", { email: invitee(), role: "member", invitationId: otherInvite.body.id });
    await refusedAuth("/organization/invite-member", { email: invitee(), role: "member", organizationSlug: `nope-${crypto.randomUUID()}` }, 400);
    await refusedAuth("/organization/invite-member?invitationId=missing", { email: invitee(), role: "member" }, 400);
    await refusedAuth("/organization/update", { data: { name: "Renamed via decoy slug" }, organizationSlug: otherSlug });
    await refusedAuth("/organization/update", { data: { name: "Renamed via decoy invitation" }, invitationId: otherInvite.body.id });
    await refusedAuth("/organization/update", { data: { name: "Renamed via unknown slug" }, organizationSlug: `nope-${crypto.randomUUID()}` }, 400);
    await refusedAuth("/organization/update?invitationId=missing", { data: { name: "Renamed via unknown invitation" } }, 400);
    expect(await invitations()).toBe(0);
    expect(await name()).toBe(nameBefore);
    await refusedAuth("/organization/delete", { organizationId: owner.orgId });
    await refusedAuth("/api-key/create", { name: "while-suspended", metadata: { organizationId: owner.orgId } });
    await refusedAuth("/api-key/update", { keyId: key.body.id, name: "renamed-while-suspended" });
    await refusedAuth("/delete-user", { password: PASSWORD });
    expect(await db!.query(`SELECT 1 FROM "user" WHERE id = $1`, [owner.id])).toHaveLength(1);
    expect(await db!.query(`SELECT 1 FROM organization WHERE id = $1`, [owner.orgId])).toHaveLength(1);
    // nor can anything delete it by cascade while the suspension stands
    await expect(db!.query(`DELETE FROM organization WHERE id = $1`, [owner.orgId])).rejects.toThrow();
    expect(await db!.query(`SELECT 1 FROM workspace_suspension WHERE organization_id = $1`, [owner.orgId])).toHaveLength(1);
    // reading, switching and listing workspaces still work
    expect((await authCall(ownerCookie, "/organization/set-active", { organizationId: owner.orgId })).status).toBe(200);
    expect((await authCall(ownerCookie, "/organization/list", undefined, "GET")).status).toBe(200);

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

    // heartbeats are not recorded; the on-call calendar feed is not served
    expect((await fetchJson(app, `/api/heartbeat/${heartbeat}`, { method: "POST" })).status).toBe(403);
    expect((await fetchJson(app, calendarPath)).status).toBe(404);

    // the public status page, its summary and its feeds do not exist while suspended
    for (const path of ["", "/summary", "/rss.xml", "/maintenance.ics", "/incidents", "/llms.txt"]) {
      expect((await fetchJson(app, `/api/public/status/${slug}${path}`)).status, path).toBe(404);
    }
    // the badge answers like it does for a page that does not exist: "unknown"
    const badge = await fetchJson(app, `/api/public/status/${slug}/badge.svg`);
    expect(badge.text).toContain("unknown");
    expect((await fetchJson(app, `/api/public/status/${slug}/subscribe`, { method: "POST", body: { email: "visitor@example.com" } })).status).toBe(404);

    // ── unsuspend restores everything; the data was kept ────────────────────────────────────────────────────────
    expect((await operatorCall(outsider.cookie, `/workspaces/${owner.orgId}/unsuspend`, { method: "POST" })).status).toBe(403);
    const restored = await operatorCall(opCookie, `/workspaces/${owner.orgId}/unsuspend`, { method: "POST" });
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
    expect((await fetchJson(app, calendarPath)).status).toBe(200);
    expect((await authCall(owner.cookie, "/api-key/update", { keyId: key.body.id, name: "renamed-after" })).status).toBe(200);
    // unsuspending again changes and records nothing
    expect((await operatorCall(opCookie, `/workspaces/${owner.orgId}/unsuspend`, { method: "POST" })).status).toBe(200);

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

  it("leaves suspended workspaces out of every scheduled claim (alerts, retries, reminders, escalations, mails, reports)", async () => {
    const owner = await account("claims-owner");
    // two workspaces seeded directly; ids sort before any generated id, so the ordered claims meet them first
    const tag = crypto.randomUUID().slice(0, 8);
    const S = `00000000-opS-${tag}`; // suspended
    const T = `00000000-opT-${tag}`; // active, otherwise identical
    const seed = async (org: string) => {
      await db!.query(`INSERT INTO organization (id, name, slug, created_at) VALUES ($1, $1, lower($1), now())`, [org]);
      await db!.query(`INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ($1 || '-m', $1, $2, 'owner', now())`, [org, owner.id]);
      const [p] = await db!.query<{ id: string }>(`INSERT INTO project (organization_id, name, reminder_interval_min) VALUES ($1, 'P', 5) RETURNING id`, [org]);
      const [m] = await db!.query<{ id: string }>(
        `INSERT INTO monitor (organization_id, project_id, name, target, type, paused, next_check_at) VALUES ($1, $2::uuid, 'M', 'https://example.com', 'browser', false, now() + interval '30 days') RETURNING id`,
        [org, p.id],
      );
      monitorIds.push(m.id);
      return { project: p.id, monitor: m.id };
    };
    const s = await seed(S);
    const t = await seed(T);
    try {
      await db!.query(`INSERT INTO workspace_suspension (organization_id, reason) VALUES ($1, 'operator')`, [S]);
      const at = (org: string) => (org === S ? "1970-01-01T00:00:00Z" : "1970-01-01T00:00:01Z");

      // claimDelivery: a queued alert of the suspended workspace is not claimed
      const queued = async (org: string, next: string | null) =>
        (await db!.query<{ id: string }>(
          `INSERT INTO alert_delivery (organization_id, channel_name, channel_type, kind, ok, status, attempts, next_attempt_at) VALUES ($1, 'c', 'email', 'incident.opened', false, 'pending', 0, $2::timestamptz) RETURNING id`,
          [org, next],
        ))[0].id;
      expect(await db!.repo.claimDelivery(await queued(S, null))).toBeNull();
      expect((await db!.repo.claimDelivery(await queued(T, null)))?.organizationId).toBe(T);

      // claimRetries: the earliest due retry belongs to the suspended workspace and is passed over
      const retryS = await queued(S, at(S));
      const retryT = await queued(T, at(T));
      await db!.repo.claimRetries(1);
      const status = async (id: string) => (await db!.query<{ status: string }>(`SELECT status FROM alert_delivery WHERE id = $1::uuid`, [id]))[0].status;
      expect(await status(retryS)).toBe("pending");
      expect(await status(retryT)).not.toBe("pending");

      // claimReminders and claimEscalations: the earliest due incident belongs to the suspended workspace
      const incident = async (org: string, ids: { project: string; monitor: string }) =>
        (await db!.query<{ id: string }>(
          `INSERT INTO incident (organization_id, project_id, monitor_id, title, next_reminder_at, next_escalation_at) VALUES ($1, $2::uuid, $3::uuid, 'down', $4::timestamptz, $4::timestamptz) RETURNING id`,
          [org, ids.project, ids.monitor, at(org)],
        ))[0].id;
      const incS = await incident(S, s);
      const incT = await incident(T, t);
      expect((await db!.repo.claimReminders(1)).map((r) => r.incident.id)).toEqual([incT]);
      await db!.repo.claimEscalations(1);
      const inc = async (id: string) => (await db!.query<{ reminder_count: number; escalation_level: number }>(`SELECT reminder_count, escalation_level FROM incident WHERE id = $1::uuid`, [id]))[0];
      expect(await inc(incS)).toEqual({ reminder_count: 0, escalation_level: 0 });
      expect((await inc(incT)).escalation_level).toBe(1);

      // claimMaintenanceReminders: a followed status page of each, a window starting within the reminder period
      const window = async (org: string) => {
        const [page] = await db!.query<{ id: string }>(
          `INSERT INTO status_page (organization_id, slug, title, maintenance_reminder_hours) VALUES ($1, lower($1) || '-p', 'Page', 24) RETURNING id`, [org]);
        await db!.query(`INSERT INTO status_subscriber (status_page_id, email, token, confirmed_at) VALUES ($1::uuid, $2, $3, now())`, [page.id, `sub-${crypto.randomUUID()}@example.com`, crypto.randomUUID()]);
        const [w] = await db!.query<{ id: string }>(
          `INSERT INTO maintenance_window (organization_id, name, starts_at, ends_at) VALUES ($1, 'Upgrade', now() + interval '1 hour', now() + interval '2 hours') RETURNING id`, [org]);
        return { id: w.id, page: page.id };
      };
      const { id: wS, page: pageS } = await window(S);
      const { id: wT, page: pageT } = await window(T);
      const claimedWindows = (await db!.repo.claimMaintenanceReminders(500)).map((r) => r.window.id);
      expect(claimedWindows).toContain(wT);
      expect(claimedWindows).not.toContain(wS);
      expect(await db!.query(`SELECT 1 FROM maintenance_reminder WHERE maintenance_id = $1::uuid`, [wS])).toHaveLength(0);

      // custom-domain notices: a queued notice of each page; only the active workspace's is claimed for sending
      const notice = async (org: string, page: string) =>
        (await db!.query<{ id: string }>(
          `INSERT INTO alert_delivery (organization_id, channel_name, channel_type, kind, ok, status, attempts, target_user_id, status_page_id, monitor_name)
           VALUES ($1, 'o', 'email', 'domain.failing', false, 'pending', 0, $2, $3::uuid, 'status.example.com') RETURNING id`,
          [org, owner.id, page],
        ))[0].id;
      const noticeS = await notice(S, pageS);
      const noticeT = await notice(T, pageT);
      await deliverDomainNotices((sql, params) => db!.query(sql, params), { pageIds: [pageS, pageT] });
      const claimedAt = async (id: string) => (await db!.query<{ claimed_at: Date | null; status: string }>(`SELECT claimed_at, status FROM alert_delivery WHERE id = $1::uuid`, [id]))[0];
      expect(await claimedAt(noticeS)).toEqual({ claimed_at: null, status: "pending" });
      expect((await claimedAt(noticeT)).claimed_at).not.toBeNull();

      // pendingUncheckedDigests: both browser monitors went unchecked; only the active workspace gets a digest
      await db!.query(`UPDATE monitor SET unchecked_since = now(), unchecked_notified_at = NULL WHERE id = ANY(string_to_array($1::text, ',')::uuid[])`, [`${s.monitor},${t.monitor}`]);
      const digests = (await db!.repo.pendingUncheckedDigests!()).map((d) => d.organizationId);
      expect(digests).toContain(T);
      expect(digests).not.toContain(S);

      // monthly reports, legacy and with recipients: both workspaces opted in; the first by id is the suspended one
      await db!.query(`INSERT INTO workspace_setting (organization_id, monthly_report) VALUES ($1, true), ($2, true)`, [S, T]);
      const month = `19${String(10 + Math.floor(Math.random() * 89)).padStart(2, "0")}-0${1 + Math.floor(Math.random() * 9)}`;
      expect(await db!.repo.claimMonthlyReports(month, 1)).toEqual([T]);
      await db!.query(`UPDATE workspace_setting SET last_report_month = NULL WHERE organization_id = $1`, [T]);
      const month2 = month.replace(/^19/, "18");
      expect(await db!.repo.claimMonthlyReportsWithRecipients(month2, 1)).toEqual([T]);
    } finally {
      await db!.query(`DELETE FROM workspace_suspension WHERE organization_id = $1`, [S]);
      await db!.query(`DELETE FROM organization WHERE id = ANY(string_to_array($1::text, ','))`, [`${S},${T}`]).catch(() => {});
    }
  });
});
