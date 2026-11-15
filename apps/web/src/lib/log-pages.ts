/** Append a keyset page, defensively de-duplicating IDs if a response is retried. */
export function appendPage<T extends { id: string }>(rows: T[], page: T[], limit: number): { rows: T[]; more: boolean } {
  const seen = new Set(rows.map((r) => r.id));
  const fresh = page.filter((r) => !seen.has(r.id));
  return { rows: [...rows, ...fresh], more: page.length >= limit && fresh.length > 0 };
}
