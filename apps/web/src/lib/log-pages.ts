/**
 * Paging through a newest-first list whose API filters `createdAt < before`. Asking strictly before the last row could
 * skip rows that share its timestamp, so the next request starts 1 ms after it and repeats are dropped by id. Paging
 * ends when a page is short or brings nothing new.
 */
export type Dated = { id: string; createdAt: string };

export function nextBefore(rows: Dated[]): string | undefined {
  const last = rows[rows.length - 1];
  if (!last) return undefined;
  const t = Date.parse(last.createdAt);
  return Number.isFinite(t) ? new Date(t + 1).toISOString() : undefined;
}

export function appendPage<T extends Dated>(rows: T[], page: T[], limit: number): { rows: T[]; more: boolean } {
  const seen = new Set(rows.map((r) => r.id));
  const fresh = page.filter((r) => !seen.has(r.id));
  return { rows: [...rows, ...fresh], more: page.length >= limit && fresh.length > 0 };
}
