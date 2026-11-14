import { useEffect, useId, useState } from "react";
import { api, type ScimStatus } from "../lib/api";
import { t } from "../lib/i18n";
import { ask } from "../lib/confirm";

/**
 * SCIM provisioning for the workspace, under the single sign-on settings (owner only, like them). The token is shown
 * once, right after it is created; replacing it revokes the old one.
 */
export default function ScimSettings() {
  const [status, setStatus] = useState<ScimStatus | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const help = useId();
  const load = () => api.scim().then(setStatus).catch(() => setStatus(null));
  useEffect(() => { load(); }, []);
  if (!status) return null;

  async function run(work: () => Promise<void>) {
    setErr(""); setBusy(true);
    try { await work(); await load(); } catch (e) { setErr((e as Error).message || t("Something went wrong")); }
    setBusy(false);
  }
  const create = () => run(async () => { setToken((await api.createScimToken()).token); });
  const off = () => run(async () => {
    if (!(await ask(t("Turn off SCIM provisioning? Your identity provider will no longer be able to add or remove people."), t("Turn off")))) return;
    await api.revokeScimToken();
    setToken("");
  });

  return (
    <section className="card" aria-labelledby={help + "-h"} style={{ marginTop: 16 }}>
      <h3 id={help + "-h"} style={{ marginTop: 0 }}>{t("SCIM provisioning")}</h3>
      <p className="faint" id={help} style={{ fontSize: 13 }}>{t("Lets your identity provider add, deactivate and remove people. Once it is on, single sign-on admits only people the provider assigned; deactivating someone ends their membership, signs them out and revokes their API keys for this workspace.")}</p>
      <div className="kv">
        <div><span>{t("Status")}</span><b>{status.enabled ? t("On") : t("Off")}</b></div>
        <div><span>{t("Base URL")}</span><b className="mono" style={{ overflowWrap: "anywhere" }}>{status.baseUrl}</b></div>
        {status.enabled && <div><span>{t("People")}</span><b>{t("{active} active, {inactive} deactivated").replace("{active}", String(status.users.active)).replace("{inactive}", String(status.users.inactive))}</b></div>}
      </div>
      {token && (
        <div role="status">
          <p><strong>{t("Copy this token into your identity provider now. It is shown only once.")}</strong></p>
          <input className="in mono" readOnly value={token} aria-label={t("SCIM token")} onFocus={(e) => e.currentTarget.select()} />
        </div>
      )}
      {err && <p className="err" role="alert">{err}</p>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        <button type="button" className="btn" disabled={busy} onClick={create} aria-describedby={help}>{status.enabled ? t("Replace token") : t("Turn on SCIM")}</button>
        {status.enabled && <button type="button" className="btn" disabled={busy} onClick={off}>{t("Turn off")}</button>}
      </div>
    </section>
  );
}
