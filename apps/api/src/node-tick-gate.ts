/**
 * Prevent overlapping scheduled ticks, and give shutdown an awaitable
 * reference to the one admitted tick. No new tick starts after stopAndWait.
 *
 * A failed tick is logged only through a fixed message, never a raw error
 * that may include bearer URLs or provider credentials.
 */
export function createNodeTickGate() {
  let active: Promise<void> | null = null;
  let stopped = false;
  return {
    start(task: () => Promise<void>): boolean {
      if (stopped || active) return false;
      const running: Promise<void> = Promise.resolve().then(task).then(
        () => { active = null; },
        () => {
          active = null;
          console.error("scheduler tick failed; private diagnostic suppressed");
        },
      );
      active = running;
      return true;
    },
    stopAndWait(): Promise<void> {
      stopped = true;
      return active ?? Promise.resolve();
    },
  };
}