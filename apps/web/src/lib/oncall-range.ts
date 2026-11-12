/** A single wall-clock instant for both ends of the maximum 90-day on-call override query. */
const DAY_MS = 86_400_000;
export function oncallOverrideRange(nowMs = Date.now()): { from: string; to: string } {
  return {
    from: new Date(nowMs).toISOString(),
    to: new Date(nowMs + 90 * DAY_MS).toISOString(),
  };
}
