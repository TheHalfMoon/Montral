/**
 * A component's data loads outlive it: a client-side navigation (or a full page navigation) unmounts the view while
 * its requests are in flight, and the browser then rejects them ("Load failed", "Failed to fetch", "NetworkError…").
 * Left unhandled, that rejection surfaces as an uncaught error; handled naively, it calls setState on an unmounted
 * component or shows a bogus error. `mounted()` ties a load to the effect that started it:
 *
 *   useEffect(() => { const life = mounted(); life.settle(api.x(), setX, showError); return life.cancel; }, []);
 *
 * Every promise passed to settle() is always handled. While mounted, results go to `ok` and failures to `fail`;
 * after cancel() both are dropped silently.
 */
export function mounted() {
  let alive = true;
  return {
    alive: () => alive,
    cancel: () => { alive = false; },
    settle<T>(promise: Promise<T>, ok: (value: T) => void, fail?: (error: unknown) => void): Promise<void> {
      return promise.then(
        (value) => { if (alive) ok(value); },
        (error) => { if (alive) fail?.(error); },
      );
    },
  };
}
