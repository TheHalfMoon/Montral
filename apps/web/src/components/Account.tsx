import { t } from "../lib/i18n";
import { LOCALES, type Locale } from "../lib/i18n";
import { go, switchLocale } from "../lib/locale-path";
import { useEffect, useState } from "react";
import { api, type PushDevice } from "../lib/api";
import { ask } from "../lib/confirm";
import { authClient } from "../lib/auth-client";
import QRCode from "qrcode";
import { toast } from "../lib/toast";
import { SSO_ERRORS, startSso } from "../lib/sso";
import Segmented from "./Segmented";

type Me = { name?: string; email?: string; locale?: string | null; emailVerified?: boolean; twoFactorEnabled?: boolean | null };

/** Email verification, two-step sign-in, data export and account deletion. */
function Security({ me, reload, hasPassword }: { me: Me; reload: () => void; hasPassword: boolean }) {
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [pw, setPw] = useState("");
  const [setup, setSetup] = useState<{ uri: string; secret: string; qr: string; codes: string[] } | null>(null);
  const [code, setCode] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [sending, setSending] = useState(false);
  const fail = (m?: string) => { const text = m ?? t("Something went wrong"); setErr(text); toast(text, "err"); setBusy(false); };
  const ok = (m: string) => { setMsg(m); toast(m); };
  const reset = () => { setErr(""); setMsg(""); };

  async function resend() {
    reset(); setSending(true);
    const r = await authClient.sendVerificationEmail({ email: me.email!, callbackURL: "/app/account?verified=1" }).catch(() => null);
    setSending(false);
    if (!r || r.error) return fail(r?.error?.message);
    ok(t("Verification email sent. Check your inbox."));
  }
  async function enable(e: React.SyntheticEvent) {
    e.preventDefault(); reset(); setBusy(true);
    const r = await authClient.twoFactor.enable({ password: pw });
    if (r.error || !r.data || !("totpURI" in r.data)) return fail(r.error?.message);
    const uri = r.data.totpURI;
    setSetup({ uri, secret: new URL(uri).searchParams.get("secret") ?? "", qr: await QRCode.toDataURL(uri, { margin: 1, width: 180 }), codes: r.data.backupCodes });
    setPw(""); setBusy(false);
  }
  async function confirm(e: React.SyntheticEvent) {
    e.preventDefault(); reset(); setBusy(true);
    const r = await authClient.twoFactor.verifyTotp({ code });
    if (r.error) return fail(t("That code is not valid. Try the current one from your app."));
    setSetup(null); setCode(""); setBusy(false); ok(t("Two-step verification is on.")); reload();
  }
  async function disable(e: React.SyntheticEvent) {
    e.preventDefault(); reset(); setBusy(true);
    const r = await authClient.twoFactor.disable({ password: pw });
    if (r.error) return fail(r.error.message);
    setPw(""); setBusy(false); ok(t("Two-step verification is off.")); reload();
  }
  async function remove(e: React.SyntheticEvent) {
    e.preventDefault(); reset(); setBusy(true);
    const r = await authClient.deleteUser(pw ? { password: pw } : {});
    if (r.error) {
      // without a password the server asks for a recent sign-in instead
      if (!pw && r.error.code === "SESSION_EXPIRED") { setStale(true); setBusy(false); return; }
      return fail(r.error.message);
    }
    go("/");
  }
  async function reauth() {
    setBusy(true);
    const r = await authClient.signIn.social({ provider: "github", callbackURL: "/app/account?reauth=1" });
    if (r.error) fail(r.error.message);
  }
  return (
    <>
      <div className="card sect">
        <h3>{t("Email verification")}</h3>
        {me.emailVerified
          ? <p className="state-ok"><span className="show-tick" aria-hidden="true">✓</span>{t("Your email address is verified.")}</p>
          : <><p className="muted" style={{ marginBottom: 12 }}>{t("Your email address is not verified yet. We use it for alerts and to help you recover your account.")}</p>
            <div><button className="btn" disabled={sending} onClick={resend}>{sending ? t("Sending…") : t("Send verification email")}</button></div></>}
      </div>
      <div className="card sect">
        <h3>{t("Two-step verification")}</h3>
        <p className="muted" style={{ marginBottom: 12 }}>{t("Ask for a code from an authenticator app (Google Authenticator, 1Password, Authy…) when you sign in with your password.")}</p>
        {setup ? (
          <form onSubmit={confirm} className="auth-fields">
            <p>{t("Scan this QR code with your authenticator app, then enter the 6-digit code it shows.")}</p>
            <img src={setup.qr} alt="" width={180} height={180} style={{ background: "#fff", borderRadius: 8 }} />
            <p className="faint" style={{ fontSize: 13 }}>{t("Or enter this key manually")}: <span className="mono">{setup.secret}</span></p>
            <div className="callout backup">
              <b>{t("Backup codes")}</b>
              <ul className="backup-codes mono">{setup.codes.map((c) => <li key={c}>{c}</li>)}</ul>
              <small>{t("Save these somewhere safe. Each one signs you in once if you lose your device.")}</small>
            </div>
            <label className="fld">{t("Verification code")}<input className="in mono" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" /></label>
            {err && <p className="err">{err}</p>}
            <div><button className="btn primary" disabled={busy}>{t("Turn on")}</button></div>
          </form>
        ) : me.twoFactorEnabled ? (
          <form onSubmit={disable} className="auth-fields">
            <p className="state-ok"><span className="show-tick" aria-hidden="true">✓</span>{t("Two-step verification is on.")}</p>
            <label className="fld">{t("Password")}<input className="in" type="password" required value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" /></label>
            <div><button className="btn" disabled={busy}>{t("Turn off")}</button></div>
          </form>
        ) : (
          <form onSubmit={enable} className="auth-fields">
            <label className="fld">{t("Password")}<input className="in" type="password" required value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" /></label>
            <div><button className="btn primary" disabled={busy}>{t("Set up")}</button></div>
          </form>
        )}
      </div>
      <div className="card sect">
        <h3>{t("Your data")}</h3>
        <p className="muted" style={{ marginBottom: 12 }}>{t("Download a JSON copy of your profile, sessions and the workspaces you manage.")}</p>
        <div><a className="btn" href="/api/me/export" download="montral-account-export.json">{t("Download my data")}</a></div>
      </div>
      <div className="card sect">
        <h3 style={{ color: "var(--down)" }}>{t("Delete account")}</h3>
        <p className="muted" style={{ marginBottom: 12 }}>{t("Permanently deletes your account, and any workspace where you are the only member, with its monitors, incidents and status pages. This cannot be undone.")}</p>
        {!confirmDel ? <div><button className="btn" onClick={() => { reset(); setStale(false); setConfirmDel(true); }}>{t("Delete my account…")}</button></div> : (
          <form onSubmit={remove} className="auth-fields">
            {hasPassword
              ? <label className="fld">{t("Password")}<input className="in" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" /></label>
              : <p className="muted">{stale
                ? t("For your security, sign in with GitHub again, then come back and delete the account.")
                : t("You have no password, so deleting needs a recent sign-in. If it asks, sign in with GitHub again.")}</p>}
            {err && <p className="err">{err}</p>}
            <div style={{ display: "flex", gap: 10 }}>
              {stale
                ? <button type="button" className="btn primary" disabled={busy} onClick={reauth}>{t("Sign in with GitHub again")}</button>
                : <button className="btn primary" style={{ background: "var(--down)" }} disabled={busy}>{t("Delete permanently")}</button>}
              <button type="button" className="btn" onClick={() => { setConfirmDel(false); setStale(false); setPw(""); }}>{t("Cancel")}</button>
            </div>
          </form>
        )}
      </div>
      {msg && <p className="muted">{msg}</p>}
    </>
  );
}

