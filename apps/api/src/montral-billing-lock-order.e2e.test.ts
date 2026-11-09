import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { openDatabase } from "@montral/db-pg";
import { montralEdition } from "./montral-edition";
import { migrateMontralSchema } from "./schema-migrate";

/**
 * Regression for CI run https://github.com/TheHalfMoon/Montral/actions/runs/42445399140:
 * a replica re-running the edition migration while a checkout reservation was
 * in flight deadlocked (40P01) and the checkout returned 500.
 *
 * montral_reserve_billing_intent locks montral_subscription (read) and THEN
 * montral_billing_intent. The old migration took ACCESS EXCLUSIVE on
 * montral_billing_intent (no-op `ADD COLUMN IF NOT EXISTS`) and THEN on
 * montral_subscription, in one transaction: the opposite order.
 *
 * Synchronization is by pg_locks observation with a bounded wait, never by
 * sleeping for a fixed time and hoping the other side got there.
 */
const url = process.env.TEST_DATABASE_URL;
type Db = ReturnType<typeof openDatabase>;

// Table-level modes that conflict with the ROW EXCLUSIVE lock a checkout's
// INSERT (or a webhook capture) needs. A no-op restart must take none of them.
const BLOCKING_MODES = "'ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock'";
const EDITION_TABLES = "'montral_billing_intent','montral_subscription','montral_billing_event'," +
  "'montral_hook_inbox','montral_hook_event','montral_usage','montral_usage_reservation'";

