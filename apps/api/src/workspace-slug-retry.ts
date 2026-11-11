/** Retry only a personal-workspace slug collision; never mask other database failures. */
export async function createWorkspaceWithSlugRetry(create: (slug: string) => Promise<unknown>, slugify: () => string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await create(slugify());
      return;
    } catch (error) {
      const pg = error !== null && typeof error === "object" ? error as { code?: unknown; constraint?: unknown } : null;
      if (pg?.code !== "23505" || pg.constraint !== "organization_slug_key" || attempt === 4) throw error;
    }
  }
}
