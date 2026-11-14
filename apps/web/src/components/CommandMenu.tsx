import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Incident, type Monitor } from "../lib/api";
import { t } from "../lib/i18n";
import { navigate } from "../lib/nav";

/**
 * Command menu (Cmd/Ctrl+K, or the sidebar search button): jump to any page the sidebar offers, find a monitor or an
 * open incident by name, and run a few shell actions. Pages are read from the rendered sidebar, so the menu always
 * offers exactly what this edition and this user can see there (Plan & usage and Billing included). Monitors and
 * incidents come from the API on first open and are refreshed on each open.
 */
type Item = {
  id: string;
  group: string;
  label: string;
  hint?: string;
  shape?: string;
  keywords?: string;
  run: () => void;
};

const SHAPE: Record<Monitor["status"], string> = { up: "up", degraded: "deg", down: "down", paused: "paused", pending: "pending" };
const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function go(href: string) {
  const url = new URL(href, location.origin);
  // in-app pages swap without a reload; anything else (docs, other origins) is a normal navigation
  if (/^(\/zh-Hans)?\/app(\/|$)/.test(url.pathname)) navigate(url.pathname.replace(/^\/zh-Hans/, "") + url.search);
  else location.href = url.href;
}

function pageItems(): Item[] {
  const seen = new Set<string>();
  const links = document.querySelectorAll<HTMLAnchorElement>("nav.nl a[data-nav], #me-menu a[data-nav]");
  const items: Item[] = [];
  links.forEach((a) => {
    const key = a.dataset.nav ?? "";
    if (a.hidden || seen.has(key)) return;
    seen.add(key);
    const label = (a.querySelector("[data-t]")?.textContent ?? a.textContent ?? "").trim();
    items.push({ id: `page-${key}`, group: t("Pages"), label, keywords: key, run: () => go(a.getAttribute("href") ?? "/app") });
  });
  return items;
}

function actionItems(close: () => void): Item[] {
  const dark = document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  return [
    {
      id: "act-theme", group: t("Actions"), label: dark ? t("Switch to light theme") : t("Switch to dark theme"), keywords: "theme dark light",
      run: () => {
        const next = dark ? "light" : "dark";
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem("montral_theme", next); } catch { /* private mode: this tab only */ }
        location.reload();
      },
    },
    { id: "act-docs", group: t("Actions"), label: t("Open documentation"), keywords: "docs help api mcp", run: () => { location.href = "/docs"; } },
    {
      id: "act-signout", group: t("Actions"), label: t("Sign out"), keywords: "logout sign out",
      run: () => { close(); document.querySelector<HTMLButtonElement>("#me-menu .signout")?.click(); },
    },
  ];
}

