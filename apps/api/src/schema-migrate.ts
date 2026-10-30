import type { Database } from "@montral/repo";
import type { Edition } from "./edition";

/**
 * Core schema already has an advisory lock. Edition migrations also need one:
 * a separate transaction with a session-scoped advisory lock ensures multiple
 * API replicas cannot race creating tables/types/functions on a fresh database.
 * The scoped database always uses the transaction's connection (pool max:1 safe).
 */
export async function migrateMontralSchema(db: Database, edition: Edition): Promise<string[]> {
  const core = await db.migrate();
  if (!edition.migrate) return core;
  const additional = db.migrateEdition
    ? await db.migrateEdition((locked) => edition.migrate!(locked))
    : await edition.migrate(db); // In-memory and fixture backends only
  return [...core, ...additional];
}
