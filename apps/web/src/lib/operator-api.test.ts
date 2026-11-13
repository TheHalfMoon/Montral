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

  it("reads only the safe workspace suspension history using a session and encoded ID", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ workspaceId: "a/b", events: [] }), { status: 200 }));
    const api = makeOperatorApi(request as typeof fetch);
    await expect(api.suspensionHistory("a/b")).resolves.toEqual({ workspaceId: "a/b", events: [] });
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/operator/workspaces/a%2Fb/suspension-history?limit=20");
    expect(init).toMatchObject({ method: "GET", credentials: "include", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" });
    expect(JSON.stringify(init)).not.toMatch(/authorization|x-api-key|localStorage|sessionStorage/i);
  });

  it("reads a probe audit without caching or unsafe URL interpolation", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ region: "east/west", events: [] }), { status: 200 }));
    const api = makeOperatorApi(request as typeof fetch);
    await expect(api.probeAudit("east/west")).resolves.toEqual({ region: "east/west", events: [] });
    const [path, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/operator/probes/east%2Fwest/audit?limit=50");
    expect(init).toMatchObject({ credentials: "include", cache: "no-store", method: "GET", referrerPolicy: "no-referrer" });
  });

  it("reads the unified operator audit through the session only, safely encoding target and cursor", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ events: [], next: null }), { status: 200 }));
    const api = makeOperatorApi(request as typeof fetch);
    await expect(api.platformAudit("north/east + %", "probe", "opaque==")).resolves.toEqual({ events: [], next: null });
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url.startsWith("/api/operator/audit?")).toBe(true);
    const params = new URL(url, "https://local.test").searchParams;
    expect(params.get("q")).toBe("north/east + %");
    expect(params.get("source")).toBe("probe");
    expect(params.get("limit")).toBe("25");
    expect(params.get("cursor")).toBe("opaque==");
    expect(init).toMatchObject({ method: "GET", credentials: "include", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" });
    expect(JSON.stringify(init)).not.toMatch(/authorization|x-api-key|localStorage|sessionStorage/i);
  });

  it("does not allow writes until the exact resource identifier is typed", () => {
    expect(operatorActionConfirmed("acme", "acme", "", 500)).toBe(true);
    expect(operatorActionConfirmed("acme", "Acme", "", 500)).toBe(false);
    expect(operatorActionConfirmed("acme", "acme ", "", 500)).toBe(false);
    expect(operatorActionConfirmed("acme", "acme", "x".repeat(501), 500)).toBe(false);
    expect(operatorActionConfirmed("", "", "", 500)).toBe(false);
  });
});
