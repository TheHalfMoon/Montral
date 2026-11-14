import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "./env";
import { decodeOperatorCursor, encodeOperatorCursor, decodePlatformAuditCursor, encodePlatformAuditCursor, operatorApi, operatorIds, probeRegionView, requireOperator } from "./operator";
import { recordMfaSignIn } from "./operator-mfa";
import { anySuspended, authCallWorkspaces, isSuspensionReason, suspensionGuardsAuthPath, SUSPENSION_REASONS } from "./suspension";

describe("operator region view", () => {
  it("preserves the identity of the operator who lifted the last drain without mislabelling the current state", () => {
    const lifted = new Date("2026-11-12T05:00:00Z");
    const region = probeRegionView("eu-central", "EU Central", {
      region: "eu-central", drained: false, drainedAt: null, drainedBy: null, drainNote: null,
      lastUndrainedAt: lifted, lastUndrainedBy: "operator-1",
      lastAnswerAt: null, lastUnreachableAt: null, lastUnreachableReason: null, unreachableSince: null,
    }, 3);
    expect(region).toMatchObject({ id: "eu-central", drained: false, drainedBy: null,
      lastUndrainedAt: lifted.toISOString(), lastUndrainedBy: "operator-1", monitors: 3 });
  });
});

describe("operatorIds", () => {
  it("reads a comma-separated list and treats unset or empty as no operators", () => {
    expect([...operatorIds(undefined)]).toEqual([]);
    expect([...operatorIds({})]).toEqual([]);
    expect([...operatorIds({ MONTRAL_OPERATOR_USER_IDS: "" })]).toEqual([]);
    expect([...operatorIds({ MONTRAL_OPERATOR_USER_IDS: " , ,," })]).toEqual([]);
    expect([...operatorIds({ MONTRAL_OPERATOR_USER_IDS: " a1 ,b2,,a1 " })]).toEqual(["a1", "b2"]);
  });
});

describe("operator cursor", () => {
  it("round-trips and refuses anything it did not issue", () => {
    const c = encodeOperatorCursor("2026-11-11T10:00:00.123456", "org_1-x");
    expect(decodeOperatorCursor(c)).toEqual({ at: "2026-11-11T10:00:00.123456", id: "org_1-x" });
    for (const bad of ["", "%%%", btoa("x|y"), encodeOperatorCursor("2026-11-11", "a"), encodeOperatorCursor("2026-11-11T10:00:00.123456", "a b"), btoa("2026-11-11T10:00:00.123456|a|b")]) {
      expect(decodeOperatorCursor(bad)).toBeNull();
    }
  });
});

describe("unified operator audit keyset cursor", () => {
  it("round trips a UTC microsecond timestamp, source and source-specific id", () => {
    const at = "2026-11-13T09:00:00.123456";
    const uuid = "a6789012-2345-4567-89ab-0123456789ab";
    expect(decodePlatformAuditCursor(encodePlatformAuditCursor(at, "workspace", uuid))).toEqual({ at, source: "workspace", id: uuid });
    expect(decodePlatformAuditCursor(encodePlatformAuditCursor(at, "probe", "987654321"))).toEqual({ at, source: "probe", id: "987654321" });
    for (const bad of ["", "%%%", btoa('[]'), btoa('["x","probe","1"]'),
      encodePlatformAuditCursor(at, "workspace", "not-uuid"),
      encodePlatformAuditCursor("2026-02-30T09:00:00.000000", "probe", "1"),
      encodePlatformAuditCursor("2026-11-13T25:00:00.000000", "probe", "1"),
      encodePlatformAuditCursor(at, "probe", "-1"),
      encodePlatformAuditCursor(at, "probe", "0"),
      btoa(JSON.stringify([at, "customer", "1"])),
      btoa(JSON.stringify([at, "probe", "1", "extra"]))])
      expect(decodePlatformAuditCursor(bad)).toBeNull();
  });
});

describe("suspension reasons", () => {
  it("accepts exactly the four reasons", () => {
    expect([...SUSPENSION_REASONS]).toEqual(["abuse", "payment", "legal", "operator"]);
    for (const r of SUSPENSION_REASONS) expect(isSuspensionReason(r)).toBe(true);
    for (const r of ["", "Abuse", "other", null, undefined, 1]) expect(isSuspensionReason(r)).toBe(false);
  });
});

