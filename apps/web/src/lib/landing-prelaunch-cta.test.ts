import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const publicFile = (name: string) => readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8");

const landingVariants = [
  { file: "index.html", prefix: "", nav: "Self-host", primary: "Self-host for free", secondary: "Explore docs" },
  { file: "zh-Hans.html", prefix: "/zh-Hans", nav: "\u81ea\u6258\u7ba1", primary: "\u514d\u8d39\u81ea\u6258\u7ba1", secondary: "\u67e5\u770b\u6587\u6863" },
  { file: "ja.html", prefix: "", nav: "\u30bb\u30eb\u30d5\u30db\u30b9\u30c8", primary: "\u7121\u6599\u3067\u30bb\u30eb\u30d5\u30db\u30b9\u30c8", secondary: "\u30c9\u30ad\u30e5\u30e1\u30f3\u30c8\u3092\u898b\u308b" },
  { file: "es.html", prefix: "", nav: "Autoalojar", primary: "Autoalojar gratis", secondary: "Ver documentaci\u00f3n" },
] as const;

describe("prelaunch landing calls to action (public default, all locales)", () => {
  it.each(landingVariants)("$file promotes self-hosting instead of signup to an unlaunched Cloud service", ({ file, prefix, nav, primary, secondary }) => {
    const html = publicFile(file);
    expect(html).not.toMatch(/href="\/(?:zh-Hans\/)?signup"/);
    expect(html).toContain(`id="get-started" href="${prefix}/docs/self-host" data-i18n="nav.start">${nav}</a>`);
    const primaryLink = `href="${prefix}/docs/self-host"><span data-i18n="hero.cta1">${primary}</span>`;
    expect(html.split(primaryLink).length - 1).toBe(2); // hero and final CTA
    expect(html).toContain(`href="${prefix}/docs" data-i18n="hero.cta2">${secondary}</a>`);
    expect(html).toContain(`href="${prefix}/login" data-i18n="nav.signin"`); // existing self-host accounts still work
  });

  it("keeps language-switch translations consistent with localized markup", () => {
    const script = publicFile("landing.js");
    for (const { file, nav, primary, secondary } of landingVariants.filter((x) => x.file !== "index.html")) {
      expect(script, file).toContain(`'nav.start':'${nav}'`);
      expect(script, file).toContain(`'hero.cta1':'${primary}'`);
      expect(script, file).toContain(`'hero.cta2':'${secondary}'`);
    }
  });

  it("keeps the default CTA directed to documentation, but retains authenticated dashboard navigation", () => {
    const script = publicFile("landing.js");
    expect(script).toContain("document.getElementById('go-app').hidden=false");
    expect(script).not.toContain("href='/signup'");
    expect(script).not.toContain('href="/signup"');
  });
});
