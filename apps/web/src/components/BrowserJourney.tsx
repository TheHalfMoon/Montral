import { useEffect, useState } from "react";
import { api, type BrowserJourney, type BrowserRun, type BrowserRuntime } from "../lib/api";
import { t } from "../lib/i18n";
import Select from "./Select";

/** The mask the API shows for every stored secret; sending it back keeps the stored value. */
export const SECRET_MASK = "••••••••";

/** One step as edited: the action plus its fields as text (converted on save). */
export type StepDraft = { action: string; url?: string; selector?: string; value?: string; secretRef?: string; key?: string; text?: string; contains?: string; equals?: string; pattern?: string; code?: string; timeoutMs?: string };

const ACTIONS = ["goto", "click", "fill", "press", "waitFor", "assertText", "assertUrl", "assertStatus"] as const;
const LABEL: Record<string, string> = { goto: "Open URL", click: "Click", fill: "Fill in", press: "Press key", waitFor: "Wait for", assertText: "Check text", assertUrl: "Check URL", assertStatus: "Check status" };
export const MAX_JOURNEY_STEPS = 20;

export const draftsOf = (j: BrowserJourney | null | undefined): StepDraft[] =>
  j?.steps?.length
    ? j.steps.map((s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, String(v)])) as StepDraft)
    : [{ action: "goto", url: "https://" }];

/** The journey the API takes, from the drafts: empty fields dropped, numbers converted. */
export function journeyOf(drafts: StepDraft[], timeoutMs: number, screenshot: "never" | "on_failure"): BrowserJourney {
  const steps = drafts.map((d) => {
    const s: Record<string, unknown> = { action: d.action };
    const keep = (k: keyof StepDraft) => { const v = d[k]; if (v !== undefined && v !== "") s[k] = v; };
    switch (d.action) {
      case "goto": keep("url"); break;
      case "click": keep("selector"); break;
      case "fill": keep("selector"); if (d.secretRef) s.secretRef = d.secretRef; else s.value = d.value ?? ""; break;
      case "press": keep("key"); break;
      case "waitFor": if (d.selector) s.selector = d.selector; else keep("text"); break;
      case "assertText": keep("selector"); if (d.equals !== undefined && d.contains === undefined) s.equals = d.equals; else keep("contains"); break;
      case "assertUrl": keep("pattern"); break;
      case "assertStatus": s.code = Number(d.code) || 200; break;
    }
    if (d.timeoutMs && d.action !== "assertStatus") s.timeoutMs = Number(d.timeoutMs);
    return s;
  });
  return { steps, timeoutMs, screenshot };
}

type EditorProps = {
  steps: StepDraft[]; setSteps: (s: StepDraft[]) => void;
  timeoutMs: number; setTimeoutMs: (n: number) => void;
  screenshot: "never" | "on_failure"; setScreenshot: (v: "never" | "on_failure") => void;
  secrets: { k: string; v: string }[]; setSecrets: (s: { k: string; v: string }[]) => void;
};

