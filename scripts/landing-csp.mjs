#!/usr/bin/env node
// Keeps the hand-written landing pages (apps/web/public/{index,es,ja,zh-Hans}.html) under a strict Content Security
// Policy. Run after editing a landing page:
//   node scripts/landing-csp.mjs          rewrite the pages (move the body script to /landing.js, refresh the policy)
//   node scripts/landing-csp.mjs --check  fail if any page is out of date (used in CI)
// The small pre-paint script (theme + language before first paint) must stay inline; it is allowed by its hash. The
// large page script is served from /landing.js. The policy <meta> is the first element after <meta charset>, so it
// covers every script on the page.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const DIR = new URL("../apps/web/public/", import.meta.url);
const PAGES = ["index.html", "es.html", "ja.html", "zh-Hans.html"];
const SCRIPT_FILE = "landing.js";
const check = process.argv.includes("--check");

const policy = (hash) => [
  "default-src 'self'",
  `script-src 'self' 'sha256-${hash}'`,
  // inline style attributes (the sample uptime bars) and the Google Fonts stylesheet
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const META = /<meta http-equiv="content-security-policy" content="[^"]*">\n/;
const problems = [];
let bodyScript = null;
for (const name of PAGES) {
  const file = new URL(name, DIR);
  const original = readFileSync(file, "utf8");
  let html = original.replace(META, "");
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  // first run: the page still carries its big inline script; move it out (it is identical on every page)
  if (inline.length === 2) {
    if (bodyScript !== null && bodyScript !== inline[1][1]) problems.push(`${name}: page script differs from the other pages`);
    bodyScript ??= inline[1][1];
    html = html.replace(inline[1][0], `<script src="/${SCRIPT_FILE}"></script>`);
  } else if (inline.length !== 1) {
    problems.push(`${name}: expected exactly one inline (pre-paint) script, found ${inline.length}`);
    continue;
  }
  if (/\son[a-z]+="/i.test(html) || /href="javascript:/i.test(html)) problems.push(`${name}: inline event handlers or javascript: URLs are not allowed`);
  const prePaint = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  const hash = createHash("sha256").update(prePaint).digest("base64");
  html = html.replace('<meta charset="utf-8">\n', `<meta charset="utf-8">\n<meta http-equiv="content-security-policy" content="${policy(hash)}">\n`);
  if (!html.includes("content-security-policy")) problems.push(`${name}: no <meta charset="utf-8"> line to anchor the policy`);
  if (html.indexOf("content-security-policy") > html.indexOf("<script")) problems.push(`${name}: policy must come before the first script`);
  if (check) {
    if (html !== original) problems.push(`${name}: out of date; run node scripts/landing-csp.mjs`);
  } else if (html !== original) {
    writeFileSync(file, html);
  }
}
if (!check && bodyScript !== null) writeFileSync(new URL(SCRIPT_FILE, DIR), bodyScript.replace(/^\n/, ""));
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`LANDING_CSP_${check ? "CHECK_" : ""}PASS: ${PAGES.length} landing pages, one hashed pre-paint script each, page script served from /${SCRIPT_FILE}`);
