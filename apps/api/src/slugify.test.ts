import { describe, expect, it } from "vitest";
import { givePersonalWorkspace, slugify } from "./auth";

describe("workspace slugs", () => {
  it("are URL-safe, bounded, and carry an 8-character random suffix", () => {
    expect(slugify("Alex's workspace")).toMatch(/^alex-s-workspace-[a-z0-9]{8}$/);
    expect(slugify("!!!")).toMatch(/^workspace-[a-z0-9]{8}$/);
    expect(slugify("x".repeat(200)).length).toBe(48 + 1 + 8);
  });

  it("do not repeat for the same name across many sign-ups", () => {
    const seen = new Set(Array.from({ length: 50_000 }, () => slugify("Alex's workspace")));
    expect(seen.size).toBe(50_000);
  });

  it("a sign-up whose slug collides retries with a fresh one; other errors still fail", async () => {
    const slugs: string[] = [];
    let failures = 1;
    const database = {
      repo: { createPersonalWorkspace: async (w: { slug: string }) => {
        slugs.push(w.slug);
        if (failures-- > 0) throw Object.assign(new Error('duplicate key value violates unique constraint "organization_slug_unique"'), { code: "23505", constraint_name: "organization_slug_unique" });
      } },
      query: async () => [],
    };
    await givePersonalWorkspace(database as never, { id: "u1", name: "Alex", email: "alex@example.com" });
    expect(slugs).toHaveLength(2);
    expect(slugs[0]).not.toBe(slugs[1]);

    const other = { ...database, repo: { createPersonalWorkspace: async () => { throw Object.assign(new Error("connection reset"), { code: "08006" }); } } };
    await expect(givePersonalWorkspace(other as never, { id: "u2", name: "Bo", email: "bo@example.com" })).rejects.toThrow(/connection reset/);
  });
});
