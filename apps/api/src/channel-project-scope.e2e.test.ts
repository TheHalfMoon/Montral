import { openDatabase } from "@montral/db-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin, CRON_SECRET: "cron", TRUST_PROXY: "true" };
describe.skipIf(!url)("project channel authority", () => {
  const app = createApp(openDatabase);
  // This independent synthetic client must not consume the shared unknown-peer signup quota of other suites.
  const clientIp = `2001:db8:71:${crypto.randomUUID().slice(0, 4)}::1`;
  let cookie: string, key: string, org: string, a: string, b: string;
  let own: string, shared: string, hidden: string, foreign: string;
  const db = url ? openDatabase(url) : undefined;
  async function request(method: string, path: string, body?: unknown, project?: string, scoped = false) {
    const response = await app.fetch(new Request(`${origin}${path}`, {
      method, headers: { "content-type": "application/json", "x-forwarded-for": clientIp, ...(scoped ? { "x-api-key": key } : { cookie }), ...(project ? { "x-project-id": project } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env as never);
    return { status: response.status, body: await response.json().catch(() => null) as any, response };
  }
  const monitor = async (project: string, channelIds: string[] = []) => request("POST", "/api/monitors", { name: "Scope control", type: "heartbeat", intervalSec: 86400, channelIds }, project);
  beforeAll(async () => {
    const migrated = await app.fetch(new Request(`${origin}/internal/migrate`, { method: "POST", headers: { "x-cron-secret": "cron" } }), env as never);
    expect(migrated.status).toBe(200);
    const signup = await request("POST", "/api/auth/sign-up/email", { email: `channel-scope-${crypto.randomUUID()}@example.com`, password: "correct horse battery", name: "Scope owner" });
    expect(signup.status).toBe(200);
    cookie = signup.response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const workspace = (await request("GET", "/api/workspaces")).body.workspaces[0];
    org = workspace.id; a = workspace.projects[0].id;
    b = (await request("POST", "/api/projects", { name: "Other project" })).body.id;
    for (const [name, scope, project] of [["Own", "project", a], ["Shared", "workspace", a], ["Hidden", "project", b]]) {
      const result = await request("POST", "/api/channels", { type: "email", name, config: { to: "scope@example.com" }, scope }, project);
      expect(result.status, JSON.stringify(result.body)).toBe(201);
      if (name === "Own") own = result.body.id;
      if (name === "Shared") shared = result.body.id;
      if (name === "Hidden") hidden = result.body.id;
    }
    // A UUID outside this workspace is indistinguishable from an absent channel.
    foreign = crypto.randomUUID();
    const created = await request("POST", "/api/auth/api-key/create", { name: "Project A", metadata: { organizationId: org, projectIds: [a] } });
    expect(created.status).toBe(200); key = created.body.key;
  });
  afterAll(async () => {
    if (org) await db!.query('update monitor set paused = true where organization_id = $1', [org]);
    await db?.close();
  });
  it("rejects hidden, missing and mixed references on creation", async () => {
    for (const ids of [[hidden], [foreign], [own, hidden]]) {
      const r = await monitor(a, ids);
      expect(r.status).toBe(400); expect(r.body.code).toBe("invalid_channel");
    }
    expect((await monitor(a, [own, shared, own])).status).toBe(201);
  });
  it("uses the stored project on PATCH, permits clearing and unrelated legacy edits", async () => {
    const created = await monitor(a); expect(created.status).toBe(201);
    const id = created.body.id;
    expect((await request("PATCH", `/api/monitors/${id}`, { channelIds: [hidden] }, b)).status).toBe(400);
    expect((await request("PATCH", `/api/monitors/${id}`, { channelIds: [own, shared] }, b)).status).toBe(200);
    await db!.query('update monitor set channel_ids = $1::uuid[] where id = $2', [`{${hidden}}`, id]);
    expect((await request("PATCH", `/api/monitors/${id}`, { name: "Legacy renamed" }, a)).status).toBe(200);
    expect((await request("PATCH", `/api/monitors/${id}`, { channelIds: [] }, a)).status).toBe(200);
  });
  it("does not disclose consumers or mutate channels outside a scoped key's write authority", async () => {
    const legacy = await monitor(b); expect(legacy.status).toBe(201);
    await db!.query('update monitor set channel_ids = $1::uuid[] where id = $2', [`{${hidden},${shared},${own}}`, legacy.body.id]);
    for (const id of [hidden, shared]) {
      const r = await request("DELETE", `/api/channels/${id}`, undefined, a, true);
      expect(r.status).toBe(204);
      expect(await db!.repo.getChannel(org, id, null)).not.toBeNull();
    }
    const limited = await request("DELETE", `/api/channels/${own}`, undefined, a, true);
    expect(limited.status).toBe(409);
    expect(limited.body).toEqual({ error: "This channel is still used by monitors. Remove their channel references before deleting it.", code: "channel_in_use" });
    const owner = await request("DELETE", `/api/channels/${own}`, undefined, a);
    expect(owner.status).toBe(409);
    expect(owner.body.monitors).toContainEqual({ id: legacy.body.id, name: "Scope control" });
  });
  it("filters explicit and default repository recipients by the event project", async () => {
    const selected = await db!.repo.channelsToAlert(org, { projectId: a, channelIds: [own, shared, hidden] });
    expect(selected.map((c) => c.id).sort()).toEqual([own, shared].sort());
    const legacy = await db!.repo.channelsToAlert(org, { channelIds: [own, shared, hidden] });
    expect(legacy.map((c) => c.id)).toEqual([shared]);
  });
});
