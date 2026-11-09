import { useEffect, useState } from "react";
import { armCache } from "../lib/api";
import { NAV_LABEL, resolveRoute } from "../lib/routes";
import { t } from "../lib/i18n";
import { lp, stripLocale } from "../lib/locale-path";
import Toaster from "./Toaster";
import VerifyBar from "./VerifyBar";
import Monitors from "./Monitors";
import MonitorDetail from "./MonitorDetail";
import Incidents from "./Incidents";
import IncidentDetail from "./IncidentDetail";
import StatusPages, { StatusPageEditor } from "./StatusPages";
import Alerting from "./Alerting";
import Maintenance from "./Maintenance";
import WebhookInboxes from "./WebhookInboxes";
import Billing from "./Billing";
import Team from "./Team";
import Account from "./Account";
import ApiKeys from "./ApiKeys";
import Settings from "./Settings";
import AuditLog from "./AuditLog";
import MailReview from "./MailReview";
import Usage from "./Usage";
import { ChooseProject } from "./AllProjects";
import { isAllProjects } from "../lib/scope";

const NAV_PREFIX = "/app";

/** Moves the sidebar highlight, breadcrumb and tab title to the route that is now showing (the shell itself is server-rendered once). */
function syncShell(pathname: string) {
  const hit = resolveRoute(pathname);
  const key = hit?.route.key ?? "";
  document.querySelectorAll<HTMLElement>("[data-nav]").forEach((el) => {
    const current = el.dataset.nav === key;
    el.classList.toggle("on", current);
    if (el.tagName === "A") {
      if (current) el.setAttribute("aria-current", "page");
      else el.removeAttribute("aria-current");
    }
  });
  document.getElementById("tab-more")?.classList.toggle("on", ["maintenance", "team", "settings", "audit-log", "usage", "billing"].includes(key));
  const label = hit ? t(NAV_LABEL[hit.route.key]) : t("Not found");
  const crumb = document.querySelector(".crumb b");
  if (crumb) crumb.textContent = label;
  document.title = `${t(hit?.route.title ?? "Not found")} · Montral`;
}

/** Same-origin /app links navigate in place; everything else (modifier clicks, new tabs, other pages) is left to the browser. */
function internal(a: HTMLAnchorElement, e: MouseEvent) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  if (a.target && a.target !== "_self") return false;
  if (a.hasAttribute("download") || a.origin !== location.origin) return false;
  // an in-page fragment link (the "Skip to main content" link) is the browser's job: moving focus and scroll
  if (a.hash && a.pathname === location.pathname && a.search === location.search) return false;
  const p = stripLocale(a.pathname);
  return p === NAV_PREFIX || p.startsWith(NAV_PREFIX + "/");
}

/** Pages that work on one project: in the "All projects" view they ask for a choice instead of showing the oldest project. */
const PER_PROJECT = new Set(["StatusPages", "WebhookInboxes", "Alerting", "Maintenance"]);

function View({ name, params, title }: { name: string; params: string[]; title: string }) {
  if (PER_PROJECT.has(name) && isAllProjects()) return <ChooseProject title={title} />;
  switch (name) {
    case "Monitors": return <Monitors />;
    case "MonitorDetail": return <MonitorDetail id={params[0]} />;
    case "Incidents": return <Incidents />;
    case "IncidentDetail": return <IncidentDetail id={params[0]} />;
    case "StatusPages": return <StatusPages />;
    case "StatusPageEditor": return <StatusPageEditor id={params[0]} />;
    case "Alerting": return <Alerting />;
    case "Maintenance": return <Maintenance />;
    case "WebhookInboxes": return <WebhookInboxes />;
    case "Billing": return <Billing />;
    case "Team": return <Team />;
    case "Account": return <Account />;
    case "ApiKeys": return <ApiKeys />;
    case "Settings": return <Settings />;
    case "AuditLog": return <AuditLog />;
    case "MailReview": return <MailReview />;
    case "Usage": return <Usage />;
    default: return null;
  }
}

/** Client-side router for the back office: one HTML load, then page changes only fetch API data. */
export default function Router() {
  const [path, setPath] = useState(() => location.pathname);
  const [bump, setBump] = useState(0);
  const [scope, setScope] = useState(0);

  useEffect(() => {
    let remounted = false;
    const show = () => {
      remounted = false;
      setPath(location.pathname);
      setBump(0);
      syncShell(location.pathname);
      document.getElementById("app")?.classList.remove("open");
      window.scrollTo(0, 0);
      window.dispatchEvent(new Event("montral:changed")); // refresh the sidebar counts
    };
    const onPop = () => { armCache(); show(); };
    // another workspace or project: same page, new data — remount it even though the path did not change
    const onScope = () => { setScope((n) => n + 1); show(); };
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a || !internal(a, e)) return;
      e.preventDefault();
      if (a.pathname + a.search === location.pathname + location.search) return;
      history.pushState(null, "", a.pathname + a.search);
      onPop();
    };
    // a revisited page was painted from cache and the background refresh found newer data: remount once with it
    const onStale = () => {
      if (remounted) return;
      remounted = true;
      armCache();
      setBump((n) => n + 1);
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("montral:scope", onScope);
    window.addEventListener("montral:stale", onStale);
    document.addEventListener("click", onClick);
    syncShell(location.pathname);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("montral:scope", onScope);
      window.removeEventListener("montral:stale", onStale);
      document.removeEventListener("click", onClick);
    };
  }, []);

  const hit = resolveRoute(path);
  if (!hit) return <p className="muted">{t("Page not found.")} <a href={lp("/app")}>{t("← Monitors")}</a></p>;
  return <><Toaster /><VerifyBar /><View key={`${path}#${scope}#${bump}`} name={hit.route.name} params={hit.params} title={hit.route.title} /></>;
}