/** The step list, the journey's limits and its write-only secrets. */
export function JourneyEditor({ steps, setSteps, timeoutMs, setTimeoutMs, screenshot, setScreenshot, secrets, setSecrets }: EditorProps) {
  const put = (i: number, p: Partial<StepDraft>) => setSteps(steps.map((s, j) => (j === i ? { ...s, ...p } : s)));
  const move = (i: number, d: -1 | 1) => { const n = [...steps]; [n[i], n[i + d]] = [n[i + d], n[i]]; setSteps(n); };
  const names = secrets.map((s) => s.k.trim()).filter(Boolean);
  const field = (i: number, k: keyof StepDraft, label: string, placeholder = "", max = 500) => (
    <input className="in mono" style={{ flex: 2, minWidth: 0 }} value={steps[i][k] ?? ""} placeholder={placeholder} aria-label={t(label)} maxLength={max} onChange={(e) => put(i, { [k]: e.target.value })} />
  );
  return (
    <>
      <div className="fld">{t("Journey steps")}
        <span className="muted" style={{ fontSize: 12.5, fontWeight: 400 }}>{t("Runs in a fresh headless Chromium for every check. Only these step types exist: no scripts of your own run. The first step opens the start page. Requests to private or internal addresses are refused. Checks run at most every 5 minutes.")}</span>
        {steps.map((s, i) => (
          <div key={i} style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6, alignItems: "center" }}>
            <span className="faint mono" style={{ width: 22 }}>{i + 1}.</span>
            <Select className="in" value={s.action} onChange={(v) => put(i, { action: v as string })} options={ACTIONS.filter((a) => i === 0 ? a === "goto" : true).map((a) => ({ value: a, label: t(LABEL[a]) }))} />
            {s.action === "goto" && field(i, "url", "URL", "https://example.com/login", 2048)}
            {(s.action === "click" || s.action === "fill") && field(i, "selector", "Selector", "#email")}
            {s.action === "fill" && (
              <>
                <Select className="in" value={s.secretRef ? `secret:${s.secretRef}` : "value"} onChange={(v) => { const x = String(v); put(i, x.startsWith("secret:") ? { secretRef: x.slice(7), value: undefined } : { secretRef: undefined, value: s.value ?? "" }); }}
                  options={[{ value: "value", label: t("Text") }, ...names.map((n) => ({ value: `secret:${n}`, label: `${t("Secret")}: ${n}` }))]} />
                {!s.secretRef && field(i, "value", "Text to type", "alice@example.com", 1000)}
              </>
            )}
            {s.action === "press" && field(i, "key", "Key", "Enter", 40)}
            {s.action === "waitFor" && (s.selector !== undefined && s.text === undefined ? field(i, "selector", "Selector", "#dashboard") : field(i, "text", "Text", "Welcome"))}
            {s.action === "waitFor" && <button type="button" className="btn" onClick={() => put(i, s.selector !== undefined && s.text === undefined ? { selector: undefined, text: "" } : { text: undefined, selector: "" })}>{t(s.selector !== undefined && s.text === undefined ? "Use text" : "Use selector")}</button>}
            {s.action === "assertText" && <>{field(i, "selector", "Selector (optional)", "h1")}{field(i, "contains", "Must contain", "Welcome")}</>}
            {s.action === "assertUrl" && field(i, "pattern", "URL pattern", "/dashboard*", 2048)}
            {s.action === "assertStatus" && field(i, "code", "Status", "200", 3)}
            {s.action !== "assertStatus" && <input className="in mono" style={{ width: 90 }} value={s.timeoutMs ?? ""} placeholder="10000" aria-label={t("Step timeout (ms)")} onChange={(e) => put(i, { timeoutMs: e.target.value.replace(/\D/g, "") })} />}
            <button type="button" className="btn" disabled={i <= 1} onClick={() => move(i, -1)} aria-label={t("Move up")}>↑</button>
            <button type="button" className="btn" disabled={i === 0 || i === steps.length - 1} onClick={() => move(i, 1)} aria-label={t("Move down")}>↓</button>
            <button type="button" className="btn" disabled={i === 0} onClick={() => setSteps(steps.filter((_, j) => j !== i))}>{t("Remove")}</button>
          </div>
        ))}
        <div><button type="button" className="btn" style={{ marginTop: 8 }} disabled={steps.length >= MAX_JOURNEY_STEPS} onClick={() => setSteps([...steps, { action: "click", selector: "" }])}>{t("Add step")}</button></div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <label className="fld">{t("Journey timeout")}
          <Select className="in" value={timeoutMs} onChange={(v) => setTimeoutMs(Number(v))} options={[10_000, 20_000, 30_000, 45_000, 60_000].map((n) => ({ value: n, label: `${n / 1000} s` }))} />
        </label>
        <label className="fld">{t("Screenshot")}
          <Select className="in" value={screenshot} onChange={(v) => setScreenshot(v as "never" | "on_failure")} options={[{ value: "never", label: t("Never") }, { value: "on_failure", label: t("When a check fails") }]} />
        </label>
      </div>
      <div className="fld">{t("Secrets")}
        <span className="muted" style={{ fontSize: 12.5, fontWeight: 400 }}>{t("Values for fill steps, such as a password. Write-only: they are encrypted and never shown again, also not to admins. Leave •••••••• to keep a stored value. Changing the steps while keeping stored secrets needs an owner or admin. Screenshots of journeys that use secrets are shown to owners and admins only.")}</span>
        {secrets.map((r, i) => (
          <div key={i} style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <input className="in mono" style={{ flex: 1, minWidth: 0 }} value={r.k} placeholder="password" aria-label={t("Secret name")} maxLength={64} onChange={(e) => setSecrets(secrets.map((x, j) => (j === i ? { ...x, k: e.target.value.replace(/[^A-Za-z0-9_]/g, "") } : x)))} />
            <input className="in mono" style={{ flex: 2, minWidth: 0 }} type="password" autoComplete="new-password" value={r.v} aria-label={t("Secret value")} maxLength={1000} onChange={(e) => setSecrets(secrets.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
            <button type="button" className="btn" onClick={() => setSecrets(secrets.filter((_, j) => j !== i))}>{t("Remove")}</button>
          </div>
        ))}
        <div><button type="button" className="btn" style={{ marginTop: 8 }} disabled={secrets.length >= 10} onClick={() => setSecrets([...secrets, { k: "", v: "" }])}>{t("Add secret")}</button></div>
      </div>
    </>
  );
}

