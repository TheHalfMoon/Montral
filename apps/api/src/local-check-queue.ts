import type { CheckMessage, CheckQueue } from "./scheduler";

/**
 * Self-hosted Node substitutes this process-local queue for Cloudflare Queues.
 * Reservation is synchronous and covers delayed timers + ready messages +
 * running tasks; a failed sendBatch never accepts only part of a batch. The
 * scheduler can therefore safely release every rejected monitor claim.
 *
 * This remains a best-effort, single-process queue (not a durable broker).
 */
export const LOCAL_CHECK_QUEUE_CAPACITY = 512;
const LOCAL_CHECK_CONCURRENCY = 4;
const MAX_SLOT_DELAY_SECONDS = 60;

export function createLocalCheckQueue(
  processMessage: (message: CheckMessage) => Promise<unknown>,
  options: { maxPending?: number; concurrency?: number; now?: () => number } = {},
): CheckQueue & { pendingCount(): number; oldestRunningAgeMs(): number; stopAndTakeUnstarted(): CheckMessage[]; waitForRunning(timeoutMs: number): Promise<boolean> } {
  const maxPending = options.maxPending ?? LOCAL_CHECK_QUEUE_CAPACITY;
  const concurrency = options.concurrency ?? Math.min(LOCAL_CHECK_CONCURRENCY, maxPending);
  if (!Number.isSafeInteger(maxPending) || maxPending < 1 ||
      !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > maxPending) {
    throw new Error("Invalid local check queue capacity/concurrency");
  }

  // Monotonic in-flight ages let the Node process watchdog distinguish a
  // stalled handler from an ordinary delayed queue slot. Never release a
  // reservation on a timeout: the underlying handler may still mutate state.
  const now = options.now ?? (() => performance.now());
  const inFlight = new Map<number, number>();
  const delayed = new Map<ReturnType<typeof setTimeout>, CheckMessage>();
  const idleWaiters = new Set<() => void>();
  let accepting = true;
  let nextTaskId = 0;
  let reserved = 0;
  let running = 0;
  const ready: CheckMessage[] = [];

  const notifyIdle = () => {
    if (running !== 0) return;
    for (const finish of idleWaiters) finish();
    idleWaiters.clear();
  };
  const pump = () => {
    if (!accepting) return;
    while (running < concurrency && ready.length > 0) {
      const message = ready.shift()!;
      running++;
      const taskId = ++nextTaskId;
      inFlight.set(taskId, now());
      // Catch synchronous throws as well as rejected promises. A failed
      // message must release capacity without revealing private probe details.
      Promise.resolve().then(() => processMessage(message))
        .catch(() => console.error("check batch failed; private diagnostic suppressed"))
        .finally(() => {
          inFlight.delete(taskId);
          running--;
          reserved--;
          notifyIdle();
          pump();
        });
    }
  };

  return {
    pendingCount: () => reserved,
    stopAndTakeUnstarted: () => {
      // Return only accepted work that has NOT begun. Running handlers may
      // still commit and must never have their claims prematurely released.
      accepting = false;
      const unstarted = ready.splice(0);
      for (const [timer, message] of delayed) {
        clearTimeout(timer);
        unstarted.push(message);
      }
      delayed.clear();
      reserved -= unstarted.length;
      return unstarted;
    },
    waitForRunning: async (timeoutMs) => {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
        throw new Error("Invalid check queue shutdown deadline");
      }
      if (running === 0) return true;
      return new Promise<boolean>((resolve) => {
        let timeout: ReturnType<typeof setTimeout>;
        const finish = () => {
          clearTimeout(timeout);
          idleWaiters.delete(finish);
          resolve(true);
        };
        idleWaiters.add(finish);
        timeout = setTimeout(() => {
          idleWaiters.delete(finish);
          resolve(false);
        }, timeoutMs);
      });
    },
    oldestRunningAgeMs: () => {
      if (inFlight.size === 0) return 0;
      let oldest = Number.POSITIVE_INFINITY;
      for (const start of inFlight.values()) oldest = Math.min(oldest, start);
      return Math.max(0, now() - oldest);
    },
    async sendBatch(messages) {
      if (!accepting) throw new Error("Local check queue is shutting down");
      // Validate *all* entries before changing the queue. Even a rejected
      // batch's first entry must not be scheduled or the scheduler would
      // incorrectly release an already accepted monitor claim.
      if (!messages.every((m) =>
        Array.isArray(m.body?.ids) && m.body.ids.length > 0 &&
        Number.isFinite(m.delaySeconds ?? 0) &&
        (m.delaySeconds ?? 0) >= 0 &&
        (m.delaySeconds ?? 0) <= MAX_SLOT_DELAY_SECONDS)) {
        throw new Error("Invalid local check queue batch");
      }
      if (messages.length > maxPending - reserved) {
        throw new Error("Local check queue capacity exceeded");
      }
      reserved += messages.length;
      for (const message of messages) {
        const delay = message.delaySeconds ?? 0;
        if (delay === 0) {
          ready.push(message.body);
        } else {
          const timer = setTimeout(() => {
            delayed.delete(timer);
            if (!accepting) return;
            ready.push(message.body);
            pump();
          }, delay * 1000);
          timer.unref();
          delayed.set(timer, message.body);
        }
      }
      pump();
    },
  };
}

/** Convert only never-started leased messages back to tokens for the
 * scheduler's conditional releaseClaims() operation. Never release running
 * work, and never invent a claim for a message lacking a valid lease. */
export function claimsForUnstarted(messages: readonly CheckMessage[]): { id: string; token: Date }[] {
  const claims: { id: string; token: Date }[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.ids) || !Array.isArray(message.at) ||
        message.ids.length !== message.at.length) continue;
    message.ids.forEach((id, index) => {
      const raw = message.at![index];
      if (typeof id !== "string" || !id || typeof raw !== "string") return;
      const token = new Date(raw);
      if (Number.isFinite(token.getTime())) claims.push({ id, token });
    });
  }
  return claims;
}