type Linked = { id: string; providerId: string };
type GithubProfile = { login?: string; name?: string; email?: string | null; image?: string };

/** GitHub (when the server has it configured) as a second way to sign in, never the only way removed. */
function ConnectedAccounts({ accounts, load }: { accounts: Linked[] | null; load: () => void }) {
  const [github, setGithub] = useState(false);
  const [profile, setProfile] = useState<GithubProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    fetch("/api/auth-providers").then((r) => r.json()).then((d: { github?: boolean }) => setGithub(!!d.github)).catch(() => {});
    const q = new URLSearchParams(location.search);
    if (q.has("link_error")) setErr(t("GitHub could not be connected. It may already be linked to another account."));
    if (q.has("linked")) toast(t("GitHub connected."));
    if (q.has("linked") || q.has("link_error")) history.replaceState(null, "", location.pathname);
  }, []);
  const linkedId = accounts?.find((a) => a.providerId === "github")?.id;
  useEffect(() => {
    setProfile(null);
    if (!linkedId) return;
    // asks GitHub who the linked account is; the card still works if that fails
    authClient.accountInfo({ query: { accountId: linkedId } }).then((r) => {
      const d = r.data as { user?: { name?: string; email?: string | null; image?: string }; data?: { login?: string } } | null;
      if (d) setProfile({ login: d.data?.login, name: d.user?.name, email: d.user?.email, image: d.user?.image });
    }).catch(() => {});
  }, [linkedId]);
  if (!github || !accounts) return null;
  const linked = accounts.find((a) => a.providerId === "github");
  // the account must keep another way in: a password or another provider
  const onlyWay = accounts.length <= 1;
  async function connect() {
    setErr(""); setBusy(true);
    const r = await authClient.linkSocial({ provider: "github", callbackURL: "/app/account?linked=1", errorCallbackURL: "/app/account?link_error=1" });
    if (r.error) { setErr(r.error.message ?? t("Something went wrong")); toast(t("Something went wrong"), "err"); setBusy(false); }
  }
  async function disconnect() {
    if (!linked) return;
    setErr(""); setBusy(true);
    const r = await authClient.unlinkAccount({ accountId: linked.id });
    setBusy(false);
    if (r.error) { setErr(r.error.message ?? t("Something went wrong")); toast(t("Something went wrong"), "err"); return; }
    toast(t("GitHub disconnected."));
    load();
  }
  return (
    <div className="card sect">
      <h3>{t("Connected accounts")}</h3>
      <p className="muted" style={{ marginBottom: 12 }}>{t("Sign in with GitHub as well as with your email. The GitHub email may differ from your account email.")}</p>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderTop: "1px solid var(--line)" }}>
        {profile?.image
          ? <img src={profile.image} alt="" width={36} height={36} style={{ borderRadius: "50%", flex: "none" }} />
          : <svg width="36" height="36" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" style={{ flex: "none" }}><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>GitHub</div>
          <div className="muted" style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {linked ? (profile?.login ? `@${profile.login}` : profile?.name || profile?.email || t("Connected")) : t("Not connected")}
            {linked && profile?.login && profile.email ? ` · ${profile.email}` : ""}
          </div>
        </div>
        {linked
          ? <button className="btn" disabled={busy || onlyWay} onClick={disconnect}>{t("Disconnect")}</button>
          : <button className="btn" disabled={busy} onClick={connect}>{t("Connect")}</button>}
      </div>
      {accounts.length > 0 && !accounts.some((a) => a.providerId === "credential") && (
        <p className="faint" style={{ marginTop: 10, fontSize: 13 }}>
          {t("You have not set a password. Use the forgot-password email to set one.")} <a href="/forgot-password">{t("Set a password")}</a>
        </p>
      )}
      {linked && onlyWay && <p className="faint" style={{ marginTop: 10, fontSize: 13 }}>{t("GitHub is your only way to sign in, so it cannot be disconnected.")}</p>}
      {err && <p className="err" style={{ marginTop: 10 }}>{err}</p>}
    </div>
  );
}

