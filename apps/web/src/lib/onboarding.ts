/**
 * First-run checklist on the Monitors dashboard. Every step's state is derived from the workspace's real data (monitors,
 * alert channels, status pages), never from stored progress flags; only "hide this checklist" is remembered, in the
 * browser, per workspace. The dashboard now uses a per-user, per-workspace server record;
 * the legacy storage helpers below are retained only for old clients/tests and are not read by the current UI.
 */

export type OnboardingCounts = { monitors: number; channels: number; statusPages: number };
export type OnboardingStepKey = "workspace" | "monitor" | "channel" | "status-page";
export type OnboardingStep = { key: OnboardingStepKey; done: boolean; optional: boolean };

export function onboardingSteps(c: OnboardingCounts): OnboardingStep[] {
  return [
    { key: "workspace", done: true, optional: false },
    { key: "monitor", done: c.monitors > 0, optional: false },
    { key: "channel", done: c.channels > 0, optional: false },
    { key: "status-page", done: c.statusPages > 0, optional: true },
  ];
}

/** Set up enough to be told about an outage: a monitor and somewhere for its alerts to go. A status page is optional. */
export const onboardingComplete = (c: OnboardingCounts) => onboardingSteps(c).every((s) => s.done || s.optional);

/** `done / total` for the chip next to the checklist title. */
export function onboardingProgress(c: OnboardingCounts): { done: number; total: number } {
  const steps = onboardingSteps(c);
  return { done: steps.filter((s) => s.done).length, total: steps.length };
}

/**
 * Whether the checklist shows: not in the read-only "All projects" view, not once the required steps are done, and not
 * after the visitor hid it for this workspace. With no monitors yet it always shows, since that is the empty state.
 */
export function showOnboarding(c: OnboardingCounts, opts: { allProjects: boolean; dismissed: boolean }): boolean {
  if (opts.allProjects) return false;
  if (c.monitors === 0) return true;
  return !opts.dismissed && !onboardingComplete(c);
}

const KEY = "montral_onboarding_hidden:";
type KV = Pick<Storage, "getItem" | "setItem">;
const local = (): KV | null => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };

export function onboardingDismissed(orgId: string | null | undefined, storage: KV | null = local()): boolean {
  if (!orgId || !storage) return false;
  try { return storage.getItem(KEY + orgId) === "1"; } catch { return false; }
}

export function dismissOnboarding(orgId: string | null | undefined, storage: KV | null = local()): void {
  if (!orgId || !storage) return;
  try { storage.setItem(KEY + orgId, "1"); } catch { /* private mode: hidden for this page view only */ }
}
