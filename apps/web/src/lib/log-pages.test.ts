import { describe, expect, it } from "vitest";
import { appendPage } from "./log-pages";

const row = (id: string, createdAt = "2026-11-15T10:00:00.000Z") => ({ id, createdAt });

describe("appendPage", () => {
  it("drops duplicate IDs without losing other rows sharing their timestamp", () => {
    const first = [row("a"), row("b")];
    const page = [row("b"), row("c"), row("d")];
    expect(appendPage(first, page, 3)).toEqual({ rows: [...first, row("c"), row("d")], more: true });
  });

  it("stops on a short final page", () => {
    expect(appendPage([row("a")], [row("b")], 30)).toEqual({ rows: [row("a"), row("b")], more: false });
  });

  it("stops if a full page unexpectedly contains only previously seen IDs", () => {
    const rows = [row("a"), row("b")];
    expect(appendPage(rows, rows, 2)).toEqual({ rows, more: false });
  });
});