/**
 * Single sign-on for an existing account: linking needs this signed-in session, so an identity provider can never take
 * over an account merely because it reports the same email address.
 */
function SsoLink({ accounts }: { accounts: Linked[] | null }) {
  const [offered, setOffered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    fetch("/api/auth-providers").then((r) => r.json()).then((d: { sso?: boolean }) => setOffered(!!d.sso)).catch(() => {});
    const q = new URLSearchParams(location.search);
    const failed = q.get("sso_error");
    if (failed) setErr(t(SSO_ERRORS[failed] ?? "Something went wrong"));
    if (q.get("sso") === "linked") toast(t("Single sign-on linked."));
    if (failed || q.has("sso")) history.replaceState(null, "", location.pathname);
  }, []);
  const linked = (accounts ?? []).filter((a) => a.providerId.startsWith("sso:")).length;
  if (!offered && !linked && !err) return null;
  async function link() {
    setErr(""); setBusy(true);
    const problem = await startSso({ intent: "link", returnTo: "/app/account" }).catch(() => t("Something went wrong"));
    if (problem) { setErr(problem); setBusy(false); }
  }
  return (
    <div className="card sect">
      <h3>{t("Single sign-on")}</h3>
      <p className="muted" style={{ marginBottom: 12 }}>{t("Link your company's identity provider to this account, then sign in with SSO. The provider must confirm this account's email address.")}</p>
      <p style={{ marginBottom: 12 }}>{linked ? t("Linked") : t("Not linked")}</p>
      {offered && <button className="btn" disabled={busy} onClick={link}>{busy ? t("Redirecting…") : t("Link single sign-on")}</button>}
      {err && <p className="err" role="alert" style={{ marginTop: 10 }}>{err}</p>}
    </div>
  );
}

