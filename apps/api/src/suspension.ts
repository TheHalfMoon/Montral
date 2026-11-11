import type { Context } from "hono";
import type { AppEnv } from "./env";

/**
 * Workspace suspension by a platform operator (docs/OPERATOR.md). A row in `workspace_suspension` stops the workspace:
 * API access (requireOrg), scheduled checks and alerts (the repo's claim queries), webhook capture and public status
 * pages. Nothing is deleted; removing the row restores everything.
 */
export const SUSPENSION_REASONS = ["abuse", "payment", "legal", "operator"] as const;
export type SuspensionReason = (typeof SUSPENSION_REASONS)[number];
export const SUSPENSION_NOTE_MAX = 500;

/** The error code clients can rely on (the message is for people). */
export const WORKSPACE_SUSPENDED = "workspace_suspended";

type Query = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

/** Whether the workspace is suspended right now: one primary-key lookup, never cached. */
export async function workspaceSuspended(query: Query, orgId: string): Promise<boolean> {
  const rows = await query<{ one: number }>(`SELECT 1 AS one FROM workspace_suspension WHERE organization_id = $1::text`, [orgId]);
  return rows.length > 0;
}

/** The 403 every refused request in a suspended workspace gets. Says nothing about the reason or the operator's note. */
export function suspendedResponse(c: Context<AppEnv>) {
  c.header("cache-control", "no-store");
  return c.json({ error: "This workspace is suspended. Contact support.", code: WORKSPACE_SUSPENDED }, 403);
}

export function isSuspensionReason(v: unknown): v is SuspensionReason {
  return typeof v === "string" && (SUSPENSION_REASONS as readonly string[]).includes(v);
}
