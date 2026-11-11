import { useEffect, useState } from "react";
import { api, type BillingPlan, type BillingStatus } from "../lib/api";
import { t } from "../lib/i18n";

/** Price metadata, shown only when the API returns it (the owner published prices). */
function formatPrice(price: NonNullable<BillingPlan["price"]>): string {
  let amount: string;
  try {
    amount = new Intl.NumberFormat(undefined, { style: "currency", currency: price.currency }).format(price.amountMinor / 100);
  } catch {
    amount = `${(price.amountMinor / 100).toFixed(2)} ${price.currency}`;
  }
  return `${amount} ${price.interval === "year" ? t("per year") : t("per month")}`;
}

/** A clear test-mode-only storefront. A real subscription is never enabled by client success. */
export default function Billing() {
  const [state, setState] = useState<BillingStatus | null>(null);
  const [plans, setPlans] = useState<{ defaultPlan: string; plans: BillingPlan[] } | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    api.billingStatus().then(setState).catch((e) => setError((e as Error).message));
    api.billingPlans().then(setPlans).catch((e) => setError((e as Error).message));
  }, []);
  const choose = async (plan: string) => {
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
  const planName = (id: string) => plans?.plans.find((p) => p.id === id)?.name ?? id.toUpperCase();
  const offered = plans?.plans.filter((p) => p.id !== plans.defaultPlan) ?? [];
  return <section>
    <div className="ph"><div>
      <h1>{t("Billing")}</h1>
      <p className="muted">{t("Montral private preview — no live subscriptions or charges.")}</p>
    </div></div>
    <div className="card sect" style={{ marginBottom: 20 }}>
      <h2>{t("Current subscription")}</h2>
      {!state && !error && <p className="muted">{t("Loading…")}</p>}
      {state && <>
        <p><strong>{t("Plan")}:</strong> {planName(state.plan)}</p>
        <p><strong>{t("Status")}:</strong> {state.status}</p>
        {state.status === "cancelled" && <p className="muted">{state.endsAt && new Date(state.endsAt).getTime() > Date.now()
          ? `${t("Subscription access ends")}: ${new Date(state.endsAt).toLocaleString()}`
          : t("Cancelled subscription: paid access is no longer active.")}</p>}
        {state.paymentState === "refunded" && <p className="muted">{t("A payment was refunded: paid access is no longer active.")}</p>}
        {state.paymentState !== "refunded" && state.graceEndsAt && (new Date(state.graceEndsAt).getTime() > Date.now()
          ? <p className="muted">{`${t("Payment past due. Paid access continues until")}: ${new Date(state.graceEndsAt).toLocaleString()}`}</p>
          : <p className="muted">{t("Payment past due: paid access is paused until a payment succeeds.")}</p>)}
        <p className="muted">{state.billingConfigured
          ? t("Sandbox merchant configured. All checkout links are test-mode only.")
          : t("Checkout is not configured. Montral will not contact a payment provider.")}</p>
      </>}
      {error && <p role="alert" className="err">{error}</p>}
    </div>
    {plans && offered.length === 0 && <p className="muted">{t("No plans are offered for checkout.")}</p>}
    <div className="grid2">
      {offered.map((plan) => <div className="card sect" key={plan.id}>
        <h2>{plan.name}</h2>
        <p className="muted">{plan.price ? formatPrice(plan.price) : t("Pricing is confirmed by the payment provider's test checkout, not this preview.")}</p>
        <button className="btn primary" disabled={!state?.billingConfigured || !plan.checkoutAvailable || !!pending} onClick={() => choose(plan.id)}>
          {pending === plan.id ? t("Creating…") : plan.checkoutAvailable ? t("Open test checkout") : t("Checkout unavailable")}
        </button>
      </div>)}
    </div>
    <p className="muted" style={{ marginTop: 18 }}>{t("A signed subscription event must be validated by the Montral server. Visiting a checkout success page never upgrades your account.")}</p>
  </section>;
}
