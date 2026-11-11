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
// Compare every table, not just the overall schema and organization counts.
// The source of this drill is an isolated disposable DB without concurrent writers.
const quoteIdentifier = name => '"' + name.replaceAll('"', '""') + '"';
const tableNames = (await sql(source,
  "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name"
)).split("\n").filter(Boolean);
if (tableNames.length < 10) throw new Error("Source database has not been migrated");
const countSql = "SELECT jsonb_object_agg(table_name, entry_count) FROM (" +
  tableNames.map(t => "SELECT '" + t.replaceAll("'", "''") + "' AS table_name, count(*)::text AS entry_count FROM public." + quoteIdentifier(t)).join(" UNION ALL ") +
  ") AS per_table";
const rowCounts = async database => JSON.parse(await sql(database, countSql));
// Order-independent table fingerprints over the full normalized JSONB row values.
// This detects altered values even when every table's row count still matches.
// Each individual row and the sorted result use SHA-256, not an additive checksum.
const digestSql = "SELECT jsonb_object_agg(table_name, fingerprint) FROM (" +
  tableNames.map(t => "SELECT '" + t.replaceAll("'", "''") + "' AS table_name, (" +
    "SELECT encode(sha256(convert_to(coalesce(string_agg(row_hash, '' ORDER BY row_hash), ''), 'UTF8')), 'hex')" +
    " FROM (SELECT encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') AS row_hash" +
    " FROM public." + quoteIdentifier(t) + " r) AS fingerprints" +
  ") AS fingerprint").join(" UNION ALL ") + ") AS per_table";
const rowDigests = async database => JSON.parse(await sql(database, digestSql));
// Verify executable schema too. Row digests alone can pass with a disabled
// immutability trigger, dropped index, weakened constraint or altered function.
const catalogQueries = {
  triggers: `SELECT COALESCE(jsonb_object_agg(k, h), '{}'::jsonb) FROM (
    SELECT r.relname || '.' || t.tgname AS k,
      encode(sha256(convert_to(pg_get_triggerdef(t.oid, true) || '|' || t.tgenabled::text, 'UTF8')), 'hex') AS h
    FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
  ) x`,
  columns: `SELECT COALESCE(jsonb_object_agg(k, h), '{}'::jsonb) FROM (
    SELECT r.relname || '.' || a.attname AS k,
      encode(sha256(convert_to(
        format('%s|%s|%s|%s|%s|%s|%s', format_type(a.atttypid, a.atttypmod),
          a.attnotnull, a.attidentity, a.attgenerated,
          COALESCE(pg_get_expr(d.adbin, d.adrelid), ''),
          a.attcollation::regcollation::text, a.attstorage), 'UTF8')), 'hex') AS h
    FROM pg_attribute a JOIN pg_class r ON r.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = r.oid AND d.adnum = a.attnum
    WHERE n.nspname = 'public' AND r.relkind IN ('r', 'p')
      AND a.attnum > 0 AND NOT a.attisdropped
  ) x`,
  relations: `SELECT COALESCE(jsonb_object_agg(k, h), '{}'::jsonb) FROM (
    SELECT r.relname AS k, encode(sha256(convert_to(
      format('%s|%s|%s|%s|%s', r.relkind, r.relpersistence,
        r.relrowsecurity, r.relforcerowsecurity, r.relreplident), 'UTF8')), 'hex') AS h
    FROM pg_class r JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE n.nspname = 'public' AND r.relkind IN ('r', 'p', 'v', 'm')
  ) x`,
  indexes: `SELECT COALESCE(jsonb_object_agg(k, h), '{}'::jsonb) FROM (
    SELECT indexname AS k, encode(sha256(convert_to(indexdef, 'UTF8')), 'hex') AS h
    FROM pg_indexes WHERE schemaname = 'public'
  ) x`,
  constraints: `SELECT COALESCE(jsonb_object_agg(k, h), '{}'::jsonb) FROM (
    SELECT r.relname || '.' || c.conname AS k,
      encode(sha256(convert_to(pg_get_constraintdef(c.oid, true) || '|' || c.contype::text || '|' ||
        c.convalidated::text || '|' || c.condeferrable::text || '|' || c.condeferred::text, 'UTF8')), 'hex') AS h
    FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE n.nspname = 'public'
  ) x`,
  functions: `SELECT COALESCE(jsonb_object_agg(k, h), '{}'::jsonb) FROM (
    SELECT p.oid::regprocedure::text AS k,
      encode(sha256(convert_to(pg_get_functiondef(p.oid), 'UTF8')), 'hex') AS h
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
  ) x`,
  views: `SELECT COALESCE(jsonb_object_agg(k, h), '{}'::jsonb) FROM (
    SELECT viewname AS k, encode(sha256(convert_to(definition, 'UTF8')), 'hex') AS h
    FROM pg_views WHERE schemaname = 'public'
  ) x`,
  policies: `SELECT COALESCE(jsonb_object_agg(k, h), '{}'::jsonb) FROM (
    SELECT tablename || '.' || policyname AS k,
      encode(sha256(convert_to(to_jsonb(p)::text, 'UTF8')), 'hex') AS h
    FROM pg_policies p WHERE schemaname = 'public'
  ) x`,
};
const catalogSnapshot = async db => Object.fromEntries(await Promise.all(
  Object.entries(catalogQueries).map(async ([kind, query]) => [kind, JSON.parse(await sql(db, query))])
));
const catalogDifferences = (before, after) => Object.keys(catalogQueries).flatMap(kind => {
  const a = before[kind]; const b = after[kind];
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter(key => a[key] !== b[key]).map(key => `${kind}:${key}`);
});

