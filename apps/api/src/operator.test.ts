import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "./env";
import { decodeOperatorCursor, encodeOperatorCursor, operatorIds, requireOperator } from "./operator";
import { isSuspensionReason, SUSPENSION_REASONS } from "./suspension";

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

describe("suspension reasons", () => {
  it("accepts exactly the four reasons", () => {
    expect([...SUSPENSION_REASONS]).toEqual(["abuse", "payment", "legal", "operator"]);
    for (const r of SUSPENSION_REASONS) expect(isSuspensionReason(r)).toBe(true);
    for (const r of ["", "Abuse", "other", null, undefined, 1]) expect(isSuspensionReason(r)).toBe(false);
  });
});

describe("requireOperator", () => {
  const harness = (o: { user?: { id: string } | null; twoFactor?: boolean }) => {
    const getSession = vi.fn(async () => (o.user ? { user: { ...o.user, emailVerified: true }, session: { id: "s" } } : null));
    const query = vi.fn(async () => [{ two_factor_enabled: o.twoFactor ?? false }]);
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

  it("admits a listed user with a session and two-factor enabled", async () => {
    const h = harness({ user: { id: "op" }, twoFactor: true });
    const r = await h.call({ MONTRAL_OPERATOR_USER_IDS: "op" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ operator: "op" });
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses API keys and bearer tokens before looking at the session", async () => {
    const h = harness({ user: { id: "op" }, twoFactor: true });
    for (const headers of [{ "x-api-key": "montral_k" }, { authorization: "Bearer anything" }] as Record<string, string>[]) {
      const r = await h.call({ MONTRAL_OPERATOR_USER_IDS: "op" }, { headers });
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: "Forbidden" });
    }
    expect(h.getSession).not.toHaveBeenCalled();
  });

  it("refuses when no operators are configured, the user is not listed, or two-factor is off", async () => {
    expect((await harness({ user: { id: "op" }, twoFactor: true }).call({})).status).toBe(403);
    expect((await harness({ user: { id: "op" }, twoFactor: true }).call({ MONTRAL_OPERATOR_USER_IDS: "someone-else" })).status).toBe(403);
    expect((await harness({ user: { id: "op" }, twoFactor: false }).call({ MONTRAL_OPERATOR_USER_IDS: "op" })).status).toBe(403);
    expect((await harness({ user: null }).call({ MONTRAL_OPERATOR_USER_IDS: "op" })).status).toBe(403);
  });

  it("refuses cross-origin writes with the operator's cookie", async () => {
    const h = harness({ user: { id: "op" }, twoFactor: true });
    expect((await h.call({ MONTRAL_OPERATOR_USER_IDS: "op" }, { method: "POST", headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await h.call({ MONTRAL_OPERATOR_USER_IDS: "op" }, { method: "POST", headers: { origin: "http://web.test" } })).status).toBe(200);
  });
});
