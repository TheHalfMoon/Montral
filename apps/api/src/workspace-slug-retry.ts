/** Retry only a personal-workspace slug collision; never mask other database failures. */
const SLUG_UNIQUE_CONSTRAINTS = new Set([
  "organization_slug_unique",
  "organization_slug_uidx",
  "organization_slug_key",
]);

function isWorkspaceSlugCollision(error: unknown): boolean {
  const visited = new Set<object>();
  let current: unknown = error;
  // Drizzle wraps PostgreSQL driver's error in cause.
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth++) {
    if (visited.has(current)) break;
    visited.add(current);
    const pg = current as { code?: unknown; constraint?: unknown; constraint_name?: unknown; cause?: unknown };
    const constraint = typeof pg.constraint_name === "string" ? pg.constraint_name : pg.constraint;
    if (pg.code === "23505" && typeof constraint === "string" && SLUG_UNIQUE_CONSTRAINTS.has(constraint)) {
      return true;
    }
    current = pg.cause;
  }
  return false;
}

export async function createWorkspaceWithSlugRetry(
  create: (slug: string) => Promise<unknown>,
  slugify: () => string,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await create(slugify());
      return;
    } catch (error) {
      if (!isWorkspaceSlugCollision(error) || attempt === 4) throw error;
    }
  }
}