describe("requireOperator", () => {
  const harness = (o: { user?: { id: string } | null; twoFactor?: boolean; mfaSession?: boolean }) => {
    const getSession = vi.fn(async (_: { headers: Headers; query?: { disableCookieCache?: boolean } }) =>
      (o.user ? { user: { ...o.user, emailVerified: true }, session: { id: "s1" } } : null));
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => [{ enabled: o.twoFactor ?? false, verified: o.mfaSession ?? false }]);
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("repo", { withinLimit: async () => true } as never);
      c.set("auth", { api: { getSession } } as never);
      c.set("database", { query } as never);
      await next();
    });
    app.use("*", requireOperator);
    app.get("/x", (c) => c.json({ operator: c.get("operatorId") }));
    app.post("/x", (c) => c.json({ operator: c.get("operatorId") }));
    const call = (env: Record<string, string>, init: RequestInit = {}) => app.fetch(new Request("http://api.test/x", init), { WEB_ORIGIN: "http://web.test", ...env } as never);
    return { call, getSession, query };
  };

  it("admits a listed user whose session came from a second-factor sign-in, reading the session fresh", async () => {
    const h = harness({ user: { id: "op" }, twoFactor: true, mfaSession: true });
    const r = await h.call({ MONTRAL_OPERATOR_USER_IDS: "op" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ operator: "op" });
    expect(r.headers.get("cache-control")).toBe("no-store");
    // never the 5-minute cookie cache
    expect(h.getSession.mock.calls[0][0].query).toEqual({ disableCookieCache: true });
    // the second-factor check is bound to this user and this session
    const mfa = h.query.mock.calls.find(([sql]) => sql.includes("operator_mfa_session"));
    expect(mfa?.[1]).toEqual(["op", "s1"]);
  });

  it("refuses a user with two-factor enabled whose session did not pass a second factor (GitHub, SSO, handoff)", async () => {
    const r = await harness({ user: { id: "op" }, twoFactor: true, mfaSession: false }).call({ MONTRAL_OPERATOR_USER_IDS: "op" });
    expect(r.status).toBe(403);
  });

  it("refuses API keys and bearer tokens before looking at the session", async () => {
    const h = harness({ user: { id: "op" }, twoFactor: true, mfaSession: true });
    for (const headers of [{ "x-api-key": "montral_k" }, { authorization: "Bearer anything" }] as Record<string, string>[]) {
      const r = await h.call({ MONTRAL_OPERATOR_USER_IDS: "op" }, { headers });
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: "Forbidden" });
    }
    expect(h.getSession).not.toHaveBeenCalled();
  });

  it("refuses when no operators are configured, the user is not listed, or two-factor is off", async () => {
    expect((await harness({ user: { id: "op" }, twoFactor: true, mfaSession: true }).call({})).status).toBe(403);
    expect((await harness({ user: { id: "op" }, twoFactor: true, mfaSession: true }).call({ MONTRAL_OPERATOR_USER_IDS: "someone-else" })).status).toBe(403);
    expect((await harness({ user: { id: "op" }, twoFactor: false, mfaSession: true }).call({ MONTRAL_OPERATOR_USER_IDS: "op" })).status).toBe(403);
    expect((await harness({ user: null }).call({ MONTRAL_OPERATOR_USER_IDS: "op" })).status).toBe(403);
  });

  it("refuses cross-origin writes with the operator's cookie", async () => {
    const h = harness({ user: { id: "op" }, twoFactor: true, mfaSession: true });
    expect((await h.call({ MONTRAL_OPERATOR_USER_IDS: "op" }, { method: "POST", headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await h.call({ MONTRAL_OPERATOR_USER_IDS: "op" }, { method: "POST", headers: { origin: "http://web.test" } })).status).toBe(200);
  });

  it("limits per session when the client address is unknown, without one shared bucket", async () => {
    const keys: string[] = [];
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("repo", { withinLimit: async (k: string) => (keys.push(k), true) } as never);
      c.set("auth", { api: { getSession: async () => ({ user: { id: "op" }, session: { id: "s1" } }) } } as never);
      c.set("database", { query: async () => [{ enabled: true, verified: true }] } as never);
      await next();
    });
    app.use("*", requireOperator);
    app.get("/x", (c) => c.text("ok"));
    expect((await app.fetch(new Request("http://api.test/x"), { MONTRAL_OPERATOR_USER_IDS: "op" } as never)).status).toBe(200);
    expect(keys).toEqual(["operator:session:s1", "operator:user:op"]);
  });
});

