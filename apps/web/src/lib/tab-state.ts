/**
 * What this tab remembers in sessionStorage about the signed-in account and its workspace: the usage banner's last
 * notice and dismissal, and the email-verification bar's flags. All of it belongs to that account, so signing out
 * forgets it; otherwise the next account to sign in here would briefly see the previous one's notices.
 */
export const ACCOUNT_TAB_KEYS = ["montral_usage_alert", "montral_usage_bar_hidden", "montral_verify_pending", "montral_verify_dismissed"] as const;

type Store = Pick<Storage, "removeItem">;
const session = (): Store | null => { try { return typeof sessionStorage === "undefined" ? null : sessionStorage; } catch { return null; } };

export function forgetAccountTabState(store: Store | null = session()): void {
  for (const k of ACCOUNT_TAB_KEYS) { try { store?.removeItem(k); } catch { /* nothing to forget */ } }
}
