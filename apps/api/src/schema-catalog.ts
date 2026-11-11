import type { Database } from "@montral/repo";

/**
 * Catalog probes for edition migrations that run on every startup.
 *
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` takes ACCESS EXCLUSIVE and
 * `CREATE INDEX IF NOT EXISTS` takes SHARE on the table BEFORE PostgreSQL
 * notices the object already exists. Inside the single edition-migration
 * transaction those no-op locks are held until commit and can deadlock (40P01)
 * with live requests that lock the same tables in another order. These probes
 * use `to_regclass` (which resolves names through search_path exactly like the
 * unqualified DDL does, but takes no lock on the relation) and pg_attribute, so
 * an up-to-date schema issues no table-locking DDL at all.
 */
export async function relationExists(db: Database, name: string): Promise<boolean> {
  const rows = await db.query("SELECT 1 AS found WHERE to_regclass($1::text) IS NOT NULL", [name]);
  return rows.length > 0;
}

export async function columnExists(db: Database, table: string, column: string): Promise<boolean> {
  const rows = await db.query(
    `SELECT 1 AS found FROM pg_attribute
      WHERE attrelid = to_regclass($1::text) AND attname = $2::text AND attnum > 0 AND NOT attisdropped`,
    [table, column],
  );
  return rows.length > 0;
}

/** A named constraint on a table (pg_constraint; no lock on the relation). */
export async function constraintExists(db: Database, table: string, name: string): Promise<boolean> {
  const rows = await db.query(
    "SELECT 1 AS found FROM pg_constraint WHERE conrelid = to_regclass($1::text) AND conname = $2::text",
    [table, name],
  );
  return rows.length > 0;
}
