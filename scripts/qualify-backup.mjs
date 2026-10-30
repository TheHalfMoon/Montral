#!/usr/bin/env node
// Reproducible restore drill: only isolated localhost databases with "test_" in name.
// Requires TEST_DATABASE_URL; never touches an existing database except reading
// the named disposable source. The restore target is a newly created random DB.
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
const source = process.env.TEST_DATABASE_URL;
if (!source) throw new Error("TEST_DATABASE_URL required (disposable LOCAL database)");
const sourceUrl = new URL(source);
const sourceDb = decodeURIComponent(sourceUrl.pathname.slice(1));
if (!["127.0.0.1", "localhost"].includes(sourceUrl.hostname) ||
    !sourceDb.startsWith("montral_test_")) {
  throw new Error("Only local, explicitly named montral_test_ databases may be backed up in this drill");
}
const restoreDb = "montral_restore_test_" + process.pid;
const restoredUrl = new URL(source);
restoredUrl.pathname = "/" + restoreDb;
const host = sourceUrl.hostname;
const port = sourceUrl.port || "5432";
const user = decodeURIComponent(sourceUrl.username || process.env.USER);
const tools = (name, args) => exec(name, args, { timeout: 60_000, env: {
  ...process.env, PGHOST: host, PGPORT: port, PGUSER: user,
  PGPASSWORD: decodeURIComponent(sourceUrl.password || ""),
} });
const sql = async (target, expression) =>
  (await tools("psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", target, "-c", expression])).stdout.trim();
const temp = await mkdtemp(join(tmpdir(), "montral-restore-"));
let created = false;
try {
  const tableCount = await sql(source, "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'");
  const orgCount = await sql(source, "SELECT COUNT(*) FROM organization");
  if (Number(tableCount) < 10) throw new Error("Source database has not been migrated");
  const dump = join(temp, "montral.disposable.dump");
  await tools("pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--file", dump, source]);
  const list = (await tools("pg_restore", ["--list", dump])).stdout;
  if (!list.includes("TABLE DATA") || !list.includes("organization")) throw new Error("Unexpected archive contents");
  // The randomly named target is unique to this drill, and is created here.
  await tools("createdb", [restoreDb]);
  created = true;
  await tools("pg_restore", ["--exit-on-error", "--no-owner", "--no-acl", "--dbname", restoredUrl.href, dump]);
  const restoredTableCount = await sql(restoredUrl.href, "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'");
  const restoredOrgCount = await sql(restoredUrl.href, "SELECT COUNT(*) FROM organization");
  if (tableCount !== restoredTableCount || orgCount !== restoredOrgCount) {
    throw new Error(`Restore differs: tables ${tableCount}/${restoredTableCount}, orgs ${orgCount}/${restoredOrgCount}`);
  }
  const functions = await sql(restoredUrl.href, "SELECT count(*) FROM pg_proc WHERE proname IN ('montral_create_hook_inbox','montral_capture_hook_event','montral_apply_billing_event','montral_spend_usage')");
  if (Number(functions) !== 4) throw new Error("Expected business-critical Postgres functions missing from restore");
  const appTables = await sql(restoredUrl.href, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('montral_hook_inbox','montral_hook_event','montral_subscription','montral_billing_event','montral_usage')");
  if (Number(appTables) !== 5) throw new Error("Montral-specific tables missing from restored database");
  console.log(`RESTORE_DRILL_PASS: ${tableCount} tables, ${orgCount} synthetic organizations, all webhook/billing/usage tables and 4 transactional functions restored`);
} finally {
  if (created) {
    try { await tools("dropdb", ["--if-exists", "--", restoreDb]); }
    catch (e) { console.error("WARNING: temporary restore database cleanup failed:", e.message); }
  }
  await rm(temp, { recursive: true, force: true });
}
