import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const templates = [
  { route: "comparisons", file: "../pages/alternatives/[tool].astro" },
  { route: "use cases", file: "../pages/for/[segment].astro" },
] as const;

const primary = '<a class="btn-s primary" href="/docs/self-host">{ui[k].start}</a>';
const secondary = '<a class="btn-s" href="/docs">{ui[k].self}</a>';

describe("prelaunch generated public page calls to action", () => {
  it.each(templates)("$route does not send public visitors into a private app", ({ file }) => {
    const page = readFileSync(new URL(file, import.meta.url), "utf8");
    expect(page).toContain(primary + secondary);
    expect(page).not.toContain('<a class="btn-s primary" href="/app">');
    expect(page).toContain('start: "Self-host Montral", self: "Read the docs"');
    expect(page).toContain('start: "自托管 Montral", self: "阅读文档"');
    expect(page).toContain("Montral Cloud is not publicly available yet.");
    expect(page).toContain("Montral Cloud 尚未公开上线");
  });

  it("uses accurate EN/ZH headings for the self-hosting journey", () => {
    const alternatives = readFileSync(new URL("../pages/alternatives/[tool].astro", import.meta.url), "utf8");
    const useCases = readFileSync(new URL("../pages/for/[segment].astro", import.meta.url), "utf8");
    for (const page of [alternatives, useCases]) {
      expect(page).toContain('ctaT: "Run Montral yourself"');
      expect(page).toContain('ctaT: "自行部署 Montral"');
    }
    expect(alternatives).not.toContain('ctaT: "Try Montral"');
    expect(useCases).not.toContain('ctaT: "Set it up in Montral"');
  });
});
