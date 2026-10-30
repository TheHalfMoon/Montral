import { openDatabase } from "@montral/db-pg";
import { montralEdition } from "../src/montral-edition";
import { migrateMontralSchema } from "../src/schema-migrate";

/**
 * The complete API E2E suite shares one disposable PostgreSQL database.
 * A single, awaited schema bootstrap is a barrier before Vitest starts its
 * parallel test files. CREATE TABLE IF NOT EXISTS is not concurrency-safe when
 * two independent sessions try to create the same composite pg_type at once.
 */
export default async function setup() {
  const connection = process.env.TEST_DATABASE_URL;
  if (!connection) return; // Unit-only runs do not need a database.
  const url = new URL(connection);
  const dbName = decodeURIComponent(url.pathname.slice(1));
  if (!["localhost", "127.0.0.1"].includes(url.hostname) ||
      !(dbName === "montral_ci" || dbName.startsWith("montral_test_"))) {
    throw new Error("Refusing to migrate a non-local or non-disposable database for tests");
  }
  const db = openDatabase(connection, { max: 3 });
  try {
    await migrateMontralSchema(db, montralEdition);
  } finally {
    await db.close(3);
  }
}
