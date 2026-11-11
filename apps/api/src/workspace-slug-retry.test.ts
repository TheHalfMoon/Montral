import { describe, expect, it, vi } from "vitest";
import { createWorkspaceWithSlugRetry } from "./workspace-slug-retry";

const pgCollision = (constraint = "organization_slug_unique") =>
  Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
    constraint_name: constraint,
  });
const drizzleError = (cause: unknown) =>
  Object.assign(new Error("Failed query: insert into organization"), { cause });

describe("SSO first workspace slug retry", () => {
  it("retries a Drizzle-wrapped PostgreSQL slug-unique violation with a new slug", async () => {
    const create = vi.fn().mockRejectedValueOnce(drizzleError(pgCollision())).mockResolvedValueOnce(undefined);
    const slugs = ["workspace-one", "workspace-two"];
    await createWorkspaceWithSlugRetry(create, () => slugs.shift()!);
    expect(create.mock.calls).toEqual([["workspace-one"], ["workspace-two"]]);
  });

  it.each(["organization_slug_unique", "organization_slug_uidx", "organization_slug_key"])(
    "retries only the recognized constraint %s",
    async (constraint) => {
      const create = vi.fn().mockRejectedValueOnce(pgCollision(constraint)).mockResolvedValueOnce(undefined);
      await createWorkspaceWithSlugRetry(create, () => "workspace");
      expect(create).toHaveBeenCalledTimes(2);
    },
  );

  it("recognizes the direct PostgreSQL constraint field and nested causes", async () => {
    const pg = Object.assign(new Error("duplicate slug"), { code: "23505", constraint: "organization_slug_unique" });
    const create = vi.fn().mockRejectedValueOnce(drizzleError(drizzleError(pg))).mockResolvedValueOnce(undefined);
    await createWorkspaceWithSlugRetry(create, () => "workspace");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("does not retry unrelated unique violations, malformed errors, or driver failures", async () => {
    const errors: unknown[] = [
      pgCollision("user_email_key"),
      pgCollision("other_slug_key"),
      drizzleError(pgCollision("user_email_key")),
      drizzleError(Object.assign(new Error("connection lost"), { code: "08006" })),
      Object.assign(new Error("duplicate but no constraint metadata"), { code: "23505" }),
      null,
      "database failure",
    ];
    for (const error of errors) {
      const create = vi.fn().mockRejectedValue(error);
      await expect(createWorkspaceWithSlugRetry(create, () => "workspace")).rejects.toBe(error);
      expect(create).toHaveBeenCalledTimes(1);
    }
  });

  it("fails after five collisions and preserves the last wrapped error", async () => {
    const errors = Array.from({ length: 5 }, () => drizzleError(pgCollision()));
    const create = vi.fn().mockImplementation(async () => { throw errors[create.mock.calls.length - 1]; });
    await expect(createWorkspaceWithSlugRetry(create, () => "workspace")).rejects.toBe(errors[4]);
    expect(create).toHaveBeenCalledTimes(5);
  });

  it("does not loop forever on a cyclic cause chain", async () => {
    const broken = Object.assign(new Error("cyclic error"), { code: "23505", cause: null as unknown });
    broken.cause = broken;
    const create = vi.fn().mockRejectedValue(broken);
    await expect(createWorkspaceWithSlugRetry(create, () => "workspace")).rejects.toBe(broken);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
