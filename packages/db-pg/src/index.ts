import type { Database, OpenDatabase } from "@montral/repo";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createDb } from "./client";
import { migrate } from "./migrate";
import { createRepo } from "./repo";
import * as schema from "./schema";

export * from "drizzle-orm";
export { createDb, type Db } from "./client";
export { createRepo } from "./repo";
export { migrate } from "./migrate";
export * as schema from "./schema";

/** The Postgres backend: opens one connection pool and exposes it as a `Database`. */
export const openDatabase: OpenDatabase = (connectionString, opts) => {
  const db = createDb(connectionString, opts);
  const database: Database = {
    repo: createRepo(db),
    authDatabase: drizzleAdapter(db, { provider: "pg", schema }),
    migrate: () => migrate(db),
    migrateEdition: async <T>(apply: (scoped: Database) => Promise<T>): Promise<T> =>
      (await db.$client.begin(async (tx) => {
        // Separate from the core Drizzle lock. Each replica migrates the core
        // first, then serializes the entire Montral edition schema as one unit.
        // Transaction-bound queries work with pool max:1 in Workers.
        await tx`select pg_advisory_xact_lock(hashtext('montral:edition:migrate'))`;
        const scoped: Database = {
          ...database,
          query: async <R>(text: string, params: unknown[] = []) =>
            (await tx.unsafe(text, params as never[])) as unknown as R[],
        };
        return apply(scoped);
      })) as T,
    query: async <T>(text: string, params: unknown[] = []) => (await db.$client.unsafe(text, params as never[])) as unknown as T[],
    close: (timeoutSec = 1) => db.$client.end({ timeout: timeoutSec }),
  };
  return database;
};