describe("operator workspace audit failure", () => {
  it.each(["suspend", "unsuspend"])("refuses %s when private attribution cannot be persisted", async (action) => {
    const transaction = vi.fn(async (work: (db: unknown) => Promise<unknown>) => work({
      query: async (sql: string) => {
        if (sql.includes("workspace_operator_audit")) throw new Error("private audit unavailable");
        if (sql.includes("SELECT id FROM organization")) return [{ id: "customer" }];
        if (sql.includes("SELECT reason FROM workspace_suspension")) return [{ reason: "abuse" }];
        return [];
      },
    }));
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("repo", { withinLimit: async () => true } as never);
      c.set("auth", { api: { getSession: async () => ({ user: { id: "op" }, session: { id: "s1" } }) } } as never);
      c.set("database", { query: async () => [{ enabled: true, verified: true }], transaction } as never);
      await next();
    });
    app.route("/operator", operatorApi);
    app.onError((_error, c) => c.json({ error: "Operation failed" }, 500));
    const res = await app.fetch(new Request(`http://web.test/operator/workspaces/customer/${action}`, {
      method: "POST", headers: { origin: "http://web.test", "content-type": "application/json" },
      body: JSON.stringify({ reason: "abuse" }),
    }), { WEB_ORIGIN: "http://web.test", MONTRAL_OPERATOR_USER_IDS: "op" } as never);
    expect(res.status).toBe(500);
    expect(transaction).toHaveBeenCalledOnce();
    expect(await res.text()).not.toContain("private audit unavailable");
  });
});

describe("recordMfaSignIn (the auth after-hook)", () => {
  const run = async (call: Parameters<typeof recordMfaSignIn>[1]) => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => []);
    const recorded = await recordMfaSignIn(query as never, call);
    return { recorded, query };
  };
  it("records the session a two-factor sign-in created, for each verify endpoint", async () => {
    for (const path of ["/two-factor/verify-totp", "/two-factor/verify-backup-code", "/two-factor/verify-otp"]) {
      const { recorded, query } = await run({ path, hadSession: false, newSessionId: "new-session" });
      expect(recorded).toBe(true);
      expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO operator_mfa_session"), ["new-session"]);
    }
  });
  it("records nothing for other sign-ins, a verify call that already had a session (enabling 2FA), or a failed verify", async () => {
    for (const call of [
      { path: "/sign-in/email", hadSession: false, newSessionId: "x" },
      { path: "/callback/:id", hadSession: false, newSessionId: "x" },
      { path: "/one-time-token/verify", hadSession: false, newSessionId: "x" },
      { path: "/two-factor/verify-totp", hadSession: true, newSessionId: "x" },
      { path: "/two-factor/verify-totp", hadSession: false, newSessionId: null },
    ]) {
      const { recorded, query } = await run(call);
      expect(recorded, call.path).toBe(false);
      expect(query).not.toHaveBeenCalled();
    }
  });
  it("fails closed: a failed insert records nothing and does not throw", async () => {
    const query = vi.fn(async () => { throw new Error("db down"); });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await recordMfaSignIn(query as never, { path: "/two-factor/verify-backup-code", hadSession: false, newSessionId: "s" })).toBe(false);
    err.mockRestore();
  });
});

