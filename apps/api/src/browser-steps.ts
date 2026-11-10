/**
 * Browser (synthetic multi-step) checks: the declarative journey a monitor runs, and the pieces both sides share (the
 * API that validates it and the isolated worker process that executes it).
 *
 * A journey is a list of steps from a fixed vocabulary; every step maps to one Playwright call with bounded arguments.
 * The one exception is `evaluate`: JavaScript the user wrote, run inside the page (its renderer, in the target's origin,
 * not subject to its CSP), never in the worker's Node process. Only owners and admins may add it, and a journey with a
 * script never handles secrets.
 *
 * Limits (enforced here, and again by the worker before it runs anything):
 * - 1 to MAX_STEPS steps; the first one is a `goto` (the monitor's target is that URL);
 * - selectors, values, texts, keys and URL patterns have length caps; selectors cannot use Playwright's internal engines (for stable journeys, not as a security control);
 * - each step has its own timeout (STEP_TIMEOUT_MIN_MS..STEP_TIMEOUT_MAX_MS) and the journey a total one (at most 60 s);
 * - `fill` takes either a literal value or a reference to a secret stored encrypted with the monitor (browser-secrets.ts).
 */
import { z } from "zod";

export const MAX_STEPS = 20;
export const MAX_SELECTOR_LENGTH = 500;
export const MAX_VALUE_LENGTH = 1000;
export const MAX_TEXT_LENGTH = 500;
export const MAX_URL_LENGTH = 2048;
/** a script step's source; runs inside the page (its renderer), never in the runner's Node process */
export const MAX_SCRIPT_LENGTH = 4000;
export const MAX_SECRETS = 10;
export const MAX_SECRET_VALUE_LENGTH = 1000;
export const STEP_TIMEOUT_MIN_MS = 500;
export const STEP_TIMEOUT_MAX_MS = 30_000;
export const STEP_TIMEOUT_DEFAULT_MS = 10_000;
export const TOTAL_TIMEOUT_MIN_MS = 5_000;
export const TOTAL_TIMEOUT_MAX_MS = 60_000;
export const TOTAL_TIMEOUT_DEFAULT_MS = 30_000;
export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Keys `press` accepts: one printable character, or a named key, optionally with modifiers (Control+A, Shift+Tab). */
const NAMED_KEYS = ["Enter", "Tab", "Escape", "Backspace", "Delete", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"];
const KEY = new RegExp(`^(?:(?:Control|Shift|Alt|Meta)\\+){0,3}(?:[A-Za-z0-9]|${NAMED_KEYS.join("|")})$`);

/**
 * Playwright's internal and framework selector engines are refused to keep journeys on stable, documented selectors. This
 * is NOT a security control: every selector engine only queries the page's own DOM inside the page, and the security
 * boundaries are the process / container isolation and the egress policy, not the selector syntax.
 */
const FORBIDDEN_SELECTOR = /(?:^|>>\s*)\s*(?:internal:|_react=|_vue=|_[a-z]+=)/i;

const selector = z.string().trim().min(1).max(MAX_SELECTOR_LENGTH)
  .refine((s) => !FORBIDDEN_SELECTOR.test(s), "Selector uses an engine that is not allowed (internal:, _react=, _vue=)")
  .refine((s) => !/[\u0000-\u001f]/.test(s), "Selector contains control characters");
const timeoutMs = z.number().int().min(STEP_TIMEOUT_MIN_MS).max(STEP_TIMEOUT_MAX_MS).optional();
const httpUrl = z.string().trim().min(1).max(MAX_URL_LENGTH).refine((u) => {
  try {
    const p = new URL(u).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}, "Use an absolute http:// or https:// URL");
const text = z.string().min(1).max(MAX_TEXT_LENGTH);

export const browserStepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("goto"), url: httpUrl, timeoutMs }).strict(),
  z.object({ action: z.literal("click"), selector, timeoutMs }).strict(),
  z.object({ action: z.literal("fill"), selector, value: z.string().max(MAX_VALUE_LENGTH).optional(), secretRef: z.string().regex(SECRET_NAME).optional(), timeoutMs }).strict()
    .refine((s) => (s.value === undefined) !== (s.secretRef === undefined), "fill needs exactly one of value or secretRef"),
  z.object({ action: z.literal("press"), key: z.string().max(40).regex(KEY, "Unsupported key"), timeoutMs }).strict(),
  z.object({ action: z.literal("waitFor"), selector: selector.optional(), text: text.optional(), timeoutMs }).strict()
    .refine((s) => (s.selector === undefined) !== (s.text === undefined), "waitFor needs exactly one of selector or text"),
  z.object({ action: z.literal("assertText"), selector: selector.optional(), contains: text.optional(), equals: z.string().max(MAX_TEXT_LENGTH).optional(), timeoutMs }).strict()
    .refine((s) => (s.contains === undefined) !== (s.equals === undefined), "assertText needs exactly one of contains or equals"),
  z.object({ action: z.literal("assertUrl"), pattern: z.string().min(1).max(MAX_URL_LENGTH), timeoutMs }).strict(),
  z.object({ action: z.literal("assertStatus"), code: z.number().int().min(100).max(599) }).strict(),
  // a scripted check: the body of an async function evaluated in the page (like the browser console); passes only when it
  // returns true. It has the page's own powers, inside the isolated runner and behind the same egress policy.
  z.object({ action: z.literal("evaluate"), script: z.string().min(1).max(MAX_SCRIPT_LENGTH).refine((s) => !/\u0000/.test(s), "Script contains a NUL character"), timeoutMs }).strict(),
]);
export type BrowserStep = z.infer<typeof browserStepSchema>;
export type BrowserAction = BrowserStep["action"];

