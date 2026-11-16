import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Public build copy must not advertise a native client that this repository does not ship.
// These are source assertions because the marketing pages are statically generated.
const file = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const installPage = file("../pages/ios.astro");
const footer = file("../layouts/Doc.astro");
const account = file("../components/Account.tsx");
const changelog = file("./changelog.ts");
const selfHost = file("../pages/docs/self-host.astro");
const comparisons = file("./seo-pages.ts");

describe("web-first product claims", () => {
  it("preserves the old /ios route while directing readers to the web app and a real browser install flow", () => {
    expect(installPage).toContain('href="/app"');
    expect(installPage).toContain("Add to Home Screen");
    expect(installPage).toContain("Progressive Web App (PWA)");
    expect(installPage).toContain('lang="zh-CN"');
    expect(installPage).toContain("安装网页");
    expect(footer).toContain("Install web app");
    expect(footer).toContain("安装网页应用");
  });

  it("does not promote an unverified TestFlight, App Store or fictitious native-client release", () => {
    for (const copy of [installPage, footer, account, changelog, selfHost]) {
      expect(copy).not.toContain("testflight.apple.com");
      expect(copy).not.toContain("apps.apple.com");
      expect(copy).not.toContain("Join the beta on TestFlight");
      expect(copy).not.toContain("The Montral iOS app is in public beta");
      expect(copy).not.toContain("The official Montral app");
    }
    expect(changelog).not.toContain("ios-testflight-beta");
    expect(account).not.toContain("Get the iOS app");
  });

  it("does not advertise obsolete on-call limitations in public comparisons", () => {
    expect(comparisons).toContain("Montral supports on-call rotations, overrides, and escalation policies");
    expect(comparisons).not.toContain("there is no rota or phone-call paging");
    expect(comparisons).not.toContain("no on-call rotation schedules");
    expect(comparisons).not.toContain("no on-call schedule features");
    expect(comparisons).not.toContain("but has no rota");
    expect(comparisons).toContain("On-call rotation schedules, overrides and escalation policies are supported.");
    expect(comparisons).not.toContain("from the iOS app");
  });

  it("does not misrepresent APNs compatibility as PWA push support", () => {
    expect(installPage).toContain("does not create a separate native client or enable APNs notifications");
    expect(selfHost).toContain("separately built, APNs-compatible iOS clients");
    expect(account).toContain("separately configured APNs-compatible client");
    expect(changelog).toContain("does not currently distribute a native iOS app");
  });
});