async function settleOrBlock(observer: Db, migration: Promise<unknown>, pid: () => number) {
  let settled = false;
  void migration.then(() => { settled = true; }, () => { settled = true; });
  const deadline = Date.now() + 15_000;
  while (!settled && Date.now() < deadline) {
    if (pid()) {
      // Only relation locks: another test file may legitimately hold the
      // edition advisory lock while it migrates the shared database.
      const waiting = await observer.query(
        "SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='relation' AND NOT granted", [pid()]);
      if (waiting.length) return "blocked" as const;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return settled ? "settled" as const : "timeout" as const;
}

/**
 * Connection A holds what the reservation function takes first (a read of
 * montral_subscription). Connection B re-runs the whole Montral edition
 * migration. Once B has either finished or is blocked on a table lock, A
 * continues into montral_reserve_billing_intent (montral_billing_intent).
 * With the old SQL this is a lock cycle and PostgreSQL raises 40P01.
 */
async function interleave(target: string, observer: Db, org: string) {
  const checkout = openDatabase(target, { max: 1 });
  const migrator = openDatabase(target, { max: 1 });
  let open = false;
  try {
    await checkout.query("BEGIN");
    open = true;
    await checkout.query("SELECT 1 FROM montral_subscription WHERE organization_id=$1", [org]);
    let migratorPid = 0;
    const migration = migrator.migrateEdition!(async tx => {
      migratorPid = Number((await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))[0]!.pid);
      return montralEdition.migrate!(tx);
    });
    const phase = await settleOrBlock(observer, migration, () => migratorPid);
    const reservation = await checkout.query<{ reserved: boolean }>(
      "SELECT montral_reserve_billing_intent($1::uuid,$2::text,$3::text,$4::text,$5::text) AS reserved",
      [randomUUID(), org, "lock-order-test", "pro", "101"],
    );
    await checkout.query("COMMIT");
    open = false;
    const applied = await migration;
    return { phase, reserved: reservation[0]?.reserved, applied };
  } finally {
    if (open) await checkout.query("ROLLBACK").catch(() => {});
    await Promise.all([checkout.close(5), migrator.close(5)]);
  }
}

describe.skipIf(!url)("Montral billing migration lock order on PostgreSQL", () => {
  const db = url ? openDatabase(url, { max: 2 }) : null;
  beforeAll(async () => { await migrateMontralSchema(db!, montralEdition); });
  afterAll(async () => { await db?.close(1); });

  it("a no-op edition re-migration takes no table lock that blocks checkouts or captures", async () => {
    const held = await db!.migrateEdition!(async tx => {
      await montralEdition.migrate!(tx);
      // Still inside the migration transaction: every lock it took is held.
      return tx.query<{ relname: string; mode: string }>(`
        SELECT c.relname, l.mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
        WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation'
          AND c.relname IN (${EDITION_TABLES}) AND l.mode IN (${BLOCKING_MODES})
        ORDER BY c.relname, l.mode`);
    });
    // Old SQL: AccessExclusiveLock on montral_billing_intent and montral_subscription,
    // ShareLock on montral_billing_intent, montral_hook_inbox and montral_hook_event.
    expect(held.map(x => `${x.relname}:${x.mode}`)).toEqual([]);
  });

  it("re-running the migration during an in-flight reservation neither deadlocks nor waits", async () => {
    const org = "lock-order-" + randomUUID();
    await db!.query("INSERT INTO organization(id,name,slug,created_at) VALUES($1,'Synthetic lock order',$1,NOW())", [org]);
    try {
      const result = await interleave(url!, db!, org);
      expect(result.phase).toBe("settled");
      expect(result.reserved).toBe(true);
      expect(result.applied).toContain("montral_billing_test_preview_v1");
    } finally {
      await db!.query("DELETE FROM organization WHERE id=$1", [org]);
    }
  });

  it("fresh installs get the full billing schema, and a genuine upgrade locks in checkout order", async () => {
    // Disposable database, as in schema-migrate.e2e.test.ts, so dropping
    // schema objects cannot disturb other test files on the shared database.
    const source = new URL(url!);
    expect(["127.0.0.1", "localhost"]).toContain(source.hostname);
    expect(source.pathname.slice(1)).toMatch(/^(?:montral_ci|montral_test_[a-z0-9_]+)$/);
    const name = "montral_test_lockorder_" + randomUUID().replaceAll("-", "");
    const owner = openDatabase(url!, { max: 1 });
    let fresh: Db | null = null;
    try {
      await owner.query('CREATE DATABASE "' + name + '"');
      const target = new URL(source.href);
      target.pathname = "/" + name;
      fresh = openDatabase(target.href, { max: 2 });
      await migrateMontralSchema(fresh, montralEdition);
      const shape = async () => (await fresh!.query<{ item: string }>(`
        SELECT 'montral_subscription.ends_at' AS item FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name='montral_subscription' AND column_name='ends_at'
        UNION ALL SELECT 'montral_billing_intent.consumed_at' FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name='montral_billing_intent' AND column_name='consumed_at'
        UNION ALL SELECT 'montral_billing_intent_pending' WHERE to_regclass('montral_billing_intent_pending') IS NOT NULL
        UNION ALL SELECT 'montral_hook_inbox_scope' WHERE to_regclass('montral_hook_inbox_scope') IS NOT NULL
        UNION ALL SELECT 'montral_hook_event_recent' WHERE to_regclass('montral_hook_event_recent') IS NOT NULL
        UNION ALL SELECT 'montral_hook_event_expiry' WHERE to_regclass('montral_hook_event_expiry') IS NOT NULL
        ORDER BY 1`)).map(x => x.item);
      const complete = [
        "montral_billing_intent.consumed_at", "montral_billing_intent_pending",
        "montral_hook_event_expiry", "montral_hook_event_recent", "montral_hook_inbox_scope",
        "montral_subscription.ends_at",
      ];
      expect(await shape()).toEqual(complete);

      // Simulate a pre-upgrade schema that needs DDL on BOTH billing tables.
      await fresh.query("ALTER TABLE montral_subscription DROP COLUMN ends_at");
      await fresh.query("DROP INDEX montral_billing_intent_pending");
      const org = "lock-order-upgrade-" + randomUUID();
      await fresh.query("INSERT INTO organization(id,name,slug,created_at) VALUES($1,'Synthetic lock order',$1,NOW())", [org]);
      // The upgrade must wait for montral_subscription BEFORE it locks
      // montral_billing_intent, so the reservation completes and commits,
      // and the migration then finishes. Old SQL: 40P01 here.
      const result = await interleave(target.href, fresh, org);
      expect(result.phase).toBe("blocked");
      expect(result.reserved).toBe(true);
      expect(await shape()).toEqual(complete);
    } finally {
      await fresh?.close(5);
      try {
        await owner.query('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
      } finally {
        await owner.close(5);
      }
    }
  });
});