/** Personal settings: who you are and which language emails (and the app) use. API keys live on their own page. */
type Sess = { id: string; token: string; userAgent?: string | null; ipAddress?: string | null; createdAt: string; updatedAt: string };

/** "Chrome on Windows", read from the stored user agent; the raw string stays out of the page. */
function device(ua?: string | null): string {
  if (!ua) return t("Unknown device");
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /Montral/i.test(ua) ? "Montral app" : t("Browser");
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? t("{browser} on {os}").replace("{browser}", browser).replace("{os}", os) : browser;
}

/**
 * Where the user is signed in, with sign-out per session and for every other session. Better Auth asks for a recent
 * sign-in before it lists sessions; when it refuses, the card says so instead of showing an empty list. Session tokens
 * are only held in memory to revoke a session and are never shown.
 */
const SESSIONS_CHANGED = "montral:sessions";

/** Sign out here, then come back to Account after signing in: Better Auth lists sessions only for a recent sign-in. */
async function signInAgain() {
  await fetch("/api/auth/sign-out", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => {});
  go(`/login?next=${encodeURIComponent("/app/account")}`);
}

function Sessions() {
  const [list, setList] = useState<Sess[] | null>(null);
  // null: the current session is unknown, so no row offers a sign-out (it could be this one)
  const [current, setCurrent] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const load = async () => {
    setErr(""); setStale(false);
    const [l, s] = await Promise.all([authClient.listSessions(), authClient.getSession()]);
    if (l.error) {
      setList([]);
      if (l.error.code === "SESSION_NOT_FRESH") setStale(true);
      else setErr(t("Could not load sessions."));
      return;
    }
    setCurrent((s.data as { session?: { id: string } } | null)?.session?.id ?? null);
    // the client may hand back Date objects or ISO strings; keep ISO strings
    const iso = (v: unknown) => new Date(v as string | Date).toISOString();
    const rows: Sess[] = (l.data ?? []).map((s) => ({ id: s.id, token: s.token, userAgent: s.userAgent, ipAddress: s.ipAddress, createdAt: iso(s.createdAt), updatedAt: iso(s.updatedAt) }))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    setList(rows);
  };
  useEffect(() => {
    const reload = () => { load().catch(() => { setList([]); setErr(t("Could not load sessions.")); }); };
    reload();
    window.addEventListener(SESSIONS_CHANGED, reload);
    return () => window.removeEventListener(SESSIONS_CHANGED, reload);
  }, []);
  const end = async (s: Sess) => {
    setBusy(s.id);
    try {
      const r = await authClient.revokeSession({ token: s.token });
      if (r.error) toast(r.error.message ?? t("Could not sign out that session."), "err"); else toast(t("Signed out of that session."));
      await load();
    } finally { setBusy(""); }
  };
  const endOthers = async () => {
    if (!(await ask(t("Sign out everywhere except this device? Each of those sessions will need to sign in again."), t("Sign out other sessions")))) return;
    setBusy("others");
    try {
      const r = await authClient.revokeOtherSessions();
      if (r.error) toast(r.error.message ?? t("Could not sign out the other sessions."), "err"); else toast(t("Signed out of every other session."));
      await load();
    } finally { setBusy(""); }
  };
  const others = current === null ? [] : (list ?? []).filter((s) => s.id !== current);
  const lang = document.documentElement.lang || undefined;
  return (
    <div className="card sect">
      <h3>{t("Sessions")}</h3>
      {/* the API trusts a signed session cookie for up to 5 minutes, so a sign-out is not instant everywhere */}
      <p className="muted" style={{ marginBottom: 12 }}>{t("Devices and browsers signed in to your account. A session you sign out stops working within 5 minutes.")}</p>
      {list === null && <p className="muted">{t("Loading…")}</p>}
      {err && <p className="muted" role="status">{err}</p>}
      {stale && (
        <div className="sess-stale" role="status">
          <p className="muted">{t("For your security, the list of sessions needs a sign-in from the last 24 hours.")}</p>
          <div className="sess-acts">
            <button type="button" className="btn sm" onClick={() => void signInAgain()}>{t("Sign out and sign in again")}</button>
            {/* ending the other sessions does not need a recent sign-in */}
            <button type="button" className="btn sm danger-l" disabled={!!busy} onClick={() => void endOthers()}>{busy === "others" ? t("Signing out…") : t("Sign out other sessions")}</button>
          </div>
        </div>
      )}
      {list && list.length > 0 && (
        <ul className="sess">
          {list.map((s) => (
            <li key={s.id}>
              <div className="sess-d">
                <b>{device(s.userAgent)}</b>
                <small>{s.ipAddress ? <span className="mono">{s.ipAddress}</span> : null}{s.ipAddress ? " · " : ""}{t("Last active")} {new Date(s.updatedAt).toLocaleString(lang, { dateStyle: "medium", timeStyle: "short" })} · {t("Signed in")} {new Date(s.createdAt).toLocaleDateString(lang)}</small>
              </div>
              {s.id === current
                ? <span className="pill up">{t("This device")}</span>
                : current === null ? null
                : <button type="button" className="btn sm" disabled={!!busy} onClick={() => void end(s)}>{busy === s.id ? t("Signing out…") : t("Sign out")}<span className="sr-only"> {device(s.userAgent)}, {t("signed in")} {new Date(s.createdAt).toLocaleDateString(lang)}</span></button>}
            </li>
          ))}
        </ul>
      )}
      {others.length > 0 && (
        <button type="button" className="btn sm danger-l" style={{ marginTop: 12 }} disabled={!!busy} onClick={() => void endOthers()}>
          {busy === "others" ? t("Signing out…") : t("Sign out other sessions")}
        </button>
      )}
    </div>
  );
}

