// App shell behaviour: menus, sign-out and sidebar counts. Delegated and bound once: the DOM is swapped on soft
// navigation but `document` survives.
declare global {
  interface Window { __montralApp?: boolean }
}

if (!window.__montralApp) {
  window.__montralApp = true;
  const shut = () => {
    const menu = document.getElementById("me-menu");
    const button = document.getElementById("me-btn");
    if (menu) menu.hidden = true;
    if (button) button.setAttribute("aria-expanded", "false");
  };
  document.addEventListener("click", (e) => {
    const target = e.target;
    const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
    if (!el) return;
    const app = document.getElementById("app");
    if (el.closest("#menu-btn, #tab-more")) { app?.classList.toggle("open"); return; }
    if (el.closest("#scrim")) { app?.classList.remove("open"); return; }
    if (el.closest("#me-btn")) {
      const menu = document.getElementById("me-menu");
      if (!menu) return;
      menu.hidden = !menu.hidden;
      document.getElementById("me-btn")?.setAttribute("aria-expanded", String(!menu.hidden));
      return;
    }
    if (el.closest(".signout")) {
      void fetch("/api/auth/sign-out", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: "{}" })
        .then(() => { location.href = (/^\/zh-Hans(\/|$)/.test(location.pathname) ? "/zh-Hans" : "") + "/login"; });
      return;
    }
    shut();
  });
  const counts = () => {
    fetch("/api/counts", { credentials: "include" })
      .then((r) => (r.ok ? (r.json() as Promise<Record<string, number>>) : null))
      .then((c) => {
        if (!c) return;
        document.querySelectorAll<HTMLElement>("[data-count]").forEach((el) => {
          const key = el.getAttribute("data-count");
          const n = key ? c[key] : undefined;
          if (n == null) return;
          el.textContent = String(n);
          el.hidden = !(n > 0);
          el.className = key === "incidents" && n > 0 ? "cnt" : "";
        });
      })
      .catch(() => {});
  };
  // lib/boot.ts paints the first counts; refresh after create/resolve actions
  window.addEventListener("montral:changed", counts);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    shut();
    document.getElementById("app")?.classList.remove("open");
  });
}

export {};
