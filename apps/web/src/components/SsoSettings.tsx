import { useEffect, useId, useState } from "react";
import { api, ApiError, type SsoSettings as Sso } from "../lib/api";
import { t } from "../lib/i18n";
import { toast } from "../lib/toast";
import ScimSettings from "./ScimSettings";
import { ask } from "../lib/confirm";

/**
 * Single sign-on (OpenID Connect) for the workspace, on the Settings page. Only the owner sees it (the API answers 403
 * to everyone else, and then nothing is shown). The client secret is write-only: the field stays empty and leaving it
 * empty keeps the stored secret.
 */
export default function SsoSettings() {
  const [data, setData] = useState<Sso | null>(null);
  const [hidden, setHidden] = useState(false);
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [domains, setDomains] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [requireSso, setRequireSso] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const ids = { help: useId(), domains: useId(), require: useId() };

  const fill = (d: Sso) => {
    setData(d);
    const c = d.connection;
    setIssuer(c?.issuer ?? "");
    setClientId(c?.clientId ?? "");
    setSecret("");
    setDomains(c?.domains.map((x) => x.domain).join("\n") ?? "");
    setRole(c?.defaultRole ?? "member");
    setRequireSso(c?.requireSso ?? false);
    setEnabled(c?.enabled ?? true);
  };
  useEffect(() => {
    api.sso().then(fill).catch((e) => { if (e instanceof ApiError && e.status === 403) setHidden(true); });
  }, []);
  if (hidden || !data) return null;
  const c = data.connection;

  async function run(work: () => Promise<void>) {
    setErr(""); setNote(""); setBusy(true);
    try { await work(); } catch (e) { setErr((e as Error).message || t("Something went wrong")); }
    setBusy(false);
  }
  const save = (e: React.SyntheticEvent) => {
    e.preventDefault();
    return run(async () => {
      const r = await api.saveSso({ issuer, clientId, clientSecret: secret || undefined, domains: domains.split(/[\s,]+/).filter(Boolean), defaultRole: role, requireSso, enabled });
      fill(r);
      if (r.warning) setNote(t("Saved, but single sign-on can only be required once a domain is verified."));
      else toast(t("Single sign-on saved."));
    });
  };
  const test = () => run(async () => {
    const r = await api.testSso(issuer);
    setNote(t("The provider answered. Token endpoint: {url}").replace("{url}", r.tokenEndpoint));
  });
  const verify = (domain: string) => run(async () => {
    await api.verifySsoDomain(domain);
    fill(await api.sso());
    toast(t("Domain verified."));
  });
  const remove = async () => {
    if (!(await ask(t("Delete the single sign-on connection? People who signed in with it and have no password will need to set one."), t("Delete connection")))) return;
    return run(async () => { await api.deleteSso(); fill(await api.sso()); toast(t("Single sign-on deleted.")); });
  };

  return (
    <form className="card sect sso" onSubmit={save} aria-describedby={ids.help}>
      <h3>{t("Single sign-on (OpenID Connect)")}</h3>
      <p className="muted" id={ids.help}>{t("Let people sign in through your identity provider (Keycloak, Authentik, Entra ID, Google Workspace, Okta…). People from verified domains get an account in this workspace on their first sign-in.")} <a href="/docs/self-host#sso">{t("Setup guide")}</a></p>
      <div className="kv">
        <div><span>{t("Redirect URI")}</span><b className="mono" style={{ overflowWrap: "anywhere" }}>{data.callbackUrl}</b></div>
      </div>
      <label className="fld">{t("Issuer URL")}<input className="in mono" type="url" required value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://idp.example.com/realms/acme" autoComplete="off" /></label>
      <label className="fld">{t("Client ID")}<input className="in mono" required value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" /></label>
      <label className="fld">{t("Client secret")}<input className="in mono" type="password" required={!c || issuer.trim() !== c.issuer || clientId.trim() !== c.clientId} value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" placeholder={c && issuer.trim() === c.issuer && clientId.trim() === c.clientId ? t("Stored. Leave empty to keep it.") : ""} /></label>
      <label className="fld">{t("Email domains")}<textarea className="in mono" rows={2} value={domains} onChange={(e) => setDomains(e.target.value)} aria-describedby={ids.domains} placeholder="example.com" /></label>
      <p className="faint" id={ids.domains} style={{ fontSize: 13, marginTop: -6 }}>{t("One per line. Each domain must be verified with a DNS TXT record before anyone from it can sign in.")}</p>
      <label className="fld">{t("Role for new people")}
        <select className="in" value={role} onChange={(e) => setRole(e.target.value === "admin" ? "admin" : "member")}>
          <option value="member">{t("Member")}</option>
          <option value="admin">{t("Admin")}</option>
        </select>
      </label>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />{t("Enabled")}</label>
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <input type="checkbox" checked={requireSso} onChange={(e) => setRequireSso(e.target.checked)} aria-describedby={ids.require} style={{ marginTop: 3 }} />
        <span>{t("Require single sign-on for this workspace")}<small className="muted" id={ids.require} style={{ display: "block" }}>{t("Members can then reach this workspace only through this provider: their other sessions are signed out, and API keys and agent authorizations they made without SSO stop working here. You, the owner, keep password sign-in as the break-glass account: protect it with two-step verification.")}</small></span>
      </label>
      {c && c.domains.length > 0 && (
        <table className="audit-tbl sso-domains">
          <caption className="sr-only">{t("Email domains")}</caption>
          <thead><tr><th scope="col">{t("Domain")}</th><th scope="col">{t("TXT record")}</th><th scope="col">{t("Status")}</th></tr></thead>
          <tbody>
            {c.domains.map((d) => (
              <tr key={d.domain}>
                <td className="mono">{d.domain}</td>
                <td className="mono" style={{ overflowWrap: "anywhere", fontSize: 12.5 }}>{d.verified ? "—" : <>{d.txtName}<br />{d.txtValue}</>}</td>
                <td>{d.checkError && <small className="err" style={{ display: "block" }}>{t(d.verified ? "TXT record not found at the last check" : "Verification withdrawn: the TXT record is gone")}</small>}{d.verified ? t("Verified") : <button type="button" className="btn" disabled={busy} onClick={() => verify(d.domain)}>{t("Verify")}<span className="sr-only"> {d.domain}</span></button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data.instanceProvider && <p className="faint" style={{ fontSize: 13 }}>{t("This server also has an instance-wide provider configured by its operator.")}</p>}
      {err && <p className="err" role="alert">{err}</p>}
      {note && <p className="faint" role="status">{note}</p>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn primary" disabled={busy}>{busy ? t("Saving…") : t("Save changes")}</button>
        <button type="button" className="btn" disabled={busy || !issuer} onClick={test}>{t("Test connection")}</button>
        {c && <button type="button" className="btn" disabled={busy} onClick={remove}>{t("Delete")}</button>}
      </div>
      {c && <ScimSettings />}
    </form>
  );
}
