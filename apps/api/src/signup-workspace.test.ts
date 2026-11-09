import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it } from "vitest";
import { givePersonalWorkspace } from "./auth";

type Row = Record<string, any>;

/**
 * The real Better Auth sign-up endpoint over an in-memory store, wired like Montral's createAuth: the user's
 * create.after hook makes the personal workspace, the session's create.before hook picks the preferred workspace.
 * The fake `query` understands only the one statement givePersonalWorkspace sends.
 */
function harness(afterUserCreated: (user: { id: string; name: string; email: string }, database: any) => Promise<unknown>) {
  const store: Record<string, Row[]> = { user: [], session: [], account: [], verification: [] };
  const members: { userId: string; organizationId: string }[] = [];
  const order: string[] = [];
  const statements: string[] = [];
  const database = {
    repo: {
      createPersonalWorkspace: async (w: { id: string; ownerId: string }) => {
        members.push({ userId: w.ownerId, organizationId: w.id });
      },
    },
    query: async (text: string, params: unknown[] = []) => {
      statements.push(text);
      expect(text).toBe("update session set active_organization_id = $2 where user_id = $1 and active_organization_id is null");
      for (const s of store.session) if (s.userId === params[0] && s.activeOrganizationId == null) s.activeOrganizationId = params[1];
      return [];
    },
  };
  const auth = betterAuth({
    baseURL: "http://localhost:8787",
    secret: "test-secret-test-secret-test-secret-123",
    database: memoryAdapter(store),
    emailAndPassword: { enabled: true },
    session: { additionalFields: { activeOrganizationId: { type: "string", required: false } } },
    databaseHooks: {
      user: { create: { after: async (user) => { order.push("user.create.after"); await afterUserCreated(user as never, database); } } },
      session: {
        create: {
          before: async (session) => {
            order.push("session.create.before");
            const preferred = members.find((m) => m.userId === session.userId)?.organizationId ?? null;
            return { data: { ...session, activeOrganizationId: preferred } };
          },
        },
      },
    },
  });
  const signUp = () => auth.api.signUpEmail({ body: { email: `ada-${crypto.randomUUID()}@example.com`, password: "correct horse battery", name: "ada" } });
  return { store, members, order, statements, database, signUp };
}

describe("the session a sign-up creates", () => {
  it("is created before the user's create.after hook runs, so on its own it finds no workspace (the CI flake's root)", async () => {
    const h = harness(async (user, database) => {
      await database.repo.createPersonalWorkspace({ id: "home", ownerId: user.id });
    });
    await h.signUp();
    expect(h.order).toEqual(["session.create.before", "user.create.after"]);
    expect(h.members).toHaveLength(1);
    expect(h.store.session[0].activeOrganizationId ?? null).toBeNull();
  });

  it("gets the personal workspace as its active workspace once givePersonalWorkspace has run", async () => {
    let made = "";
    const h = harness(async (user, database) => {
      made = await givePersonalWorkspace(database, user);
    });
    await h.signUp();
    expect(h.order).toEqual(["session.create.before", "user.create.after"]);
    expect(made).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.members).toEqual([{ userId: h.store.user[0].id, organizationId: made }]);
    expect(h.store.session).toHaveLength(1);
    expect(h.store.session[0].activeOrganizationId).toBe(made);
    expect(h.statements).toHaveLength(1);
  });

  it("never overrides a workspace a session already has", async () => {
    const h = harness(async () => undefined);
    h.store.session.push({ id: "s1", userId: "u1", activeOrganizationId: "chosen" }, { id: "s2", userId: "u1", activeOrganizationId: null }, { id: "s3", userId: "u2", activeOrganizationId: null });
    await givePersonalWorkspace(h.database as never, { id: "u1", name: "", email: "ada@example.com" });
    expect(h.store.session.map((s) => s.activeOrganizationId)).toEqual(["chosen", h.members[0].organizationId, null]);
  });
});
