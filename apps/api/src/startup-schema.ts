/**
 * Startup migration failures that no retry can fix (self-hosted Node, server.ts). A database whose migration history
 * is ahead of this build (an older image started after an upgrade, the usual rollback mistake) or has diverged from it
 * is refused at once with a fixed message, instead of retrying as if PostgreSQL were still starting. Connection
 * failures and anything else keep the bounded retry loop. The messages carry no database detail.
 */
export const SCHEMA_AHEAD_MESSAGE = "database schema is newer than this Montral build; restore the pre-upgrade backup or run the newer build";
export const SCHEMA_DIVERGED_MESSAGE = "database migration history does not match this Montral build; restore a backup taken with this build or run the build that migrated it";

/** The fixed message to exit with, or null when the failure may be transient (keep retrying). */
export function fatalMigrationProblem(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "MONTRAL_SCHEMA_AHEAD") return SCHEMA_AHEAD_MESSAGE;
  if (code === "MONTRAL_SCHEMA_DIVERGED") return SCHEMA_DIVERGED_MESSAGE;
  return null;
}
