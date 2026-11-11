import type { Monitor } from "@montral/repo";
import type { Entitlements } from "./entitlements";

/** The region every monitor starts with: the check runs from the scheduler itself, no probe involved. */
export const AUTO = "auto";

/** Monitor types a probe can run: they need only an outbound connection and no credentials of ours. */
export const PROBE_TYPES = ["http", "tcp", "websocket"] as const;

/** A region id: what a monitor stores and what `PROBE_REGIONS` is keyed by. Not tied to any hosting provider's codes. */
export const REGION_ID = /^[a-z0-9][a-z0-9-]{1,23}$/;

/** Labels for the ids the bundled probe deploys to, so a bare `"us-east": "https://…"` entry reads well in the UI. */
export const REGION_NAMES: Record<string, string> = {
  "us-east": "US East (Virginia)",
  "us-west": "US West (San Francisco)",
  "eu-central": "Europe (Frankfurt)",
  "ap-southeast": "Asia Pacific (Singapore)",
  "ap-northeast": "Asia Pacific (Tokyo)",
};

/**
 * The regions a monitor's checks run from, in the order stored, without duplicates. `auto` when none is set or when the
 * type cannot be probed remotely (database checks carry no credentials of ours to a third party; heartbeats are not
 * checks of ours at all).
 */
export function effectiveRegions(m: Pick<Monitor, "type" | "regions">): string[] {
  if (!(PROBE_TYPES as readonly string[]).includes(m.type)) return [AUTO];
  const list = [...new Set((m.regions ?? []).filter((r) => typeof r === "string" && r))];
  return list.length ? list : [AUTO];
}

/**
 * The regions a monitor runs from under a plan cap of `max` per monitor: the first `max` of its effective regions, in
 * the order stored. A monitor saved under a larger plan (before a downgrade) keeps its list, but is checked and charged
 * for the regions its current plan allows only. Without a cap the stored list is returned unchanged.
 */
export function capRegions(m: Pick<Monitor, "type" | "regions">, max: number | null): string[] {
  const list = effectiveRegions(m);
  if (max === null || list.length <= max) return m.regions;
  return list.slice(0, Math.max(1, max));
}

/**
 * The plan's cap on regions per monitor for this workspace: a number, null for none (self-hosted, or a plan without a
 * cap), or "unavailable" when a metered deployment (`failClosed`) cannot read a valid plan, so multi-region checks must
 * not run uncapped. An unmetered deployment that cannot read its plan runs uncapped, like every other metering gap.
 */
export async function planRegionCap(entitlements: Pick<Entitlements, "plan" | "failClosed">, workspaceId: string): Promise<number | null | "unavailable"> {
  let max: unknown;
  try {
    max = (await entitlements.plan(workspaceId))?.maxRegions;
  } catch {
    console.error("plan unavailable");
    return entitlements.failClosed ? "unavailable" : null;
  }
  if (max === null || max === undefined) return null;
  if (typeof max !== "number" || !Number.isSafeInteger(max) || max < 1) {
    console.error("plan region cap invalid");
    return entitlements.failClosed ? "unavailable" : null;
  }
  return max;
}

/**
 * Due monitors of one workspace with their regions capped to its plan (`capRegions`). The plan is only read when some
 * monitor runs from more than one region, since a cap is never below one. When a metered deployment cannot read the
 * plan, the multi-region monitors are left out of this round (they come due again); the rest still run.
 */
export async function withinPlanRegions<T extends Pick<Monitor, "type" | "regions">>(due: T[], workspaceId: string, entitlements: Pick<Entitlements, "plan" | "failClosed">): Promise<T[]> {
  if (!due.some((m) => effectiveRegions(m).length > 1)) return due;
  const cap = await planRegionCap(entitlements, workspaceId);
  if (cap === "unavailable") return due.filter((m) => effectiveRegions(m).length <= 1);
  return due.map((m) => {
    const regions = capRegions(m, cap);
    return regions === m.regions ? m : { ...m, regions };
  });
}
