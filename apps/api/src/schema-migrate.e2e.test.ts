import { openDatabase } from "@montral/db-pg";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { montralEdition } from "./montral-edition";
import { migrateMontralSchema } from "./schema-migrate";

// Uses a newly-created disposable database to prove fresh-install behavior.
// Global Vitest setup migrates the *shared* test DB, not this new one.
const connection = process.env.TEST_DATABASE_URL;
describe.skipIf(!connection)("multi-replica Montral migrations on PostgreSQL", () => {
  it("serializes all Montral edition DDL on a fresh database with 4 separate one-connection replicas", async () => {
    const source = new URL(connection!);
    expect(["127.0.0.1", "localhost"]).toContain(source.hostname);
    expect(source.pathname.slice(1)).toMatch(/^(?:montral_ci|montral_test_[a-z0-9_]+)$/);
    const name = "montral_test_replica_" + randomUUID().replaceAll("-", "");
    const owner = openDatabase(connection!, { max: 1 });
    const dbs: ReturnType<typeof openDatabase>[] = [];
    try {
      await owner.query('CREATE DATABASE "' + name + '"');
      const target = new URL(source.href);
      target.pathname = "/" + name;
      for (let i = 0; i < 4; i++) dbs.push(openDatabase(target.href, { max: 1 }));
      const applied = await Promise.all(dbs.map(db => migrateMontralSchema(db, montralEdition)));
      expect(applied).toHaveLength(4);
      // Exactly one invocation executes each core Drizzle migration; edition
      // table/type/function creation must never raise a catalog uniqueness error.
      const coreTags = applied.flat().filter(tag => /^\d{4}_/.test(tag));
      expect(new Set(coreTags).size).toBe(coreTags.length);
      const funcs = await dbs[0].query<{ proname: string }>(`
        SELECT proname FROM pg_proc
        WHERE proname IN ('montral_create_hook_inbox',
          'montral_capture_hook_event', 'montral_capture_hook_event_v2', 'montral_reserve_billing_intent',
          'montral_apply_billing_event', 'montral_spend_usage')
        ORDER BY proname
      `);
      expect(funcs.map(f => f.proname)).toHaveLength(6);
      const tables = await dbs[0].query<{ name: string | null }>(`
        SELECT to_regclass('montral_hook_inbox')::text AS name
        UNION ALL SELECT to_regclass('montral_hook_event')::text
        UNION ALL SELECT to_regclass('montral_subscription')::text
        UNION ALL SELECT to_regclass('montral_billing_intent')::text
      `);
      expect(tables.every(t => !!t.name)).toBe(true);

      // Prove the new transaction scope rolls back all partial edition DDL
      // rather than leaving a half-migrated database after process failure.
      await expect(dbs[0].migrateEdition!(async tx => {
        await tx.query("CREATE TABLE montral_failure_rollback_probe(id integer)");
        throw Error("simulated migration crash");
      })).rejects.toThrow("simulated migration crash");
      const afterward = await dbs[0].query<{ name: string | null }>(
        "SELECT to_regclass('montral_failure_rollback_probe')::text AS name",
      );
      expect(afterward[0]?.name).toBeNull();
    } finally {
      await Promise.all(dbs.map(db => db.close(5)));
      try {
        await owner.query('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
      } finally {
        await owner.close(5);
      }
    }
  }, 90_000);

  it("serializes transaction callbacks even with single-connection pools", async () => {
    const db = openDatabase(connection!, { max: 1 });
    const order: string[] = [];
    try {
      await Promise.all(["a", "b", "c"].map(id => db.migrateEdition!(async tx => {
        order.push(id + ":start");
        await tx.query("SELECT pg_sleep(0.015)");
        order.push(id + ":end");
      })));
      for (let n = 0; n < order.length; n += 2)
        expect(order[n].split(":")[0]).toBe(order[n + 1].split(":")[0]);
    } finally {
      await db.close(5);
    }
  });
});
