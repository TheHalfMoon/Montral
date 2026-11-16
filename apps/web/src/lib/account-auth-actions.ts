/** Treat client transport rejections as failures without mistaking them for successful writes.
 * Better Auth typically returns {error}, but a network failure can reject outright.
 * Never put the rejected error (which can carry request details) into UI messages.
 */
export type AccountActionError = { code?: string | null; message?: string | null; status?: number } | null;
export type AccountActionResult = { error?: AccountActionError };

export async function attemptAuthAction<T extends AccountActionResult>(request: () => Promise<T>): Promise<T | null> {
  try {
    return await request();
  } catch {
    return null;
  }
}

export type PasswordChangeOutcome =
  | { kind: "change-failed"; error?: AccountActionError }
  | { kind: "changed" }
  | { kind: "changed-revoked" }
  | { kind: "changed-revoke-failed" };

/** Password changes and other-session revocation are separate mutations.
 * If the second mutation fails, the password has STILL changed: never prompt the
 * person to retry the password change or claim that it failed.
 */
export async function changePasswordWithCleanup(
  change: () => Promise<AccountActionResult>,
  revokeOthers?: () => Promise<AccountActionResult>,
): Promise<PasswordChangeOutcome> {
  const changed = await attemptAuthAction(change);
  if (!changed || changed.error) return { kind: "change-failed", error: changed?.error };
  if (!revokeOthers) return { kind: "changed" };
  const revoked = await attemptAuthAction(revokeOthers);
  return !revoked || revoked.error ? { kind: "changed-revoke-failed" } : { kind: "changed-revoked" };
}
