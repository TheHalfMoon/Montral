import { useEffect, useState } from "react";
import { api, type BillingStatus } from "../lib/api";
import { t } from "../lib/i18n";

/** A clear test-mode-only storefront. A real subscription is never enabled by client success. */
export default function Billing() {
  const [state, setState] = useState<BillingStatus | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<"pro" | "business" | null>(null);
  useEffect(() => {
    api.billingStatus().then(setState).catch((e) => setError((e as Error).message));
  }, []);
  const choose = async (plan: "pro" | "business") => {
    if (!state?.billingConfigured) return;
    setPending(plan); setError("");
    try {
      const { url, testMode } = await api.billingCheckout(plan);
      if (!testMode) throw new Error(t("The checkout must run in test mode only."));
      // A click opens the test store, never a hidden charge or automatic navigation.
      window.location.assign(url);
    } catch (e) {
      setError((e as Error).message);
      setPending(null);
    }
  };
  return <section>
    <div className="ph"><div>
      <h1>{t("Billing")}</h1>
      <p className="muted">{t("Montral private preview — no live subscriptions or charges.")}</p>
    </div></div>
    <div className="card sect" style={{ marginBottom: 20 }}>
      <h2>{t("Current subscription")}</h2>
      {!state && !error && <p className="muted">{t("Loading…")}</p>}
      {state && <>
        <p><strong>{t("Plan")}:</strong> {state.plan.toUpperCase()}</p>
        <p><strong>{t("Status")}:</strong> {state.status}</p>
        <p className="muted">{state.billingConfigured
          ? t("Sandbox merchant configured. All checkout links are test-mode only.")
          : t("Checkout is not configured. Montral will not contact a payment provider.")}</p>
      </>}
      {error && <p role="alert" className="err">{error}</p>}
    </div>
    <div className="grid2">
      {(["pro", "business"] as const).map((plan) => <div className="card sect" key={plan}>
        <h2>{plan === "pro" ? "Pro" : "Business"}</h2>
        <p className="muted">{t("Pricing is confirmed by the payment provider's test checkout, not this preview.")}</p>
        <button className="btn primary" disabled={!state?.billingConfigured || !!pending} onClick={() => choose(plan)}>
          {pending === plan ? t("Creating…") : t("Open test checkout")}
        </button>
      </div>)}
    </div>
    <p className="muted" style={{ marginTop: 18 }}>{t("A signed subscription event must be validated by the Montral server. Visiting a checkout success page never upgrades your account.")}</p>
  </section>;
}