describe("suspension gate for Better Auth endpoints", () => {
  it("guards workspace-changing organization calls and API key creation or change, not reads, leaving or switching", () => {
    for (const p of ["/organization/invite-member", "/organization/update", "/organization/delete", "/organization/remove-member", "/organization/update-member-role", "/organization/accept-invitation", "/organization/cancel-invitation", "/api-key/create", "/api-key/update"]) {
      expect(suspensionGuardsAuthPath(p), p).toBe(true);
    }
    for (const p of ["/organization/leave", "/organization/set-active", "/organization/list", "/organization/get-full-organization", "/organization/create", "/api-key/list", "/api-key/delete", "/sign-in/email", "/delete-user"]) {
      expect(suspensionGuardsAuthPath(p), p).toBe(false);
    }
  });
  it("finds the workspace a call acts on", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM apikey")) return [{ metadata: JSON.stringify(JSON.stringify({ organizationId: "key-org" })) }];
      if (sql.includes("FROM invitation")) return params?.[0] === "i" ? [{ organization_id: "inv-org" }] : [];
      if (sql.includes("FROM organization WHERE slug")) return params?.[0] === "nope" ? [] : [{ id: `slug:${params?.[0]}` }];
      return [];
    });
    const q = query as never;
    expect(await authCallWorkspaces(q, { path: "/organization/update", body: { data: {} }, query: {}, activeOrgId: "active" })).toEqual(["active"]);
    expect(await authCallWorkspaces(q, { path: "/organization/delete", body: { organizationId: "named" }, query: {}, activeOrgId: "active" })).toEqual(["named"]);
    // Better Auth acts on organizationId || the active workspace: a decoy slug or invitation never replaces the active one
    expect(await authCallWorkspaces(q, { path: "/organization/invite-member", body: { email: "x@example.com", organizationSlug: "acme" }, query: {}, activeOrgId: "active" })).toEqual(["active", "slug:acme"]);
    expect(await authCallWorkspaces(q, { path: "/organization/update", body: { data: {} }, query: { invitationId: "i" }, activeOrgId: "active" })).toEqual(["active", "inv-org"]);
    expect(await authCallWorkspaces(q, { path: "/organization/accept-invitation", body: { invitationId: "i" }, query: {}, activeOrgId: "active" })).toEqual(["active", "inv-org"]);
    // POST routes read the id from the body only: one in the query string is checked too but never replaces the active one
    expect(await authCallWorkspaces(q, { path: "/organization/update", method: "POST", body: { data: {} }, query: { organizationId: "elsewhere" }, activeOrgId: "active" })).toEqual(["active", "elsewhere"]);
    expect(await authCallWorkspaces(q, { path: "/organization/invite-member", method: "POST", body: { email: "x@example.com" }, query: { organizationId: "nonexistent" }, activeOrgId: "active" })).toEqual(["active", "nonexistent"]);
    expect(await authCallWorkspaces(q, { path: "/organization/update", method: "POST", body: { organizationId: "named" }, query: { organizationId: "elsewhere" }, activeOrgId: "active" })).toEqual(["named", "elsewhere"]);
    // GET routes read it from the query string; a body id is checked too
    expect(await authCallWorkspaces(q, { path: "/organization/list-invitations", method: "GET", body: undefined, query: { organizationId: "named" }, activeOrgId: "active" })).toEqual(["named"]);
    expect(await authCallWorkspaces(q, { path: "/organization/list-invitations", method: "GET", body: undefined, query: {}, activeOrgId: "active" })).toEqual(["active"]);
    // a slug or invitation that does not exist is refused, not ignored
    expect(await authCallWorkspaces(q, { path: "/organization/invite-member", body: { organizationSlug: "nope" }, query: {}, activeOrgId: "active" })).toBe("unresolved");
    expect(await authCallWorkspaces(q, { path: "/organization/update", body: {}, query: { invitationId: "missing" }, activeOrgId: "active" })).toBe("unresolved");
    expect(await authCallWorkspaces(q, { path: "/api-key/create", body: { metadata: { organizationId: "pin" } }, query: {}, activeOrgId: "active" })).toEqual(["pin"]);
    expect(await authCallWorkspaces(q, { path: "/api-key/create", body: {}, query: {}, activeOrgId: "active" })).toEqual(["active"]);
    expect(await authCallWorkspaces(q, { path: "/api-key/update", body: { keyId: "k" }, query: {}, activeOrgId: "active" })).toEqual(["key-org", "active"]);
  });
  it("anySuspended passes ids as one text parameter and skips the query for none", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => [{ one: 1 }]);
    expect(await anySuspended(query as never, [])).toBe(false);
    expect(query).not.toHaveBeenCalled();
    expect(await anySuspended(query as never, ["a", null, "b", "a"])).toBe(true);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("string_to_array($1::text"), ["a,b"]);
  });
});
