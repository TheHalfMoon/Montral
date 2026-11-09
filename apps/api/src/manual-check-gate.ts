/**
 * Bounds for "check now" (POST /api/monitors/:id/check). Scheduled checks go through the queue's own concurrency limit;
 * manual ones run inline in the request and can each hold a socket or a `ping` process for up to the monitor's timeout.
 * Credits alone do not bound them (self-hosted instances are unmetered), so:
 * - per workspace: MANUAL_CHECKS_PER_WINDOW within MANUAL_CHECK_WINDOW_SEC, counted in the database (shared by every
 *   server of the instance);
 * - per process: at most MAX_MANUAL_IN_FLIGHT at once, so no tenant can tie up this server's sockets or processes.
 */
export const MANUAL_CHECKS_PER_WINDOW = 60;
export const MANUAL_CHECK_WINDOW_SEC = 600;
export const MAX_MANUAL_IN_FLIGHT = 32;

export type ManualCheckGate = {
  /** A slot for one manual check, or null when this process already runs the maximum. Release it exactly once. */
  tryEnter(): (() => void) | null;
  inFlight(): number;
};

export function manualCheckGate(max = MAX_MANUAL_IN_FLIGHT): ManualCheckGate {
  let running = 0;
  return {
    tryEnter() {
      if (running >= max) return null;
      running++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        running--;
      };
    },
    inFlight: () => running,
  };
}

/** The process-wide gate the route uses. */
export const manualChecks = manualCheckGate();
