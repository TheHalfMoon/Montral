#!/usr/bin/env node
// Every inline script that a built page executes must be allowed by that page's own CSP <meta> by hash, and the
// policy must not fall back to 'unsafe-inline'. Data blocks (JSON, JSON-LD) are not executed and are skipped.
// Static pages only: server-rendered pages are covered by the Chromium journey (scripts/qualify-browser.mjs).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.argv[2] ?? "apps/web/dist/client";
const pages = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith(".html")) pages.push(p);
  }
})(root);

const problems = [];
let checked = 0;
let astroPages = 0;
for (const file of pages) {
  const html = readFileSync(file, "utf8");
  const meta = /<meta http-equiv="content-security-policy" content="([^"]*)"/.exec(html);
  // Hand-written files in public/ (the landing page and its translations) are not built by Astro.
  if (!html.includes("/_astro/") && !meta) continue;
  astroPages++;
  if (!meta) { problems.push(`${relative(root, file)}: no CSP meta`); continue; }
  const scriptSrc = meta[1].split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src")) ?? "";
  if (!scriptSrc) problems.push(`${relative(root, file)}: no script-src`);
  if (/'unsafe-inline'|'unsafe-eval'/.test(scriptSrc)) problems.push(`${relative(root, file)}: script-src allows unsafe-*`);
  const allowed = new Set([...scriptSrc.matchAll(/'sha256-([^']+)'/g)].map((m) => m[1]));
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    const attrs = m[1];
    if (/\bsrc=/.test(attrs) || !m[2].trim()) continue;
    const type = /\btype="([^"]*)"/.exec(attrs)?.[1]?.toLowerCase() ?? "";
    if (type && !["module", "text/javascript", "application/javascript"].includes(type)) continue;
    checked++;
    const hash = createHash("sha256").update(m[2]).digest("base64");
    if (!allowed.has(hash)) problems.push(`${relative(root, file)}: inline script not in CSP (${hash.slice(0, 12)}…): ${JSON.stringify(m[2].trim().slice(0, 60))}`);
  }
}
if (!astroPages) problems.push("no Astro-built pages found under " + root);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`CSP_HASHES_PASS: ${checked} inline scripts on ${astroPages} built pages are allowed by hash; no unsafe-inline`);
