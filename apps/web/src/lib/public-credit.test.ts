import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const server = source("./server.ts");
const statusPage = source("../pages/status/[slug].astro");
const compose = source("../../../../docker-compose.yml");
const example = source("../../../../.env.docker.example");
const workerConfig = source("../../wrangler.jsonc");

describe("public status brand link safety", () => {
  it("defaults to the real Montral source repo when an operator leaves PRODUCT_URL unset", () => {
    expect(server).toContain('?? "https://github.com/TheHalfMoon/Montral"');
    expect(compose).toContain("PRODUCT_URL: ${PRODUCT_URL:-https://github.com/TheHalfMoon/Montral}");
    expect(example).toContain("# PRODUCT_URL=https://github.com/TheHalfMoon/Montral");
    expect(workerConfig).toContain('"PRODUCT_URL": "https://github.com/TheHalfMoon/Montral"');
  });

  it("uses a truthful, domain-neutral generator tag and retains override support", () => {
    expect(statusPage).toContain('<meta name="generator" content="Montral" />');
    expect(statusPage).toContain('href={PRODUCT_URL}');
    expect(server).toContain("process.env.PRODUCT_URL");
    expect(server).toContain("import.meta.env.PRODUCT_URL");
    for (const item of [statusPage, server, compose, example, workerConfig]) {
      expect(item).not.toContain("montral.invalid");
    }
  });
});
