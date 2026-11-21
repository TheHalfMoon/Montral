import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("public community links", () => {
  it("resolves every linked repository guide to a checked-in file", () => {
    const sources = [
      "apps/web/src/layouts/Doc.astro",
      "apps/web/src/pages/docs/index.astro",
      "apps/web/src/pages/privacy.astro",
    ];
    const linkedPaths = new Set<string>();
    for (const source of sources) {
      const body = readFileSync(resolve(repoRoot, source), "utf8");
      for (const match of body.matchAll(/github\.com\/TheHalfMoon\/Montral\/blob\/main\/([A-Z]+\.md)/g)) {
        linkedPaths.add(match[1]);
      }
    }

    expect([...linkedPaths].sort()).toEqual(["CONTRIBUTING.md", "SECURITY.md"]);
    for (const target of linkedPaths) {
      expect(existsSync(resolve(repoRoot, target)), `${target} must exist for the public link`).toBe(true);
    }
  });
});
