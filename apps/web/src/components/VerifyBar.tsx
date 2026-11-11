import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import { toast } from "../lib/toast";
import { verifyBarAtFirstPaint, verifyBarStorage } from "../lib/verify-bar";

/**
 * Notification bar for accounts whose email address is not verified yet.
 *
 * It sits above the page, so appearing late would push the page down under a click already on its way (a button
 * pressed right after load would hit whatever moved there). Once an account is known to be unverified, this tab
 * remembers that much (a flag, never the address) and later loads paint the bar with the page.
 */
export default function VerifyBar() {
  const [state, setState] = useState(() => verifyBarAtFirstPaint(verifyBarStorage()));
  useEffect(() => {
    // back from the link in the verification email: say so, then tidy the address bar
    const q = new URLSearchParams(location.search);
    if (q.get("verified") || q.get("error")) {
      if (q.get("error")) toast(t("That verification link is invalid or has expired. Send a new one."), "err");
      else toast(t("Your email address is verified."));
      q.delete("verified"); q.delete("error");
      history.replaceState(null, "", location.pathname + (q.size ? `?${q}` : "") + location.hash);
    }
    api.me().then((m) => {
      const pending = !!m.user && m.user.emailVerified === false;
      verifyBarStorage().setPending(pending);
      setState((s) => ({ ...s, pending }));
    }).catch(() => {});
  }, []);
  if (!state.pending || state.dismissed) return null;
  return (
    <div className="verify-bar" role="alert">
      <span>{t("Please verify your email address — check your inbox for the link we sent.")}</span>
      <button className="icon-btn" aria-label={t("Dismiss")} onClick={() => { verifyBarStorage().dismiss(); setState((s) => ({ ...s, dismissed: true })); }}>×</button>
    </div>
  );
}
