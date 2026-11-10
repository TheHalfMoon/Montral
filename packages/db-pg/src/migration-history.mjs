import { createHash } from "node:crypto";

/** Validate the exact applied prefix before executing or skipping migration SQL. */
export function validateMigrationHistory(migrations, applied) {
  let previous = -1;
  const tags = new Set();
  for (const m of migrations) {
    if (!Number.isSafeInteger(m.when) || m.when <= previous || tags.has(m.tag)) throw new Error("Invalid migration order: regenerate migrations against the current base");
    previous = m.when;
    tags.add(m.tag);
  }
  // Codes let a server tell "this build is too old for the database" (never fixed by retrying) from a connection failure.
  if (applied.length > migrations.length) throw Object.assign(new Error("Database migration history is ahead of this build"), { code: "MONTRAL_SCHEMA_AHEAD" });
  for (let i = 0; i < applied.length; i++) {
    const m = migrations[i];
    if (applied[i].created_at === null || Number(applied[i].created_at) !== m.when || applied[i].hash !== createHash("sha256").update(m.sql).digest("hex")) throw Object.assign(new Error(`Database migration history diverges at ${m.tag}; restore the applied history and regenerate pending migrations against the current base`), { code: "MONTRAL_SCHEMA_DIVERGED" });
  }
  return migrations.slice(applied.length);
}