/** Change the password while signed in (accounts that have one); optionally end every other session. */
function PasswordChange() {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [others, setOthers] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setErr("");
    if (next.length < 8) { setErr(t("Use at least 8 characters.")); return; }
    if (next === cur) { setErr(t("The new password must differ from the current one.")); return; }
    setBusy(true);
    try {
      // Never let Better Auth revoke sessions inside the password change: it would delete this session as well and
      // create a new one, which a workspace that requires single sign-on refuses, leaving the person signed out
      // everywhere. Ending the other sessions is a separate call that keeps this one.
      const r = await authClient.changePassword({ currentPassword: cur, newPassword: next, revokeOtherSessions: false });
      if (r.error) {
        const code = r.error.code;
        setErr(code === "INVALID_PASSWORD" ? t("The current password is not right.") : code === "PASSWORD_TOO_SHORT" ? t("Use at least 8 characters.") : r.error.status === 429 ? t("Too many attempts. Wait a minute and try again.") : t("Could not change the password."));
        return;
      }
      setCur(""); setNext("");
      if (others) {
        const o = await authClient.revokeOtherSessions();
        toast(o.error ? t("Password changed, but the other sessions could not be signed out.") : t("Password changed. Other sessions were signed out."), o.error ? "err" : "ok");
      } else toast(t("Password changed."));
      window.dispatchEvent(new Event(SESSIONS_CHANGED));
    } finally { setBusy(false); }
  };
  return (
    <form className="card sect pw-change" onSubmit={submit}>
      <h3>{t("Password")}</h3>
      <label className="fld">{t("Current password")}<input className="in" type="password" autoComplete="current-password" required value={cur} onChange={(e) => setCur(e.target.value)} /></label>
      <label className="fld">{t("New password")}<input className="in" type="password" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} aria-describedby="pw-hint" /></label>
      <small id="pw-hint" className="faint">{t("At least 8 characters.")}</small>
      <label className="chk"><input type="checkbox" checked={others} onChange={(e) => setOthers(e.target.checked)} /> {t("Sign out of every other session")}</label>
      {err && <p className="err" role="alert">{err}</p>}
      <div><button className="btn primary sm" disabled={busy || !cur || !next}>{busy ? t("Saving…") : t("Change password")}</button></div>
    </form>
  );
}

/**
 * Phones that receive push alerts for this person (registered by the iOS app). Hidden on a server without Apple push
 * and no phones, so nothing suggests push delivery that this deployment cannot make. Device tokens are only used to
 * remove a phone and are never shown.
 */
