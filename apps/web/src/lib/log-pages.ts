/**
 * Paging through a newest-first list whose API filters `createdAt < before` and returns times in milliseconds.
 *
 * Asking strictly before the oldest row could skip rows that share its timestamp, so the next request starts 1 ms after
 * it and repeats are dropped by id. Many rows can share one millisecond (one alert writes a delivery per channel in a
 * single statement), so each request also asks for as many extra rows as are already shown at that millisecond: the
 * whole tie group always fits in the answer and paging can move past it. Paging ends on a short page or one that
 * brings nothing new.
 */
export type Dated = { id: string; createdAt: string };

/** the API's largest page */
export const MAX_PAGE = 200;

export function nextBefore(rows: Dated[]): string | undefined {
  const last = rows[rows.length - 1];
  if (!last) return undefined;
  const t = Date.parse(last.createdAt);
  return Number.isFinite(t) ? new Date(t + 1).toISOString() : undefined;
}

/** page size for the next request: the normal size plus the rows already shown at the oldest millisecond */
export function nextLimit(rows: Dated[], base: number): number {
  const last = rows[rows.length - 1];
  if (!last) return base;
  const ms = Date.parse(last.createdAt);
  const tied = rows.filter((r) => Date.parse(r.createdAt) === ms).length;
  return Math.min(MAX_PAGE, base + tied);
}

export function appendPage<T extends Dated>(rows: T[], page: T[], limit: number): { rows: T[]; more: boolean } {
  const seen = new Set(rows.map((r) => r.id));
  const fresh = page.filter((r) => !seen.has(r.id));
  return { rows: [...rows, ...fresh], more: page.length >= limit && fresh.length > 0 };
}
