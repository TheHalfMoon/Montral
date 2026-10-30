import type { Database } from "@montral/repo";
import { pruneExpiredHookEvents } from "./montral-hooks";
import { pruneExpiredBillingIntents } from "./montral-billing";

/**
 * Complete independent maintenance tasks, even when one fails. An exception
 * from the monitor scheduler must NOT suppress webhook retention or expiry
 * of sandbox checkout nonces.
 */
export async function runMontralMaintenance(db: Database): Promise<{ expiredHooks: number; expiredIntents: number }> {
  const result = await Promise.allSettled([
    pruneExpiredHookEvents(db),
    pruneExpiredBillingIntents(db),
  ]);
  const errors = result.filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");
  if (errors.length) throw new AggregateError(errors.map(entry => entry.reason), "Montral retention maintenance failed");
  return {
    expiredHooks: (result[0] as PromiseFulfilledResult<number>).value,
    expiredIntents: (result[1] as PromiseFulfilledResult<number>).value,
  };
}
