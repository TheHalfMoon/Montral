import { describe, expect, it, vi } from "vitest";
import { makeOperatorApi, operatorActionConfirmed, OperatorRequestError } from "./operator-api";

describe("operator console request isolation", () => {
  it("uses only the browser session, disables browser caching and safely encodes search text", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ workspaces: [], next: null }), { status: 200 }));
    const api = makeOperatorApi(request as typeof fetch);
    await api.listWorkspaces("name+email@test.example", "opaque==");
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url.startsWith("/api/operator/workspaces?")).toBe(true);
    expect(new URL(url, "https://local.test").searchParams.get("q")).toBe("name+email@test.example");
    expect(new URL(url, "https://local.test").searchParams.get("cursor")).toBe("opaque==");
    expect(init).toMatchObject({ method: "GET", credentials: "include", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" });
    expect(JSON.stringify(init)).not.toMatch(/authorization|x-api-key|localStorage|sessionStorage/i);
  });

  it("sends an explicit JSON suspension reason and never returns the private denial body", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ error: "private-operator-reason" }), { status: 403 }));
    const api = makeOperatorApi(request as typeof fetch);
    await expect(api.suspend("a/b", "operator", "synthetic note")).rejects.toEqual(new OperatorRequestError(403));
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/operator/workspaces/a%2Fb/suspend");
    expect(JSON.parse(init.body as string)).toEqual({ reason: "operator", note: "synthetic note" });
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(init.cache).toBe("no-store");
  });

  it("does not allow writes until the exact resource identifier is typed", () => {
    expect(operatorActionConfirmed("acme", "acme", "", 500)).toBe(true);
    expect(operatorActionConfirmed("acme", "Acme", "", 500)).toBe(false);
    expect(operatorActionConfirmed("acme", "acme ", "", 500)).toBe(false);
    expect(operatorActionConfirmed("acme", "acme", "x".repeat(501), 500)).toBe(false);
    expect(operatorActionConfirmed("", "", "", 500)).toBe(false);
  });
});
