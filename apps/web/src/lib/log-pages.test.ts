import { describe, expect, it } from "vitest";
import { appendPage, nextBefore } from "./log-pages";

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
