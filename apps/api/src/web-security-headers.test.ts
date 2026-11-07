import { describe, expect, it } from "vitest";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { applyWebSecurityHeaders, webSecurityHeaders } from "./web-security-headers";

describe("web security headers", () => {
  it("refuses framing of the app, sign-in and reset pages", () => {
    for (const path of ["/", "/app", "/app/incidents/x", "/login", "/reset-password", "/docs/api", "/statusx", "/app/status"]) {
      const h = webSecurityHeaders(path);
      expect(h["content-security-policy"], path).toContain("frame-ancestors 'none'");
      expect(h["x-frame-options"], path).toBe("DENY");
    }
  });
  it("keeps public status pages, including localized ones, frameable", () => {
    for (const path of ["/status", "/status/acme", "/zh-Hans/status/acme", "/ja/status/acme"]) {
      const h = webSecurityHeaders(path);
      expect(h["content-security-policy"], path).toContain("frame-ancestors *");
      expect(h["x-frame-options"], path).toBeUndefined();
    }
  });
  it("always restricts base, plugins and form targets without a script policy", () => {
    const csp = webSecurityHeaders("/app")["content-security-policy"];
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toMatch(/script-src|default-src/);
  });
  it("sets headers on a real Node response without overriding a handler's own value", async () => {
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/reset-password")) res.setHeader("referrer-policy", "no-referrer");
      applyWebSecurityHeaders(req.url, res);
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const get = (path: string) => new Promise<Record<string, string | string[] | undefined>>((resolve, reject) => {
      request({ host: "127.0.0.1", port, path }, (res) => { res.resume(); res.on("end", () => resolve(res.headers)); }).on("error", reject).end();
    });
    try {
      const reset = await get("/reset-password?token=x");
      expect(reset["referrer-policy"]).toBe("no-referrer");
      expect(reset["x-frame-options"]).toBe("DENY");
      expect(reset["x-content-type-options"]).toBe("nosniff");
      expect((await get("/status/acme"))["x-frame-options"]).toBeUndefined();
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
