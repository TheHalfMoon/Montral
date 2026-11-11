import { t } from "../lib/i18n";
import { onboardingProgress, onboardingSteps, type OnboardingCounts, type OnboardingStepKey } from "../lib/onboarding";

const COPY: Record<OnboardingStepKey, { title: string; sub: string }> = {
  workspace: { title: "Create your workspace", sub: "Your workspace is ready." },
  monitor: { title: "Add your first monitor", sub: "HTTP, TCP, DNS, heartbeat — about 30 seconds." },
  channel: { title: "Connect an alert channel", sub: "Slack, email, Telegram or PagerDuty." },
  "status-page": { title: "Publish a status page", sub: "Give customers one place to check." },
};

/**
 * The first-run checklist of the Monitors dashboard. Each step is done when the workspace really has that thing; the
 * status page is optional. With monitors already there it can be hidden (`onDismiss`).
 */
export default function OnboardingChecklist({ counts, onAddMonitor, onDismiss }: { counts: OnboardingCounts; onAddMonitor: () => void; onDismiss?: () => void }) {
  const steps = onboardingSteps(counts);
  const { done, total } = onboardingProgress(counts);
  const cta = (key: OnboardingStepKey) => {
    if (key === "monitor") return <button className="btn sm primary" onClick={onAddMonitor}>{t("Add monitor")}</button>;
    if (key === "channel") return <a className="btn sm" href="/app/alerting">{t("Connect")}</a>;
    if (key === "status-page") return <a className="btn sm" href="/app/status-pages">{t("Create page")}</a>;
    return null;
  };
  return (
    <section className="onb" aria-labelledby="onb-title">
      <div className="onb-h">
        <div>
          <h2 className="onb-t" id="onb-title">{counts.monitors === 0 ? t("Welcome to Montral.") : t("Finish setting up")}</h2>
          <p className="muted">{t("Four steps to a monitor that wakes you up before your customers notice.")}</p>
        </div>
        <div className="onb-side">
          <span className="chip"><span aria-hidden="true">{done} / {total}</span><span className="sr-only">{t("{done} of {total} steps done").replace("{done}", String(done)).replace("{total}", String(total))}</span></span>
          {onDismiss && <button type="button" className="btn sm" onClick={onDismiss}>{t("Hide checklist")}</button>}
        </div>
      </div>
      <ol className="onb-steps">
        {steps.map((st, i) => (
          <li className={`onb-step ${st.done ? "done" : ""}`} key={st.key} data-step={st.key}>
            <span className="onb-n" aria-hidden="true">{st.done ? "✓" : i + 1}</span>
            <div className="onb-b">
              <b>{t(COPY[st.key].title)}{st.optional && <span className="muted onb-opt"> · {t("Optional")}</span>}</b>
              <small>{st.done && st.key !== "workspace" ? t("Done") : t(COPY[st.key].sub)}</small>
            </div>
            {!st.done && cta(st.key)}
          </li>
        ))}
      </ol>
    </section>
  );
}
