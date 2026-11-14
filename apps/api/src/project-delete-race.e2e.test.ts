import { openDatabase } from "@montral/db-pg";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "./app";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("last-project deletion under concurrency", () => {
  const db = url ? openDatabase(url) : undefined;
  let arrivals = 0;
  let release!: () => void;
  const both = new Promise<void>((done) => { release = done; });
  let overlap = false;
  const app = createApp((connection, options) => {
    const database = openDatabase(connection, options);
    return { ...database, repo: { ...database.repo, deleteProject: async (...args: Parameters<typeof database.repo.deleteProject>) => {
      if (overlap) { if (++arrivals === 2) release(); await both; }
      return database.repo.deleteProject(...args);
    } } };
  });
  afterAll(async () => { release(); await db?.close(); });
  it("allows only one of two different project deletions and preserves the final project's data", async () => {
    const origin = "http://localhost:8787";
    const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "synthetic-project-delete-race-secret", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin, TRUST_PROXY: "true" };
    const ip = `2001:db8:73:${crypto.randomUUID().slice(0, 4)}::1`;
    let cookie = "";
    const request = (path: string, method = "GET", body?: unknown) => app.fetch(new Request(origin + path, {
      method, headers: { "content-type": "application/json", "x-forwarded-for": ip, cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env as never);
    const signup = await request("/api/auth/sign-up/email", "POST", { email: `project-race-${crypto.randomUUID()}@example.test`, name: "Project owner", password: "correct horse battery" });
    expect(signup.status).toBe(200);
    cookie = signup.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const me = await (await request("/api/me")).json() as any;
    const first = me.projectId as string;
    const created = await request("/api/projects", "POST", { name: "Second" });
    expect(created.status).toBe(201);
    const second = (await created.json() as any).id as string;
    const org = me.organization.id as string;
    // An unknown ID remains an idempotent no-op while there are multiple projects.
    expect((await request(`/api/projects/${crypto.randomUUID()}`, "DELETE")).status).toBe(204);
    for (const project of [first, second]) await db!.query("insert into monitor (organization_id,project_id,name,type,target,paused) values ($1,$2,'Retained project data','heartbeat','synthetic',true)", [org, project]);
    overlap = true;
    let responses: Response[];
    try { responses = await Promise.all([request(`/api/projects/${first}`, "DELETE"), request(`/api/projects/${second}`, "DELETE")]); }
    finally { overlap = false; release(); }
    expect(responses.map((response) => response.status).sort()).toEqual([204, 400]);
    const [remaining] = await db!.query<{ id: string }>("select id from project where organization_id=$1", [org]);
    expect(await db!.query("select id from project where organization_id=$1", [org])).toHaveLength(1);
    expect(await db!.query("select id from monitor where organization_id=$1 and project_id=$2", [org, remaining.id])).toHaveLength(1);
    expect((await request(`/api/projects/${remaining.id}`, "DELETE")).status).toBe(400);
    expect(await db!.query("select id from monitor where organization_id=$1 and project_id=$2", [org, remaining.id])).toHaveLength(1);
  }, 20_000);
});