/** The latest runs of a browser monitor: per-step timings, the failing step and a screenshot link when one was kept. */
export function BrowserRuns({ monitorId, uncheckedSince }: { monitorId: string; uncheckedSince?: string | null }) {
  const [runs, setRuns] = useState<BrowserRun[] | null>(null);
  const [runtime, setRuntime] = useState<BrowserRuntime | null>(null);
  useEffect(() => { api.browserRuns(monitorId).then((r) => setRuns(r.runs)).catch(() => setRuns([])); }, [monitorId]);
  useEffect(() => { api.browserRuntime().then(setRuntime).catch(() => setRuntime(null)); }, []);
  if (!runs) return null;
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>{t("Browser runs")}</h3>
      {uncheckedSince && <p className="err">{t("Unchecked since {time}: browser checks for this monitor are not running. Owners and admins were notified.").replace("{time}", new Date(uncheckedSince).toLocaleString())}</p>}
      {runtime && (
        <p className="muted" style={{ fontSize: 13 }}>
          {t("Browser runtime")}: {runtime.enabled ? (runtime.mode === "runner" ? t("browser-runner service") : t("on this server")) : t("not enabled")}
          {runtime.available === true ? ` · ${t("available")}` : runtime.available === false ? ` · ${t("unavailable")}` : ""}
          {runtime.lastError ? ` · ${t("last problem")}: ${runtime.lastError}` : ""}
        </p>
      )}
      {runs.length === 0 && <p className="muted">{t("No runs yet.")}</p>}
      {runs.slice(0, 10).map((r) => (
        <div key={r.id} style={{ padding: "8px 0", borderTop: "1px solid var(--line, #8883)" }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
            <b className={r.ok ? "ok" : r.kind === "run" ? "err" : "muted"}>{r.ok ? t("Passed") : r.kind === "deferred" ? t("Deferred (capacity full)") : r.kind === "error" ? t("Not run (browser runtime problem)") : t("Failed")}</b>
            <span className="faint mono">{new Date(r.createdAt).toLocaleString()}</span>
            <span className="faint mono">{r.durationMs} ms</span>
            {r.blockedRequests > 0 && <span className="faint">{t("{n} requests blocked").replace("{n}", String(r.blockedRequests))}</span>}
            {r.hasScreenshot && <a href={`/api/monitors/${monitorId}/browser-runs/${r.id}/screenshot`} target="_blank" rel="noopener noreferrer">{t("Screenshot")}</a>}
          </div>
          {r.error && <div className="err mono" style={{ fontSize: 13 }}>{r.error}</div>}
          <div className="mono faint" style={{ fontSize: 12.5 }}>{r.steps.map((s, i) => `${i + 1}. ${s.action} ${s.ok ? `${s.ms} ms` : "✗"}`).join(" · ")}</div>
        </div>
      ))}
    </div>
  );
}
