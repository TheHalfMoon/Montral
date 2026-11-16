/** Monotonically supersede older account-session refresh requests.
 * The caller must ignore responses and errors from superseded loads. */
export function createLatestRequestFence() {
  let current = 0;
  return {
    start(): number { return ++current; },
    isLatest(version: number): boolean { return version === current; },
    invalidate(): void { current++; },
  };
}