function Phones() {
  const [devices, setDevices] = useState<PushDevice[] | null>(null);
  // null until known: a failed /config must not claim that push is not configured
  const [apns, setApns] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState("");
  const load = () => api.pushDevices().then((d) => { setDevices(d); setFailed(false); }).catch(() => setFailed(true));
  useEffect(() => { load(); api.config().then((c) => setApns(!!c.push?.apns)).catch(() => {}); }, []);
  // a failed list is not "no phones": hide the card rather than say something untrue
  if (failed || devices === null || (apns !== true && devices.length === 0)) return null;
  const remove = async (d: PushDevice) => {
    const name = d.name || t("iPhone");
    if (!(await ask(t("Stop push alerts to {name}? The app turns them back on the next time it registers the phone. To stop them for good, also sign that phone out under Sessions.").replace("{name}", name), t("Remove phone")))) return;
    setBusy(d.id);
    try { await api.removePushDevice(d.token); toast(t("Phone removed.")); await load(); }
    catch (e) { toast((e as Error).message, "err"); }
    finally { setBusy(""); }
  };
  return (
    <div className="card sect">
      <h3>{t("Phones")}</h3>
      <p className="muted" style={{ marginBottom: 12 }}>{t("Phones signed in to the Montral iOS app receive push alerts from the channels you are part of.")}</p>
      {apns === false && <p className="muted" role="status">{t("Push delivery is not configured on this server, so these phones get no alerts.")}</p>}
      {devices.length === 0
        ? <p className="muted">{t("No phones yet.")} <a className="auth-link" href="/ios">{t("Get the iOS app")}</a></p>
        : (
          <ul className="sess">
            {devices.map((d) => (
              <li key={d.id}>
                <div className="sess-d">
                  <b>{d.name || t("iPhone")}</b>
                  <small>{[d.environment === "sandbox" ? t("Development build") : null, d.critical ? t("Critical alerts on") : null].filter(Boolean).join(" · ") || t("Push alerts on")}</small>
                </div>
                <button type="button" className="btn sm" disabled={!!busy} onClick={() => void remove(d)}>{busy === d.id ? t("Removing…") : t("Remove")}<span className="sr-only"> {d.name || t("iPhone")}</span></button>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}

export default function Account() {
  const [me, setMe] = useState<Me | null>(null);
  const [saved, setSaved] = useState(false);
  const load = () => api.me().then((m) => setMe(m.user)).catch(() => {});
  const [accounts, setAccounts] = useState<Linked[] | null>(null);
  const loadAccounts = () => authClient.listAccounts().then((r) => setAccounts((r.data as Linked[] | null) ?? [])).catch(() => setAccounts([]));
  useEffect(() => { load(); loadAccounts(); }, []);
  const current: Locale = me?.locale === "zh-CN" ? "zh-CN" : me?.locale === "en" ? "en" : document.documentElement.lang === "zh-CN" ? "zh-CN" : "en";
  async function pick(l: Locale) {
    setSaved(false);
    await api.setLocale(l);
    // the app itself follows the same choice (cookie read by every page)
    if (l !== document.documentElement.lang) { switchLocale(l); return; }
    setMe((m) => (m ? { ...m, locale: l } : m));
    setSaved(true);
  }
  return (
    <>
      <div className="ph"><div><h1>{t("Account")}</h1><p className="muted">{t("Personal settings, shared across all your projects.")}</p></div></div>
      <div className="set-wrap">
        {me?.email && (
          <div className="card sect" >
            <h3>{t("Profile")}</h3>
            <div className="kv">
              <div><span>{t("Name")}</span><b>{me.name}</b></div>
              <div><span>{t("Email")}</span><b className="mono">{me.email}</b></div>
            </div>
          </div>
        )}
        {me && (
          <div className="card sect">
            <h3>{t("Language")}</h3>
            <p className="muted" style={{ marginBottom: 12 }}>{t("Used for the app and for emails we send you, such as alerts, invitations and password resets.")}</p>
            <Segmented label={t("Language")} style={{ maxWidth: 360 }} value={current} onChange={(l) => pick(l)} options={(Object.keys(LOCALES) as Locale[]).map((l) => ({ value: l, label: LOCALES[l] }))} />
            {saved && <p className="faint" style={{ marginTop: 10, fontSize: 13 }}>{t("Saved")}</p>}
          </div>
        )}
        {me && <ConnectedAccounts accounts={accounts} load={loadAccounts} />}
        {me && <SsoLink accounts={accounts} />}
        {me && accounts?.some((a) => a.providerId === "credential") && <PasswordChange />}
        {me && <Sessions />}
        {me && <Phones />}
        {me && <Security me={me} reload={load} hasPassword={!accounts || accounts.length === 0 || accounts.some((a) => a.providerId === "credential")} />}
      </div>
    </>
  );
}
