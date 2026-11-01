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
  options: { maxPending?: number; concurrency?: number } = {},
): CheckQueue & { pendingCount(): number } {
  const maxPending = options.maxPending ?? LOCAL_CHECK_QUEUE_CAPACITY;
  const concurrency = options.concurrency ?? Math.min(LOCAL_CHECK_CONCURRENCY, maxPending);
  if (!Number.isSafeInteger(maxPending) || maxPending < 1 ||
      !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > maxPending) {
    throw new Error("Invalid local check queue capacity/concurrency");
  }

  let reserved = 0;
  let running = 0;
  const ready: CheckMessage[] = [];

  const pump = () => {
    while (running < concurrency && ready.length > 0) {
      const message = ready.shift()!;
      running++;
      // Catch synchronous throws as well as rejected promises. A failed
      // message must release capacity without revealing private probe details.
      Promise.resolve().then(() => processMessage(message))
        .catch(() => console.error("check batch failed; private diagnostic suppressed"))
        .finally(() => {
          running--;
          reserved--;
          pump();
        });
    }
  };

  return {
    pendingCount: () => reserved,
    async sendBatch(messages) {
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
          setTimeout(() => {
            ready.push(message.body);
            pump();
          }, delay * 1000).unref();
        }
      }
      pump();
    },
  };
}
