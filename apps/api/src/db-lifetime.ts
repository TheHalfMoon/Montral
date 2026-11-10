import type { Context } from "hono";
import type { AppEnv } from "./env";

/**
 * Give the request's database back before a long wait that needs it no more (a configured webhook response delay).
 * On Workers every request opens its own connection and the app closes it only after the response is sent, so a
 * request sleeping for seconds would hold an idle PostgreSQL connection the whole time; enough of them exhaust the
 * server's connections for every tenant. On Node the requests share one pool and `close` does nothing. Nothing may
 * query `c.get("database")` after this call; the app's own close at the end of the request is skipped.
 */
export function releaseDatabase(c: Context<AppEnv>) {
  // already released, or an edition's request middleware may still use the database after the route (edition.ts)
  if (c.get("databaseReleased") || c.get("earlyDatabaseRelease") === false) return;
  const database = c.get("database");
  c.set("databaseReleased", true);
  if (!database?.close) return;
  const closing = database.close(1).catch(() => console.error("database close failed; private diagnostics suppressed"));
  try {
    c.executionCtx.waitUntil(closing); // Workers
  } catch {
    // Node has no ExecutionContext; the shared pool's close resolves at once
  }
}
