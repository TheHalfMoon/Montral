import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "./env";
import { forgetProjects, requireOrg } from "./middleware";

const organizations: string[] = [];
afterEach(() => { for (const id of organizations.splice(0)) forgetProjects(id); vi.useRealTimers(); });

function harness(options: { scoped?: boolean } = {}) {
  const orgId = `cache-${crypto.randomUUID()}`;
  organizations.push(orgId);
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  let member = true;
  const resolveProject = vi.fn(async (_org: string, wanted?: string) => wanted?.toLowerCase() === second ? second : first);
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("repo", { isMember: async () => member, resolveProject } as never);
    c.set("database", { query: async () => [] } as never);
    c.set("auth", { api: {
      getSession: async () => options.scoped ? null : ({ user: { id: "user", emailVerified: true }, session: { id: "session", activeOrganizationId: orgId } }),
      verifyApiKey: async () => ({ valid: true, key: { id: "key", referenceId: "user", metadata: { organizationId: orgId, projectIds: [second] } } }),
    } } as never);
    await next();
  });
  app.get("/", requireOrg, (c) => c.json({ projectId: c.get("projectId") }));
  const call = (headers: Record<string, string> = {}) => app.request("http://localhost/", { headers: { ...(options.scoped ? { "x-api-key": "montral_cache_test_key" } : {}), ...headers } }, { BETTER_AUTH_URL: "http://localhost" } as never);
  return { orgId, first, second, resolveProject, call, revoke: () => { member = false; } };
}

describe("project selection cache resource bounds", () => {
  it("canonicalizes arbitrary malformed selectors to the established workspace fallback", async () => {
    const h = harness();
    for (let i = 0; i < 100; i++) {
      const res = await h.call({ "x-project-id": `invalid-${i}-${"x".repeat(1024)}` });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ projectId: h.first });
    }
    expect(h.resolveProject).toHaveBeenCalledTimes(1);
  });

  it("evicts old selections after a bounded number of unique valid UUID misses", async () => {
    const h = harness();
    const ids = Array.from({ length: 1025 }, () => crypto.randomUUID());
    for (const id of ids) expect((await h.call({ "x-project-id": id })).status).toBe(200);
    const count = h.resolveProject.mock.calls.length;
    await h.call({ "x-project-id": ids.at(-1)! });
    expect(h.resolveProject).toHaveBeenCalledTimes(count);
    await h.call({ "x-project-id": ids[0] });
    expect(h.resolveProject).toHaveBeenCalledTimes(count + 1);
  });

  it("keeps scoped credentials' fallback enforcement, header precedence and all-project selection", async () => {
    const h = harness({ scoped: true });
    for (const headers of [{}, { "x-project-id": "all" }, { cookie: "montral_project=%broken" }] as Record<string, string>[]) {
      const res = await h.call(headers);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ projectId: h.second });
    }
    expect((await h.call({ "x-project-id": "invalid", cookie: `montral_project=${h.second}` })).status).toBe(403);
    expect((await h.call({ "x-project-id": crypto.randomUUID() })).status).toBe(403);
    expect((await h.call({ "x-project-id": "" })).status).toBe(403);
    expect((await h.call({ "x-project-id": h.second })).status).toBe(200);
    expect((await h.call({ "x-project-id": h.second.toUpperCase() })).status).toBe(200);
  });

  it("enforces the same capacity when unresolved misses finish concurrently", async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    h.resolveProject.mockImplementation(async () => { await gate; return h.first; });
    const ids = Array.from({ length: 1025 }, () => crypto.randomUUID());
    const pending = ids.map((id) => h.call({ "x-project-id": id }));
    await vi.waitFor(() => expect(h.resolveProject).toHaveBeenCalledTimes(ids.length), { timeout: 5000 });
    release();
    expect((await Promise.all(pending)).every((r) => r.status === 200)).toBe(true);
    await h.call({ "x-project-id": ids[0] });
    expect(h.resolveProject).toHaveBeenCalledTimes(ids.length + 1);
  });

  it("expires answers and invalidates only the requested organization", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const a = harness(); const b = harness();
    await a.call(); await b.call(); await a.call();
    expect(a.resolveProject).toHaveBeenCalledTimes(1);
    forgetProjects(a.orgId);
    await a.call(); await b.call();
    expect(a.resolveProject).toHaveBeenCalledTimes(2);
    expect(b.resolveProject).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 30_001);
    await a.call();
    expect(a.resolveProject).toHaveBeenCalledTimes(3);
  });

  it("never lets a cached answer bypass live membership revocation", async () => {
    const h = harness();
    expect((await h.call()).status).toBe(200);
    h.revoke();
    expect((await h.call()).status).toBe(403);
    expect(h.resolveProject).toHaveBeenCalledTimes(1);
  });
});
