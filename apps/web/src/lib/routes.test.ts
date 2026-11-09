import { describe, expect, it } from "vitest";
import { NAV_LABEL, ROUTES, isSamePage, pageKey, resolveRoute } from "./routes";

describe("resolveRoute", () => {
  it("resolves static routes", () => {
    expect(resolveRoute("/app")?.route.name).toBe("Monitors");
    expect(resolveRoute("/app/incidents")?.route.name).toBe("Incidents");
    expect(resolveRoute("/app/api-keys")?.route.key).toBe("api-keys");
    expect(resolveRoute("/app/mail-review")?.route.name).toBe("MailReview");
  });
  it("ignores trailing slashes", () => {
    expect(resolveRoute("/app/")?.route.name).toBe("Monitors");
    expect(resolveRoute("/app/team//")?.route.name).toBe("Team");
  });
  it("extracts and decodes params", () => {
    const r = resolveRoute("/app/monitors/a%20b");
    expect(r?.route.name).toBe("MonitorDetail");
    expect(r?.params).toEqual(["a b"]);
    expect(r?.route.data(r.params)).toEqual(["/monitors/a b", "/channels"]);
  });
  it("highlights the parent nav entry for detail pages", () => {
    expect(resolveRoute("/app/incidents/9")?.route.key).toBe("incidents");
    expect(resolveRoute("/app/status-pages/9")?.route.key).toBe("status-pages");
  });
  it("returns null for unknown paths", () => {
    expect(resolveRoute("/nope")).toBeNull();
    expect(resolveRoute("/app/monitors")).toBeNull();
    expect(resolveRoute("/app/monitors/1/extra")).toBeNull();
  });
  it("has unique names and a label for every nav key", () => {
    expect(new Set(ROUTES.map((r) => r.name)).size).toBe(ROUTES.length);
    for (const r of ROUTES) expect(NAV_LABEL[r.key]).toBeTruthy();
  });
});

describe("isSamePage (fragment-only navigation)", () => {
  const at = (href: string) => new URL(href, "http://montral.test");
  it("treats a fragment-only change, such as the skip link, as the same page", () => {
    expect(isSamePage(at("/app"), at("/app#main-content"))).toBe(true);
    expect(isSamePage(at("/app/monitors/1#main-content"), at("/app/monitors/1"))).toBe(true);
    expect(pageKey(at("/app?project=a#x"))).toBe("/app?project=a");
  });
  it("treats a different path or query as a new page", () => {
    expect(isSamePage(at("/app"), at("/app/incidents"))).toBe(false);
    expect(isSamePage(at("/app?project=a"), at("/app?project=b"))).toBe(false);
  });
});
