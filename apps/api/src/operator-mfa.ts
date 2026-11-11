/**
 * Which sessions passed a second factor, for the operator control plane (operator.ts, docs/OPERATOR.md).
 *
 * Better Auth only challenges for TOTP on the password sign-in endpoints; a GitHub sign-in, an SSO callback or the
 * native one-time-token handoff create full sessions without it, even for a user with two-factor enabled. So "the user
 * has two-factor enabled" says nothing about the session at hand. A session counts as second-factor verified only when
 * the two-factor verify endpoints created it during a sign-in (no session before the call, a new one after); the auth
 * after-hook records it here (operator_mfa_session, deleted with the session).
 *
 * Enabling two-factor from an existing session also mints a new session through verify-totp: that one is NOT recorded,
 * because the session that asked was created without a second factor. The operator signs in again.
 */

type Query = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

/** The Better Auth endpoints that create a session after checking a second factor during sign-in. */
export const MFA_VERIFY_PATHS: ReadonlySet<string> = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code", "/two-factor/verify-otp"]);

/** How long a second-factor sign-in is good for operator requests. */
export const OPERATOR_MFA_MAX_AGE_HOURS = 12;

/**
 * The after-hook's decision: record `newSessionId` when the call was a two-factor sign-in (a verify path, no session
 * before the call, a session created by it). Returns whether a row was written; a failure is logged and leaves the
 * session unrecorded (operator access is then refused: fail closed).
 */
export async function recordMfaSignIn(query: Query, call: { path: string; hadSession: boolean; newSessionId: string | null | undefined }): Promise<boolean> {
  if (!MFA_VERIFY_PATHS.has(call.path) || call.hadSession || !call.newSessionId) return false;
  try {
    await query(`INSERT INTO operator_mfa_session (session_id) VALUES ($1::text) ON CONFLICT (session_id) DO NOTHING`, [call.newSessionId]);
    return true;
  } catch {
    console.error("second-factor session could not be recorded; private diagnostics suppressed");
    return false;
  }
}

/** Whether this user has two-factor on and this session came from a second-factor sign-in within the allowed age. */
export async function operatorMfaSatisfied(query: Query, userId: string, sessionId: string): Promise<boolean> {
  const [row] = await query<{ enabled: boolean | null; verified: boolean }>(
    `SELECT u.two_factor_enabled AS enabled,
       EXISTS (SELECT 1 FROM operator_mfa_session m JOIN session s ON s.id = m.session_id
               WHERE m.session_id = $2::text AND s.user_id = $1::text AND s.expires_at > now()
                 AND m.verified_at > now() - make_interval(hours => ${OPERATOR_MFA_MAX_AGE_HOURS})) AS verified
     FROM "user" u WHERE u.id = $1::text`,
    [userId, sessionId],
  );
  return !!row?.enabled && !!row.verified;
}
