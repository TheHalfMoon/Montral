#!/usr/bin/env node
// Reject known third-party webfont providers in the sources shipped by Montral.
// Discover files recursively so a newly added page or component cannot silently
// bypass the check by being absent from a hand-maintained filename list.
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const sourceDirs = [
  "apps/web/src",
  "apps/web/public",
  "apps/web/design",
  "apps/web/scripts",
];
const configurationFiles = [
  "apps/web/astro.config.mjs",
  "scripts/landing-csp.mjs",
];
const inspectedExtensions = new Set([
  ".astro", ".css", ".html", ".js", ".jsx", ".json",
  ".mjs", ".svg", ".ts", ".tsx", ".txt", ".xml",
]);
const remoteFontProviders = [
  /fonts\.(?:googleapis|gstatic)\.com/i,
  /fonts\.bunny\.net/i,
  /(?:use|p)\.typekit\.net/i,
  /fonts\.cdnfonts\.com/i,
];

function listTextSources(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Font scan refuses symlinks: ${path}`);
    }
    if (entry.isDirectory()) {
      files.push(...listTextSources(path));
    } else if (entry.isFile() && inspectedExtensions.has(extname(entry.name).toLowerCase())) {
      files.push(path);
    }
  }
  return files;
}

function hasRemoteFont(source) {
  return remoteFontProviders.some((pattern) => pattern.test(source));
}

if (process.argv.includes("--negative-control")) {
  const temp = mkdtempSync(join(tmpdir(), "montral-font-guard-"));
  try {
    const newPage = join(temp, "new-route", "page.astro");
    mkdirSync(join(temp, "new-route"));
    writeFileSync(newPage, '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Test">');
    const discovered = listTextSources(temp);
    if (discovered.length !== 1 || discovered[0] !== newPage ||
        !hasRemoteFont(readFileSync(discovered[0], "utf8"))) {
      throw new Error("REMOTE_FONT_NEGATIVE_CONTROL_FAILED: added route escaped the scan");
    }
    for (const sample of [
      '@import url("https://fonts.bunny.net/css?family=Test");',
      '<link rel="preconnect" href="https://use.typekit.net">',
      'url("https://fonts.cdnfonts.com/s/123/font.woff2")',
    ]) {
      if (!hasRemoteFont(sample)) {
        throw new Error("REMOTE_FONT_NEGATIVE_CONTROL_FAILED: remote font provider escaped");
      }
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const checkedFiles = [
  ...configurationFiles.map((path) => join(ROOT, path)),
  ...sourceDirs.flatMap((path) => listTextSources(join(ROOT, path))),
];
const violations = checkedFiles.filter((path) => hasRemoteFont(readFileSync(path, "utf8")));
if (violations.length > 0) {
  console.error("MONTRAL_EXTERNAL_FONT_BLOCK_FAILED:");
  for (const path of violations) console.error(" -", relative(ROOT, path));
  process.exit(1);
}

console.log(`MONTRAL_NO_EXTERNAL_FONTS_PASS: ${checkedFiles.length} sources; system font fallback, common third-party font providers blocked`);
