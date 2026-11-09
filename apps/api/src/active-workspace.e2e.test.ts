import { openDatabase } from "@montral/db-pg";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { montralEdition } from "./montral-edition";

// The workspace a signed-in user acts in must not change from one request to the next. Before the fix a fresh
// sign-up's session had no active workspace (Better Auth creates the session before the hook that creates the
// personal workspace), and every request then took "any" membership: the first row PostgreSQL returned, with no
// ORDER BY. Once the user had a second workspace, PostgreSQL could select it instead, and a request naming
// a project of the first workspace silently landed in the second one's default project (oauth-scope.e2e flake).
const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123", BETTER_AUTH_URL: ORIGIN, WEB_ORIGIN: ORIGIN, CRON_SECRET: "cron" };
const JSON_HEADERS = { "content-type": "application/json" };

describe.skipIf(!url)("the active workspace of a session (PostgreSQL)", () => {
  const app = createApp(openDatabase, { edition: montralEdition });
  const req = (path: string, init: RequestInit = {}) => app.fetch(new Request(`${ORIGIN}${path}`, init), env as never);

  it("is the personal workspace from sign-up on, and preserves the fallback for legacy sessions", async () => {
    expect((await req("/internal/migrate", { method: "POST", headers: { "x-cron-secret": "cron" } })).status).toBe(200);
    const db = openDatabase(url!, { max: 2 });
    const orgs: string[] = [];
    try {
      const r = await req("/api/auth/sign-up/email", {
        method: "POST", headers: JSON_HEADERS,
        body: JSON.stringify({ email: `active-${Date.now()}-${randomBytes(3).toString("hex")}@example.com`, password: "correct horse battery", name: "Active" }),
      });
      expect(r.status).toBe(200);
      const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      const as = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
        const res = await req(`/api${path}`, { method, headers: { ...JSON_HEADERS, cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, body: (await res.json().catch(() => null)) as any };
      };
      const userId = (await as("GET", "/me")).body.userId as string;
      const first = (await as("GET", "/workspaces")).body;
      const home = first.workspaces[0] as { id: string; projects: { id: string }[] };
      orgs.push(home.id);
      expect(first.workspaces).toHaveLength(1);
      expect(first.current.workspace).toBe(home.id);

      // the sign-up session now carries the personal workspace itself
      const stored = await db.query<{ active_organization_id: string | null }>("select active_organization_id from session where user_id = $1", [userId]);
      // soft: on failure the run still goes on to prove the second half (a session with no active workspace)
      expect.soft(stored.map((s) => s.active_organization_id)).toEqual([home.id]);

      const other = (await as("POST", "/workspaces", { name: "Second" })).body as { id: string };
      orgs.push(other.id);

      // Simulate a legacy sign-up session whose active workspace was null before the fix.
      // Do not require a particular physical PostgreSQL row order: SQL without ORDER BY has
      // no guaranteed ordering, even after DELETE/INSERT, VACUUM, or an index rebuild.
      // The separate any-workspace unit test deliberately feeds memberships in reverse
      // physical order and verifies that the query explicitly orders them.
      await db.query("update session set active_organization_id = null where user_id = $1", [userId]);

      expect(await db.repo.anyWorkspaceOf(userId)).toBe(home.id);
      for (let i = 0; i < 3; i++) expect((await as("GET", "/workspaces")).body.current.workspace).toBe(home.id);
      // and a write that names the personal workspace's project lands there, not in the second workspace's default
      const inbox = await as("POST", "/hooks/inboxes", { name: "Lands in home" }, { "x-project-id": home.projects[0].id });
      expect(inbox.status).toBe(201);
      const rows = await db.query<{ organization_id: string; project_id: string }>("select organization_id, project_id from montral_hook_inbox where id = $1", [inbox.body.id]);
      expect(rows).toEqual([{ organization_id: home.id, project_id: home.projects[0].id }]);
    } finally {
      for (const id of orgs) {
        await db.query("delete from montral_hook_inbox where organization_id = $1", [id]);
        await db.query("delete from organization where id = $1", [id]);
      }
      await db.close(1);
    }
  }, 30_000);
});
