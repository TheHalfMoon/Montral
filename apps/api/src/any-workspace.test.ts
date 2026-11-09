import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";
import { createRepo, schema } from "@montral/db-pg";

/**
 * A fake PostgreSQL for the membership lookup behind a session (or grant) that has no active workspace. Rows are kept
 * in *physical* order, the order PostgreSQL returns them in when a query has no ORDER BY. Here the second workspace's
 * membership sits first on disk, which is what happens once a vacuum frees space left by deleted rows of other tenants
 * (the shared CI database deletes organizations all the time).
 */
function fakeDatabase(physical: { organization_id: string; created_at: string }[]) {
  const statements: string[] = [];
  const db = drizzle(async (text: string, params: unknown[]) => {
    statements.push(text);
    expect(text).toMatch(/from "member"/);
    let rows = [...physical];
    // honour exactly the ordering the statement asks for, nothing more
    if (/order by "member"\."created_at" asc, "member"\."organization_id" asc/.test(text)) {
      rows.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.organization_id.localeCompare(b.organization_id));
    }
    const limit = /limit \$(\d+)/.exec(text);
    if (limit) rows = rows.slice(0, Number(params[Number(limit[1]) - 1]));
    return { rows: rows.map((r) => [r.organization_id]) };
  }, { schema });
  return { repo: createRepo(db as never), statements };
}

describe("anyWorkspaceOf", () => {
  it("answers the oldest membership whatever order the rows sit in on disk", async () => {
    const { repo, statements } = fakeDatabase([
      { organization_id: "ada-other", created_at: "2026-11-09T19:27:45.700Z" },
      { organization_id: "ada-home", created_at: "2026-11-09T19:27:45.600Z" },
    ]);
    expect(await repo.anyWorkspaceOf("ada")).toBe("ada-home");
    expect(statements).toHaveLength(1);
  });

  it("breaks a created_at tie by workspace id, so repeated lookups never alternate", async () => {
    const at = "2026-11-09T19:27:45.600Z";
    const { repo } = fakeDatabase([{ organization_id: "b", created_at: at }, { organization_id: "a", created_at: at }]);
    for (let i = 0; i < 3; i++) expect(await repo.anyWorkspaceOf("u")).toBe("a");
  });

  it("is null for a user with no membership", async () => {
    expect(await fakeDatabase([]).repo.anyWorkspaceOf("nobody")).toBeNull();
  });
});