const temp = await mkdtemp(join(tmpdir(), "montral-restore-"));
let created = false;
let successMessage;
try {
  const tableCount = await sql(source, "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'");
  const orgCount = await sql(source, "SELECT COUNT(*) FROM organization");
  const sourceCounts = await rowCounts(source);
  const sourceDigests = await rowDigests(source);
  const sourceCatalog = await catalogSnapshot(source);
  if (Number(tableCount) < 10) throw new Error("Source database has not been migrated");
  const dump = join(temp, "montral.disposable.dump");
  await tools("pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--file", dump, source]);
  const sourceCountsAfterDump = await rowCounts(source);
  const sourceDigestsAfterDump = await rowDigests(source);
  const sourceCatalogAfterDump = await catalogSnapshot(source);
  const concurrentChanges = tableNames.filter(t => sourceCounts[t] !== sourceCountsAfterDump[t] || sourceDigests[t] !== sourceDigestsAfterDump[t]);
  const concurrentSchemaChanges = catalogDifferences(sourceCatalog, sourceCatalogAfterDump);
  if (concurrentChanges.length || concurrentSchemaChanges.length) {
    throw new Error(`Source changed during disposable backup drill: ${[...concurrentChanges, ...concurrentSchemaChanges].join(", ")}`);
  }
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
  const restoredCounts = await rowCounts(restoredUrl.href);
  const drift = tableNames.filter(t => sourceCounts[t] !== restoredCounts[t]);
  if (Object.keys(restoredCounts).length !== tableNames.length || drift.length) {
    throw new Error(`Restored table row-count mismatch: ${drift.join(", ") || "table set differs"}`);
  }
  const restoredDigests = await rowDigests(restoredUrl.href);
  const contentDrift = tableNames.filter(t => sourceDigests[t] !== restoredDigests[t]);
  if (Object.keys(restoredDigests).length !== tableNames.length || contentDrift.length) {
    throw new Error(`Restored table contents differ: ${contentDrift.join(", ") || "table set differs"}`);
  }
  const restoredCatalog = await catalogSnapshot(restoredUrl.href);
  const schemaDrift = catalogDifferences(sourceCatalog, restoredCatalog);
  if (schemaDrift.length) {
    throw new Error(`Restored PostgreSQL catalog differs: ${schemaDrift.slice(0, 12).join(", ")}${schemaDrift.length > 12 ? " (additional differences suppressed)" : ""}`);
  }
  const nonemptyTables = tableNames.filter(t => Number(sourceCounts[t]) > 0).length;
  const functions = await sql(restoredUrl.href, "SELECT count(*) FROM pg_proc WHERE proname IN ('montral_create_hook_inbox','montral_capture_hook_event','montral_billing_apply','montral_spend_usage','montral_spend_usage_v2','montral_spend_usage_once','montral_claim_monthly_report_send','montral_reserve_billing_intent_v2','montral_monthly_content_no_update')");
  if (Number(functions) !== 9) throw new Error("Expected business-critical Postgres functions missing from restore");
  const appTables = await sql(restoredUrl.href, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('montral_hook_inbox','montral_hook_event','montral_subscription','montral_billing_event','montral_usage','montral_usage_reservation','monthly_report_reconciliation','monthly_report_content')");
  if (Number(appTables) !== 8) throw new Error("Montral-specific tables missing from restored database");
  successMessage = `RESTORE_DRILL_PASS: ${tableCount} tables (${nonemptyTables} nonempty), ${orgCount} synthetic organizations, every table row count and SHA-256 content fingerprint matched; schema columns/relations/triggers/indexes/constraints/functions/views/policies fingerprints matched; all webhook/billing/usage tables and 9 required functions restored`;
} finally {
  try {
    if (created) await tools("dropdb", ["--if-exists", "--", restoreDb]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
console.log(successMessage);
