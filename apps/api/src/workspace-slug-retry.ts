/** Retry a generated workspace slug only when the database reports its unique slug constraint. */
export async function createWorkspaceWithSlugRetry(create: (slug: string) => Promise<unknown>, slugify: () => string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await create(slugify());
      return;
    } catch (error) {
      const pg = error as { code?: string; constraint?: string };
      if (pg.code !== "23505" || !pg.constraint?.includes("slug") || attempt === 4) throw error;
    }
  }
}