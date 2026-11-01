#!/usr/bin/env node
// Negative backup/restore control: a synthetic restored database with an
// intentionally disabled immutability trigger MUST fail the restore drill.
// Local-only, scoped to montral_test_*; never modifies the source DB.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = process.env.TEST_DATABASE_URL;
if (!source) throw new Error("TEST_DATABASE_URL is required");
const parsed = new URL(source);
if (!["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !decodeURIComponent(parsed.pathname.slice(1)).startsWith("montral_test_")) {
  throw new Error("Only explicitly named disposable localhost montral_test_ databases are permitted");
}

const path = process.env.PATH ?? "";
const locate = name => execFileSync("which", [name], { encoding: "utf8" }).trim();
const realRestore = locate("pg_restore");
const realPsql = locate("psql");
const scratch = mkdtempSync(join(tmpdir(), "montral-backup-negative-"));
const shim = join(scratch, "pg_restore");
try {
  // A private wrapper runs the actual pg_restore and then corrupts only the
  // random, newly created restore target, before the drill verifies it.
  // Never touches the named TEST_DATABASE_URL/source.
  const code = `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(realRestore)}, args, { stdio: "inherit" });
if (result.error || result.status !== 0) process.exit(result.status ?? 1);
const at = args.indexOf("--dbname");
if (at === -1) process.exit(0); // pg_restore --list
const target = args[at + 1] || "";
let db = "";
try { db = decodeURIComponent(new URL(target).pathname.slice(1)); } catch {}
if (!/^montral_restore_test_\\d+$/.test(db) || !/^(localhost|127\\.0\\.0\\.1)$/.test(new URL(target).hostname)) {
  process.stderr.write("REFUSE: unexpected restore target\\n");
  process.exit(9);
}
const corrupted = spawnSync(${JSON.stringify(realPsql)}, ["-X","-v","ON_ERROR_STOP=1","-d",target,"-c",
  "ALTER TABLE public.monthly_report_content DISABLE TRIGGER montral_monthly_content_no_update_trigger"],
  { stdio: "inherit" });
process.exit(corrupted.status ?? 1);
`;
  writeFileSync(shim, code, { mode: 0o700 });
  chmodSync(shim, 0o700);
  const test = spawnSync(process.execPath, ["scripts/qualify-backup.mjs"], {
    cwd: process.cwd(), env: { ...process.env, PATH: scratch + ":" + path },
    encoding: "utf8", timeout: 90_000, maxBuffer: 1024 * 1024,
  });
  const output = (test.stdout ?? "") + (test.stderr ?? "");
  if (test.error || test.status === 0 ||
      !output.includes("Restored PostgreSQL catalog differs: triggers:monthly_report_content.montral_monthly_content_no_update_trigger")) {
    // Sanitized diagnostic: never echo source DB URI, rows or private content.
    throw new Error("Corrupted restore did not fail for the expected disabled trigger");
  }
  console.log("RESTORE_CATALOG_NEGATIVE_PASS: disabling an immutability trigger in a disposable restored database correctly fails qualification");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
