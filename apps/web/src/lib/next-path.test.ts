import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { invitationReturn, nextPath, offerSignupLink } from "./next-path";
import { withLocale } from "./locale-path";

describe("nextPath", () => {
  it("defaults to /app", () => {
    expect(nextPath("")).toBe("/app");
    expect(nextPath("?foo=1")).toBe("/app");
  });
  it("accepts same-site paths", () => {
    expect(nextPath("?next=/app/monitors/1")).toBe("/app/monitors/1");
    expect(nextPath("?next=%2Fapp%2Fteam")).toBe("/app/team");
  });
  it("rejects open redirects", () => {
    for (const n of ["//evil.com", "https://evil.com", "evil.com", "/\\evil.com", "%2F%2Fevil.com", "javascript:alert(1)"]) {
      expect(nextPath(`?next=${n}`)).toBe("/app");
    }
  });
  it.each(["\t", "\n", "\r"])("rejects browser-stripped control %j", (control) => {
    const search = `?next=${encodeURIComponent(`/${control}/evil.example`)}`;
    expect(nextPath(search)).toBe("/app");
  });
  it.each(["zh-Hans", "ja", "es"])("keeps the final destination same-site after removing %s", (prefix) => {
    const requested = nextPath(`?next=/${prefix}//evil.example`);
    const result = withLocale(requested, "en");
    expect(new URL(result, "https://montral.example/login").origin).toBe("https://montral.example");
    expect(result).toBe("/app");
  });
  it("preserves valid queries, hashes, localized paths and literal encoded octets", () => {
    for (const path of ["/app?name=hello world#section", "/ja/app/team?tab=members#invite", "/%09/evil.example", "/%2fexample"]) {
      expect(nextPath(`?next=${encodeURIComponent(path)}`)).toBe(path);
      expect(new URL(withLocale(path, "en"), "https://montral.example").origin).toBe("https://montral.example");
    }
  });
});

describe("closed-signup invitation link visibility", () => {
  it.each([
    "?next=%2Faccept-invite%2Ff76ae987-a012-4cfb-92aa-2ab29cf8723b",
    "?next=%2Fzh-Hans%2Faccept-invite%2Finvite_123",
    "?next=%2Fja%2Faccept-invite%2Finvite_123",
    "?next=%2Fes%2Faccept-invite%2Finvite_123",
  ])("permits an explicit invite return even when public signup is closed: %s", (query) => {
    expect(invitationReturn(query)).toBe(true);
  });

  it.each([
    "", "?foo=bar", "?sso_error=signup_closed", "?next=%2Fapp",
    "?next=%2Flogin", "?next=%2Faccept-invite",
    "?next=%2Faccept-invite%2F", "?next=%2Faccept-invite%2Fx%2Fmore",
    "?next=https%3A%2F%2Fevil.example%2Faccept-invite%2Fx",
    "?next=%2F%2Fevil.example%2Faccept-invite%2Fx",
    "?next=%2Faccept-invite%2Fa%3Ffoo%3Dbar",
    "?next=%2Faccept-invite%2F%250A",
  ])("does not advertise closed signup for an unrelated or unsafe search: %s", (query) => {
    expect(invitationReturn(query)).toBe(false);
  });
});

describe("closed sign-up link visibility", () => {
  it("does not flash public signup before provider configuration loads", () => {
    expect(offerSignupLink(null, "")).toBe(false);
    expect(offerSignupLink(null, "?unrelated=one")).toBe(false);
    expect(offerSignupLink(false, "?unrelated=one")).toBe(false);
    expect(offerSignupLink(false, "?next=/app")).toBe(false);
  });
  it("offers signup on open self-hosted instances", () => {
    expect(offerSignupLink(true, "")).toBe(true);
    expect(offerSignupLink(true, "?next=/app")).toBe(true);
  });
  it("wires the invite-only link to the UI without a misleading initial flash", () => {
    const source = readFileSync(new URL("../components/AuthForm.tsx", import.meta.url), "utf8");
    expect(source).toContain("useState<boolean | null>(null)");
    expect(source).toContain("offerSignupLink(open, location.search)");
    expect(source).not.toContain("open || location.search");
  });
  it("keeps the invitation exception when public registration is closed", () => {
    const invite = "?next=%2Faccept-invite%2F761fe8d1-0df6-4bfa-a79f-16b821e65e31";
    expect(offerSignupLink(false, invite)).toBe(true);
    expect(offerSignupLink(null, invite)).toBe(true);
  });
});
