import { describe, expect, it, vi } from "vitest";
import { createWorkspaceWithSlugRetry } from "./workspace-slug-retry";

const collision = () => Object.assign(new Error("duplicate slug"), { code: "23505", constraint: "organization_slug_key" });

describe("SSO first workspace slug retry", () => {
  it("retries a slug collision with a new slug", async () => {
    const create = vi.fn().mockRejectedValueOnce(collision()).mockResolvedValueOnce(undefined);
    const slugs = ["workspace-one", "workspace-two"];
    await createWorkspaceWithSlugRetry(create, () => slugs.shift()!);
    expect(create.mock.calls).toEqual([["workspace-one"], ["workspace-two"]]);
  });

  it("never retries unrelated constraints, database errors, or thrown primitives", async () => {
    const errors: unknown[] = [
      Object.assign(new Error("duplicate email"), { code: "23505", constraint: "user_email_key" }),
      Object.assign(new Error("another slug index"), { code: "23505", constraint: "other_slug_key" }),
      Object.assign(new Error("connection lost"), { code: "08006" }),
      null,
      "database failure",
    ];
    for (const error of errors) {
      const create = vi.fn().mockRejectedValue(error);
      await expect(createWorkspaceWithSlugRetry(create, () => "slug")).rejects.toBe(error);
      expect(create).toHaveBeenCalledTimes(1);
    }
  });

  it("fails after five slug collisions instead of silently succeeding", async () => {
    const create = vi.fn().mockImplementation(async () => { throw collision(); });
    await expect(createWorkspaceWithSlugRetry(create, () => "slug")).rejects.toMatchObject({ code: "23505" });
    expect(create).toHaveBeenCalledTimes(5);
  });
});
