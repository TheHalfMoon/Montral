import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const comparisons = source("./seo-pages.ts");
const useCases = source("../pages/for/index.astro");
const terms = source("../pages/terms.astro");
const privacy = source("../pages/privacy.astro");
const selfHostGuide = source("../pages/docs/self-host.astro");

describe("prelaunch hosted-service claims", () => {
  it("describes available Community self-hosting without presenting Cloud as a live paid service", () => {
    expect(comparisons).toContain("no public Montral Cloud service is live");
    expect(comparisons).toContain("Cloud is not publicly available or priced yet");
    expect(comparisons).not.toContain("The hosted service has plans");
    expect(comparisons).not.toContain("you either use the hosted service or run it yourself");
    expect(useCases).toContain("Cloud is not publicly available or priced yet");
    expect(useCases).not.toContain("The hosted service has plans");
    expect(useCases).toContain("Cloud 尚未公开上线或定价");
  });

  it.each([
    ["terms", terms],
    ["privacy", privacy],
  ])("marks %s as an unapproved non-indexed draft, not operative policy", (_page, html) => {
    expect(html).toContain('content="noindex,nofollow" slot="head"');
    expect(html).toContain("Not in force.");
    expect(html).toContain("尚未生效");
    expect(html).toContain("2026-11-16");
    expect(html).not.toContain("montral.invalid");
    expect(html).not.toContain('href="mailto:legal@montral.invalid"');
    expect(html).not.toContain('href="mailto:privacy@montral.invalid"');
  });

  it("warns operators that bundled legal drafts must be replaced before enabling sign-up consent", () => {
    expect(selfHostGuide).toContain("unapproved, nonoperative hosted-policy drafts");
    expect(selfHostGuide).toContain("未批准、未生效的托管政策草案");
    expect(selfHostGuide).not.toContain("pages describe the hosted service at montral.invalid");
    expect(selfHostGuide).not.toContain("描述的是 montral.invalid 托管服务");
  });

  it("keeps a real security-reporting location while reserving future hosted contacts for owner review", () => {
    expect(privacy).toContain("https://github.com/TheHalfMoon/Montral/blob/main/SECURITY.md");
    expect(terms).toContain("Legal review and owner authorization");
    expect(privacy).toContain("legal/privacy review");
    expect(privacy).toContain("a draft outline of possible processing");
  });
});