export default function CommandMenu() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [monitors, setMonitors] = useState<Monitor[] | null>(null);
  const [incidents, setIncidents] = useState<Incident[] | null>(null);
  const [failed, setFailed] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    returnTo.current?.focus?.();
  }, []);

  const show = useCallback(() => {
    returnTo.current = document.activeElement as HTMLElement | null;
    setQuery("");
    setActive(0);
    setOpen(true);
    setFailed(false);
    // each list on its own: incidents failing must not throw away the monitors (or the other way round)
    void Promise.allSettled([api.monitors(), api.incidents()]).then(([m, i]) => {
      setMonitors(m.status === "fulfilled" ? m.value : []);
      setIncidents(i.status === "fulfilled" ? i.value : []);
      if (m.status === "rejected" || i.status === "rejected") setFailed(true);
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      // another dialog owns the keyboard while it is open
      if (!open && document.querySelector(".modal")) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (open) close(); else show();
      }
    };
    const onClick = (e: MouseEvent) => {
      const el = e.target instanceof Element ? e.target.closest("[data-cmdk]") : null;
      if (el) { e.preventDefault(); show(); }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    // show the platform's shortcut on the sidebar button
    document.querySelectorAll<HTMLElement>("[data-cmdk-key]").forEach((k) => (k.textContent = isMac() ? "⌘K" : "Ctrl K"));
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("click", onClick); };
  }, [open, show, close]);

  useEffect(() => { if (open) input.current?.focus(); }, [open]);

  const items = useMemo<Item[]>(() => {
    if (!open) return [];
    const q = query.trim().toLowerCase();
    const match = (it: Item) => !q || `${it.label} ${it.hint ?? ""} ${it.keywords ?? ""}`.toLowerCase().includes(q);
    const mons: Item[] = (monitors ?? []).map((m) => ({
      id: `mon-${m.id}`, group: t("Monitors"), label: m.name, hint: m.target, shape: SHAPE[m.status] ?? "pending",
      keywords: `${m.type} ${m.status}`, run: () => go(`/app/monitors/${m.id}`),
    }));
    const incs: Item[] = (incidents ?? []).filter((i) => i.status !== "resolved").map((i) => ({
      id: `inc-${i.id}`, group: t("Open incidents"), label: i.title, hint: i.number ? `INC-${i.number}` : undefined, shape: "down",
      keywords: i.status, run: () => go(`/app/incidents/${i.id}`),
    }));
    return [
      ...pageItems().filter(match),
      ...incs.filter(match).slice(0, 5),
      ...mons.filter(match).slice(0, q ? 12 : 6),
      ...actionItems(close).filter(match),
    ];
  }, [open, query, monitors, incidents, close]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  // give focus back first: actions that do not navigate (theme, sign-out) must not leave it on a removed node
  const run = (i: number) => { const it = items[i]; if (!it) return; close(); it.run(); };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (items.length ? (a + 1) % items.length : 0)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (items.length ? (a - 1 + items.length) % items.length : 0)); }
    else if (e.key === "Home") { e.preventDefault(); setActive(0); }
    else if (e.key === "End") { e.preventDefault(); setActive(Math.max(0, items.length - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); run(active); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Tab") e.preventDefault(); // the input is the only stop inside the dialog
  };

  // results grouped for the listbox: each group is a role="group" named by its visible heading
  const groups: { name: string; items: { it: Item; i: number }[] }[] = [];
  items.forEach((it, i) => {
    const last = groups[groups.length - 1];
    if (last && last.name === it.group) last.items.push({ it, i });
    else groups.push({ name: it.group, items: [{ it, i }] });
  });
  return (
    <div className="cmdk-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label={t("Command menu")} onKeyDown={onKeyDown}>
        <div className="cmdk-in">
          <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
          <input
            ref={input}
            role="combobox"
            aria-expanded={items.length > 0}
            aria-controls={items.length > 0 ? "cmdk-list" : undefined}
            aria-autocomplete="list"
            aria-activedescendant={items[active] ? `cmdk-${items[active].id}` : undefined}
            aria-label={t("Search pages, monitors and actions")}
            placeholder={t("Search pages, monitors and actions…")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <kbd>Esc</kbd>
        </div>
        {items.length > 0 && (
          <div className="cmdk-list" id="cmdk-list" role="listbox" ref={list} aria-label={t("Results")}>
            {groups.map((g, gi) => (
              <div key={g.name} role="group" aria-labelledby={`cmdk-g${gi}`}>
                <div className="cmdk-g" id={`cmdk-g${gi}`} role="presentation">{g.name}</div>
                {g.items.map(({ it, i }) => (
                  <div
                    key={it.id}
                    id={`cmdk-${it.id}`}
                    data-i={i}
                    role="option"
                    aria-selected={i === active}
                    className={`cmdk-o${i === active ? " on" : ""}`}
                    onMouseMove={() => setActive(i)}
                    onClick={() => run(i)}
                  >
                    {it.shape ? <span className={`st ${it.shape}`} aria-hidden="true" /> : <span className="cmdk-dot" aria-hidden="true" />}
                    <span className="cmdk-l">{it.label}</span>
                    {it.hint && <span className="cmdk-h">{it.hint}</span>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        {items.length === 0 && <p className="cmdk-empty">{t("No results")}</p>}
        {monitors === null && !failed && <p className="cmdk-note" role="status">{t("Loading monitors…")}</p>}
        {failed && <p className="cmdk-note" role="status">{t("Monitors and incidents could not be loaded. Pages and actions still work.")}</p>}
        <div className="cmdk-f" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> {t("to move")}</span><span><kbd>↵</kbd> {t("to open")}</span><span><kbd>Esc</kbd> {t("to close")}</span></div>
      </div>
    </div>
  );
}
