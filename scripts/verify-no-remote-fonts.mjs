#!/usr/bin/env node
// Guard: application pages must never request a remote Google Fonts stylesheet.
// The first-party system-font fallback must work without third-party network calls.
import { readFileSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);
const checkedFiles = [
  "apps/web/src/layouts/Base.astro",
  "apps/web/astro.config.mjs",
  "apps/web/design/og.html",
  "apps/web/public/index.html",
  "apps/web/public/es.html",
  "apps/web/public/ja.html",
  "apps/web/public/zh-Hans.html",
  "scripts/landing-csp.mjs",
];

const forbidden = new RegExp("fonts\\.(googleapis|gstatic)\\.com", "i");
const refersToExternalFont = (source) => forbidden.test(source);

if (process.argv.includes("--negative-control")) {
  const synthetic = '<link href="https://' + "fonts." + 'googleapis.com/css2?family=Test">';
  if (!refersToExternalFont(synthetic)) {
    console.error("REMOTE_FONT_NEGATIVE_CONTROL_FAILED: detector accepted an external stylesheet");
    process.exit(1);
  }
}

const violations = checkedFiles.filter((path) =>
  refersToExternalFont(readFileSync(new URL(path, ROOT), "utf8")),
);
if (violations.length > 0) {
  console.error("MONTRAL_EXTERNAL_FONT_BLOCK_FAILED:", violations.join(", "));
  process.exit(1);
}

console.log(`MONTRAL_NO_EXTERNAL_FONTS_PASS: ${checkedFiles.length} sources; local system font fallback`);
