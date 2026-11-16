import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const index = read("../pages/alternatives/index.astro");
const alternatives = read("../pages/alternatives/[tool].astro");
const useCases = read("../pages/for/[segment].astro");
const seo = read("./seo-pages.ts");
const changelog = read("../pages/changelog.astro");
const regions = read("../pages/docs/regions.astro");
const selfHost = read("../pages/docs/self-host.astro");

describe("public Web-first copy before Cloud launch", () => {
  it("does not offer hosted signup in comparison and use-case pages", () => {
    expect(index).toContain("Montral Cloud is not publicly available");
    expect(index).not.toContain("It runs as a hosted service");
    for (const page of [alternatives, useCases]) {
      expect(page).toContain("Run the free Community edition");
      expect(page).toContain("Montral Cloud is not publicly available yet");
      expect(page).not.toContain("Start on the hosted service");
      expect(page).not.toContain("\u53ef\u4ee5\u76f4\u63a5\u4f7f\u7528\u6258\u7ba1\u670d\u52a1");
      expect(page).toContain("Montral Cloud \u5c1a\u672a\u516c\u5f00\u4e0a\u7ebf");
    }
    expect(seo).not.toContain("a hosted option and an API");
    expect(seo).toContain("Montral Cloud is not publicly available.");
  });

  it("identifies Cloud changelog content as development history, not an active service", () => {
    expect(changelog).toContain("Planned hosted edition, not publicly available.");
    expect(changelog).toContain("Montral Cloud is not publicly available.");
    expect(changelog).not.toContain("The hosted service. It includes everything");
    expect(changelog).toContain("\u5c1a\u672a\u516c\u5f00\u4e0a\u7ebf");
    expect(changelog).not.toContain("\u793e\u533a\u7248\u7684\u6240\u6709\u6539\u52a8\u540c\u6837\u4f1a\u8fdb\u5165 Cloud \u7248");
  });

  it("keeps region availability truthful in both locales without an invented Community cap", () => {
    expect(regions).toContain("Community self-hosting has no plan quota for regions");
    expect(regions).toContain("Montral Cloud is not publicly available.");
    expect(regions).toContain("Montral Cloud \u5c1a\u672a\u516c\u5f00\u4e0a\u7ebf");
    expect(regions).not.toContain("On the hosted service the available regions are already set up");
    expect(regions).not.toContain("\u81ea\u6258\u7ba1\u65f6\uff0c\u4e00\u4e2a\u76d1\u63a7\u9879\u6700\u591a\u53ef\u9009 10 \u4e2a\u533a\u57df");
    expect(regions).not.toContain("\u6258\u7ba1\u670d\u52a1\u7684\u4e0a\u9650\u53d6\u51b3\u4e8e\u5957\u9910");
  });

  it("does not advertise a signed official native iOS app in Chinese setup guidance", () => {
    expect(selfHost).toContain("This repository does not ship an official signed native app.");
    expect(selfHost).toContain("\u672c\u4ed3\u5e93\u4e0d\u63d0\u4f9b\u5df2\u7b7e\u540d\u53d1\u5e03\u7684 Montral \u5b98\u65b9\u539f\u751f\u5e94\u7528");
    expect(selfHost).not.toContain("\u56e0\u6b64\u5b98\u65b9 Montral \u5e94\u7528\u53ea\u80fd\u63a5\u6536\u6258\u7ba1\u670d\u52a1\u53d1\u51fa\u7684\u63a8\u9001");
  });
});
