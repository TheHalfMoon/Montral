import { describe, expect, it } from "vitest";
import { read } from "./helpers";

/**
 * Browser checks run on one pinned Playwright version everywhere, in Docker only inside the separate, hardened
 * browser-runner service: never in the app's image or container, never with app secrets or the database's network.
 */
describe("browser check runtime", () => {
  const api = JSON.parse(read("apps/api/package.json")) as { devDependencies: Record<string, string>; scripts: Record<string, string> };
  const e2e = JSON.parse(read("e2e/package.json")) as { devDependencies: Record<string, string> };
  const dockerfile = read("Dockerfile");
  const override = read("docker-compose.browser.yml");
  /** The text of one service in the override (until the next top-level key of the services map). */
  const service = (name: string) => override.match(new RegExp(`^  ${name}:\\n((?:    .*\\n|\\s*\\n)+)`, "m"))?.[1] ?? "";

  it("pins one exact Playwright version in apps/api, e2e and the runner image", () => {
    const pinned = api.devDependencies["playwright-core"];
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(e2e.devDependencies["@playwright/test"]).toBe(pinned);
    expect(dockerfile).toContain(`playwright-core@${pinned}`);
  });

  it("the default image (last stage) has no browser; the runner image has no server, web build or app secrets", () => {
    const stages = dockerfile.split(/^FROM /m);
    const last = stages[stages.length - 1];
    expect(last).not.toMatch(/AS browser|playwright|chromium|browser-worker|browser-runner/i);
    const runner = stages.find((s) => /^\S+ AS browser-runner\n/.test(s))!;
    expect(runner).toBeDefined();
    expect(runner).toMatch(/CMD \["node", "browser-runner\.mjs"\]/);
    expect(runner).toMatch(/^USER node$/m);
    expect(runner).not.toMatch(/server\.mjs|apps\/web\/dist|DATABASE_URL|BETTER_AUTH_SECRET/);
    // no all-in-one "app with a browser" image any more
    expect(dockerfile).not.toMatch(/ AS browser\n/);
  });

  it("the compose override runs Chromium only in a hardened runner without app secrets or the database network", () => {
    const app = service("montral");
    const runner = service("browser-runner");
    expect(app).not.toMatch(/build:|image:/); // the app keeps the default image
    expect(app).toMatch(/BROWSER_RUNNER_URL: http:\/\/browser-runner:8090/);
    expect(runner).toMatch(/target: browser-runner/);
    expect(runner).not.toMatch(/^\s+(?:DATABASE_URL|BETTER_AUTH_SECRET|POSTGRES_\w+|SMTP_\w+|RESEND_API_KEY|LEMONSQUEEZY_\w+|APNS_\w+|GITHUB_CLIENT_SECRET|CRON_SECRET|PROBE_SECRET|TURNSTILE_SECRET_KEY):/m);
    expect(runner).toMatch(/^      BROWSER_RUNNER_TOKEN:/m);
    expect(runner).toMatch(/networks: \[browser-jobs, browser-egress\]/);
    expect(runner).toMatch(/cap_drop: \[ALL\]/);
    expect(runner).toMatch(/no-new-privileges:true/);
    expect(runner).toMatch(/seccomp=\.\/docker\/browser-runner-seccomp\.json/);
    expect(runner).not.toMatch(/unconfined/);
    expect(runner).toMatch(/read_only: true/);
    expect(runner).toMatch(/^    init: true$/m);
    expect(app).toMatch(/^    init: true$/m);
    for (const k of ["pids_limit:", "mem_limit:", "cpus:", "/tmp:size=", "/dev/shm:size="]) expect(runner, k).toContain(k);
    expect(override).toMatch(/browser-jobs:\n\s+internal: true/);
  });

  it("the runner's seccomp profile is Docker's default plus exactly clone/unshare/setns/chroot", () => {
    const profile = JSON.parse(read("docker/browser-runner-seccomp.json")) as { defaultAction: string; syscalls: { names: string[]; action: string; comment?: string }[] };
    expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO");
    const added = profile.syscalls.filter((s) => s.comment?.startsWith("Montral browser-runner"));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ names: ["clone", "unshare", "setns", "chroot"], action: "SCMP_ACT_ALLOW" });
    // nothing else is allowed unconditionally that Docker keeps for CAP_SYS_ADMIN (mount, bpf, ptrace…)
    const unconditional = profile.syscalls.filter((s) => s.action === "SCMP_ACT_ALLOW" && !("includes" in s) && !("args" in s)).flatMap((s) => s.names);
    for (const forbidden of ["mount", "bpf", "ptrace", "kexec_load", "init_module", "pivot_root", "umount2", "swapon"]) expect(unconditional, forbidden).not.toContain(forbidden);
  });

  it("the server bundle never inlines playwright-core (the worker imports it by a variable specifier)", () => {
    const worker = read("apps/api/src/browser-worker.ts");
    expect(worker).toMatch(/const pkg = "playwright-core";/);
    for (const f of ["apps/api/src/browser-check.ts", "apps/api/src/checker.ts", "apps/api/src/routes/monitors.ts", "apps/api/src/browser-runner.ts"]) {
      expect(read(f), f).not.toMatch(/from "playwright-core"|import\("playwright-core"\)/);
    }
    expect(api.scripts["build:browser-runner"]).toContain("--external:playwright-core");
  });
});
