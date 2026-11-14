import { describe, expect, it } from "vitest";
import { nextPath } from "./next-path";
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