export const browserConfigSchema = z.object({
  steps: z.array(browserStepSchema).min(1).max(MAX_STEPS)
    .refine((s) => s[0]?.action === "goto", "The first step must be goto: it opens the page the journey starts on")
    // a script can read anything typed into the page, so a journey with a script never handles secrets
    .refine((s) => !(s.some((x) => x.action === "evaluate") && s.some((x) => x.action === "fill" && x.secretRef)), "A journey with a script step cannot use secrets"),
  timeoutMs: z.number().int().min(TOTAL_TIMEOUT_MIN_MS).max(TOTAL_TIMEOUT_MAX_MS).default(TOTAL_TIMEOUT_DEFAULT_MS),
  screenshot: z.enum(["never", "on_failure"]).default("never"),
}).strict();
export type BrowserConfig = z.infer<typeof browserConfigSchema>;

/** Write-only secrets: name -> plaintext (create / update), the mask (keep the stored value) or null (delete). */
export const browserSecretsSchema = z.record(z.string().regex(SECRET_NAME, "Secret names are letters, digits and _, starting with a letter or _"), z.string().min(1).max(MAX_SECRET_VALUE_LENGTH).nullable())
  .refine((r) => Object.keys(r).length <= MAX_SECRETS, `At most ${MAX_SECRETS} secrets per monitor`);

/** The names of the secrets a journey uses. */
export const secretRefs = (config: Pick<BrowserConfig, "steps">) => [...new Set(config.steps.flatMap((s) => (s.action === "fill" && s.secretRef ? [s.secretRef] : [])))];

/** Why a journey cannot run with the secrets that exist (by name), or null. */
export function missingSecretProblem(config: Pick<BrowserConfig, "steps">, names: Iterable<string>): string | null {
  const have = new Set(names);
  const missing = secretRefs(config).filter((n) => !have.has(n));
  return missing.length ? `Unknown secret${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}` : null;
}

/** The step's own timeout, bounded by what is left of the journey. */
export const stepTimeout = (s: BrowserStep) => ("timeoutMs" in s && s.timeoutMs ? s.timeoutMs : STEP_TIMEOUT_DEFAULT_MS);

