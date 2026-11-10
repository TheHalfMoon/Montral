import { t } from "./i18n";

/** What the SSO callback reports in `?sso_error=` (sso-auth.ts), in words. Never details of the failure. */
export const SSO_ERRORS: Record<string, string> = {
  invalid_state: "The single sign-on attempt expired or was started in another browser. Try again.",
  idp_error: "Your identity provider did not complete the sign-in. Try again.",
  invalid_id_token: "Your identity provider's answer could not be verified, so you were not signed in.",
  connection_disabled: "Single sign-on is switched off for this workspace.",
  connection_misconfigured: "Single sign-on is misconfigured. Ask the workspace owner to enter the client secret again.",
  email_not_verified: "Your identity provider did not confirm that your email address is verified.",
  domain_not_allowed: "Your email domain cannot use this single sign-on connection.",
  link_required: "An account with this email already exists. Sign in with your password, then link single sign-on under Account.",
  link_email_mismatch: "The identity provider signed in a different email address than this account's.",
  identity_in_use: "That single sign-on identity is already linked to another account.",
  signup_closed: "Sign-ups are closed here. Ask a workspace owner to invite you.",
  sso_required: "Your workspace requires single sign-on. Use “Sign in with SSO”.",
  access_removed: "You were removed from this workspace. Ask an owner or admin to invite you again.",
};

/** Starts a single sign-on: by work email (its verified domain) or by workspace ID, then goes to the identity provider. */
export async function startSso(body: { email?: string; workspace?: string; intent?: "signin" | "link"; returnTo?: string }): Promise<string | null> {
  const res = await fetch("/api/auth/sso/start", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => null)) as { url?: string; code?: string } | null;
  if (res.ok && data?.url) {
    window.location.href = data.url;
    return null;
  }
  if (res.status === 404) return t("No single sign-on is set up for that email domain or workspace.");
  if (res.status === 429) return t("Too many attempts, try again later.");
  if (res.status === 502) return t("The identity provider could not be reached. Try again later.");
  return t("Something went wrong");
}
