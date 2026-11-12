import { rm } from "node:fs/promises";

/**
 * The macOS Chromium process can keep writing to its profile after SIGTERM.
 * Wait for the specific child to close before deleting its dedicated directory;
 * node:fs handles transient ENOTEMPTY/EBUSY/EPERM on macOS and Windows.
 * Never act on another browser or a shared Chrome profile.
 */
export async function cleanupBrowserProfile(child, profilePath, options = {}) {
  const { graceMs = 4000, killMs = 2000, remove = rm } = options;
  if (child) {
    const alive = () => child.exitCode === null && child.signalCode === null;
    const closedWithin = (ms) => {
      if (!alive()) return Promise.resolve(true);
      return new Promise((resolve) => {
        const done = () => { clearTimeout(timeout); resolve(true); };
        const timeout = setTimeout(() => { child.off("close", done); resolve(false); }, ms);
        child.once("close", done);
      });
    };
    if (alive()) {
      child.kill("SIGTERM");
      if (!(await closedWithin(graceMs)) && alive()) {
        child.kill("SIGKILL");
        await closedWithin(killMs);
      }
    }
  }
  await remove(profilePath, { recursive: true, force: true, maxRetries: 12, retryDelay: 200 });
}