/**
 * `assertUrl` patterns: `*` matches any run of characters, everything else is literal. A pattern starting with `/` is
 * matched against the path and query of the URL, anything else against the whole URL. No regular expressions: a user
 * pattern cannot backtrack catastrophically. Linear in |url| x |pattern|, both length-capped.
 */
export function urlMatches(pattern: string, url: string): boolean {
  let subject = url;
  if (pattern.startsWith("/")) {
    try {
      const u = new URL(url);
      subject = u.pathname + u.search;
    } catch {
      return false;
    }
  }
  return globMatch(pattern, subject);
}

/** `*`-only glob, iterative with a single backtrack point (the classic wildcard matcher): O(n·m) worst case. */
export function globMatch(pattern: string, s: string): boolean {
  let p = 0, i = 0, star = -1, mark = 0;
  while (i < s.length) {
    if (p < pattern.length && pattern[p] !== "*" && pattern[p] === s[i]) { p++; i++; }
    else if (p < pattern.length && pattern[p] === "*") { star = p++; mark = i; }
    else if (star !== -1) { p = star + 1; i = ++mark; }
    else return false;
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

/** Replacement for secret values wherever text leaves the worker. */
export const SECRET_MASK = "••••••••";

/**
 * `text` with every occurrence of a secret value replaced by the mask: the last line of defence before anything a check
 * produced is stored or logged (results are built from fixed strings, so this should never find anything). Longest
 * values first, so a secret that contains another is masked whole.
 */
export function maskSecrets(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const v of [...new Set(secrets)].filter((s) => s.length > 0).sort((a, b) => b.length - a.length)) out = out.split(v).join(SECRET_MASK);
  return out;
}

// ---- results -----------------------------------------------------------------------------------------------------

/** Fixed reasons a step fails with; nothing from the page (text, URL, title) is ever part of a stored error. */
export const STEP_FAILURES = {
  timeout: "timed out",
  notFound: "element not found",
  textMismatch: "text did not match",
  urlMismatch: "URL did not match",
  status: "unexpected HTTP status",
  noResponse: "no page response to check",
  blocked: "blocked by the network policy",
  navigation: "navigation failed",
  secret: "secret is not set",
  crashed: "page crashed",
  transfer: "page exceeded the transfer limit",
  failed: "failed",
  scriptFalse: "script did not return true",
  scriptError: "script threw an error",
} as const;
export type StepFailure = keyof typeof STEP_FAILURES;

export const stepError = (index: number, action: BrowserAction, why: StepFailure, extra = "") => `Step ${index + 1} (${action}): ${STEP_FAILURES[why]}${extra}`;

export type BrowserStepResult = { action: BrowserAction; ms: number; ok: boolean };
/** What one run of a journey reports back. `failedStep` is the 0-based index of the step that failed. */
export type BrowserRunReport = {
  ok: boolean;
  steps: BrowserStepResult[];
  failedStep: number | null;
  error: string | null;
  /** last main-frame document response status, when there was one */
  statusCode: number | null;
  /** time the journey took (steps only, not browser start-up) */
  durationMs: number;
  /** requests the egress policy refused */
  blockedRequests: number;
  /** popup windows closed */
  popupsClosed: number;
  /** a navigation failed at the network level (refused, unreachable, DNS): the parent judges whether the prober is offline */
  networkError?: boolean;
  /** the run did not happen: capacity (server or workspace) was full */
  deferred?: boolean;
  /** base64 PNG, on failure when asked for (bounded by MAX_SCREENSHOT_BYTES) */
  screenshot?: string;
  /** measured by the parent: largest resident set of the whole process tree, MiB (Linux only) */
  peakRssMb?: number | null;
  /** measured by the parent: CPU time of the whole process tree, ms (Linux only) */
  cpuMs?: number | null;
};

export const MAX_SCREENSHOT_BYTES = 200 * 1024;
