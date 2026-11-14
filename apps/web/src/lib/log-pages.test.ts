import { describe, expect, it } from "vitest";
import { appendPage, MAX_PAGE, nextBefore, nextLimit } from "./log-pages";

const row = (id: string, createdAt: string) => ({ id, createdAt });

describe("nextBefore", () => {
  it("asks from 1 ms after the oldest row, so rows sharing its timestamp are not skipped", () => {
    expect(nextBefore([row("a", "2026-11-14T10:00:00.500Z"), row("b", "2026-11-14T09:00:00.000Z")])).toBe("2026-11-14T09:00:00.001Z");
  });
  it("has nothing to ask for an empty list or an unreadable time", () => {
    expect(nextBefore([])).toBeUndefined();
    expect(nextBefore([row("a", "not a date")])).toBeUndefined();
  });
});

describe("nextLimit", () => {
  const at = (n: number, iso: string) => Array.from({ length: n }, (_, i) => row(`${iso}-${i}`, iso));
  it("adds the rows already shown at the oldest millisecond", () => {
    expect(nextLimit([...at(5, "2026-11-14T10:00:00.900Z"), ...at(25, "2026-11-14T10:00:00.100Z")], 30)).toBe(55);
  });
  it("is the normal size when nothing ties", () => expect(nextLimit([row("a", "2026-11-14T10:00:00.000Z")], 30)).toBe(31));
  it("never exceeds the API's largest page", () => expect(nextLimit(at(500, "2026-11-14T10:00:00.000Z"), 30)).toBe(MAX_PAGE));
});

describe("paging through a large tie group", () => {
  // a store that answers like the repository: newest first, created_at < before, limit
  const store = [
    ...Array.from({ length: 5 }, (_, i) => row(`new${i}`, "2026-11-14T10:00:01.000Z")),
    ...Array.from({ length: 40 }, (_, i) => row(`tie${i}`, "2026-11-14T10:00:00.000Z")),
    ...Array.from({ length: 12 }, (_, i) => row(`old${i}`, `2026-11-14T09:00:${String(i).padStart(2, "0")}.000Z`)).reverse(),
  ];
  const query = (limit: number, before?: string) => store.filter((r) => !before || Date.parse(r.createdAt) < Date.parse(before)).slice(0, limit);
  it("reaches every row even when more rows share a millisecond than fit on a page", () => {
    let rows = query(30), more = rows.length >= 30;
    for (let guard = 0; more && guard < 10; guard++) {
      const limit = nextLimit(rows, 30);
      const next = appendPage(rows, query(limit, nextBefore(rows)), limit);
      rows = next.rows; more = next.more;
    }
    expect(rows.map((r) => r.id).sort()).toEqual(store.map((r) => r.id).sort());
  });
});

describe("appendPage", () => {
  it("drops the repeated boundary rows and keeps order", () => {
    const first = [row("a", "t3"), row("b", "t2")];
    const page = [row("b", "t2"), row("c", "t2"), row("d", "t1")];
    expect(appendPage(first, page, 3)).toEqual({ rows: [...first, row("c", "t2"), row("d", "t1")], more: true });
  });
  it("stops on a short page", () => {
    expect(appendPage([row("a", "t2")], [row("b", "t1")], 30).more).toBe(false);
  });
  it("stops when a full page brings nothing new", () => {
    const rows = [row("a", "t1"), row("b", "t1")];
    expect(appendPage(rows, rows, 2)).toEqual({ rows, more: false });
  });
});
