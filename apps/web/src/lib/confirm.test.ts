import { afterEach, describe, expect, it, vi } from "vitest";
import { ASK_EVENT, ask, type AskRequest } from "./confirm";

type FakeWindow = EventTarget & { __montralConfirmHost?: boolean; confirm: (m: string) => boolean };

function fakeWindow(host: boolean): FakeWindow {
  const w = new EventTarget() as FakeWindow;
  w.__montralConfirmHost = host;
  w.confirm = vi.fn(() => true);
  (globalThis as unknown as { window: FakeWindow }).window = w;
  return w;
}

afterEach(() => { delete (globalThis as { window?: unknown }).window; });

describe("ask", () => {
  it("falls back to the native box when no confirmation host is mounted", async () => {
    const w = fakeWindow(false);
    await expect(ask("Delete this monitor?", "Delete monitor")).resolves.toBe(true);
    expect(w.confirm).toHaveBeenCalledWith("Delete this monitor?");
  });

  it("asks the host and resolves with the person's choice", async () => {
    const w = fakeWindow(true);
    const seen: AskRequest[] = [];
    w.addEventListener(ASK_EVENT, (e) => seen.push((e as CustomEvent<AskRequest>).detail));
    const yes = ask("Revoke this key?", "Revoke");
    const no = ask("Remove this channel?", "Remove", { danger: false, title: "Remove channel" });
    expect(seen.map((r) => [r.body, r.confirmLabel, r.title, r.danger])).toEqual([
      ["Revoke this key?", "Revoke", undefined, undefined],
      ["Remove this channel?", "Remove", "Remove channel", false],
    ]);
    seen[0].resolve(true);
    seen[1].resolve(false);
    await expect(yes).resolves.toBe(true);
    await expect(no).resolves.toBe(false);
    expect(w.confirm).not.toHaveBeenCalled();
  });

  it("never confirms on the server", async () => {
    await expect(ask("Delete?", "Delete")).resolves.toBe(false);
  });
});
