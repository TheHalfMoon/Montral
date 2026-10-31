import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "./env";
import { publicStatus } from "./routes/status";

function app() {
  const api = new Hono<AppEnv>();
  const observed: string[] = [];
  api.use("*", async (c, next) => {
    c.set("repo", {
      confirmSubscriber: async (token: string) => {
        observed.push("confirm:" + token);
        return token === "valid-confirm" ? "acme" : null;
      },
      removeSubscriber: async (token: string) => {
        observed.push("unsubscribe:" + token);
        return token === "valid-unsubscribe" ? "acme" : null;
      },
      statusPageBySlug: async () => null,
    } as never);
    c.set("entitlements", {} as never);
    await next();
  });
  api.route("/api/public/status", publicStatus);
  return { api, observed };
}

function protectedResponse(response: Response) {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  expect(response.headers.get("location") ?? "").not.toContain("valid-confirm");
  expect(response.headers.get("location") ?? "").not.toContain("valid-unsubscribe");
}

describe("public status subscription bearer-token response privacy", () => {
  it("protects valid and invalid confirmation redirects, without echoing query secrets", async () => {
    const { api, observed } = app();
    for (const token of ["valid-confirm", "not-valid"]) {
      const res = await api.request("/api/public/status/_/confirm?token=" + token);
      expect(res.status).toBe(302);
      protectedResponse(res);
      expect(res.headers.get("location")).not.toContain("token=");
    }
    expect(observed).toEqual(["confirm:valid-confirm", "confirm:not-valid"]);
  });

  it("protects unsubscribe HTML and redirects plus one-click protocol posts", async () => {
    const { api, observed } = app();
    const form = await api.request("/api/public/status/_/unsubscribe?token=valid-unsubscribe");
    expect(form.status).toBe(200);
    protectedResponse(form);
    expect(await form.text()).toContain('action="?token=valid-unsubscribe"');
    const normal = await api.request("/api/public/status/_/unsubscribe?token=valid-unsubscribe", { method: "POST" });
    expect(normal.status).toBe(303);
    protectedResponse(normal);
    const oneClick = await api.request("/api/public/status/_/unsubscribe?token=not-valid", {
      method: "POST", body: "List-Unsubscribe=One-Click",
    });
    expect(oneClick.status).toBe(200);
    protectedResponse(oneClick);
    expect(await oneClick.text()).toBe("OK");
    expect(observed).toEqual(["unsubscribe:valid-unsubscribe", "unsubscribe:not-valid"]);
  });

  it("keeps POST subscriber rejection responses private and non-referrable", async () => {
    const { api } = app();
    const response = await api.request("/api/public/status/acme/subscribe", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "subscriber@example.test" }),
    });
    expect(response.status).toBe(404);
    protectedResponse(response);
  });
});
