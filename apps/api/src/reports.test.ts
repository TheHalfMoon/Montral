import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendMonthlyReports } from "./reports";
import { unmetered, type Entitlements } from "./entitlements";
import { sendEmail } from "./email";

vi.mock("./email", async (original) => ({
  ...(await original<typeof import("./email")>()),
  sendEmail: vi.fn(async () => undefined),
}));

const when = new Date("2026-10-01T10:00:00Z");
const owners = [
  { email: "owner-one@example.test", locale: "en" },
  { email: "owner-two@example.test", locale: "en" },
];
function repo() {
  return {
    claimMonthlyReports: vi.fn(async () => ["synthetic-org"]),
    releaseMonthlyReportClaim: vi.fn(async () => undefined),
    organization: vi.fn(async () => ({ id: "synthetic-org", name: "Synthetic workspace" })),
    ownerContacts: vi.fn(async () => owners),
    monthlyReport: vi.fn(async () => [{ name: "Synthetic heartbeat", uptime: 100, downtimeMinutes: 0, incidents: 0 }]),
  };
}

beforeEach(() => vi.mocked(sendEmail).mockClear());
afterEach(() => vi.restoreAllMocks());

describe("monthly report email quota safety", () => {
  it("sends no optional report when the quota backend fails, without exposing its error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = repo();
    const meter: Entitlements = { ...unmetered, spendEmails: vi.fn(async () => { throw new Error("secret tenant credential and internal database URI"); }) };
    expect(await sendMonthlyReports(db as never, when, meter)).toBe(0);
    expect(meter.spendEmails).toHaveBeenCalledWith("synthetic-org", 2);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(db.releaseMonthlyReportClaim).toHaveBeenCalledWith("synthetic-org", "2026-09");
    expect(log).toHaveBeenCalledWith("monthly report email allowance unavailable");
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret tenant credential");
  });

  it.each([NaN, Infinity, -1, 1.5, 3])("rejects invalid email quota grants (%s)", async (grant) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const meter = { ...unmetered, spendEmails: async () => grant };
    const db = repo();
    expect(await sendMonthlyReports(db as never, when, meter)).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(db.releaseMonthlyReportClaim).toHaveBeenCalledWith("synthetic-org", "2026-09");
    expect(log).toHaveBeenCalledWith("monthly report email allowance invalid");
  });

  it("isolates a metering outage to its own workspace, leaving other monthly reports deliverable", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = repo();
    db.claimMonthlyReports.mockResolvedValue(["unavailable-org", "healthy-org"]);
    const meter = { ...unmetered, spendEmails: vi.fn(async (org: string, count: number) => {
      if (org === "unavailable-org") throw new Error("temporary billing database failure");
      return count;
    }) };
    expect(await sendMonthlyReports(db as never, when, meter)).toBe(2);
    expect(meter.spendEmails).toHaveBeenCalledTimes(2);
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(db.releaseMonthlyReportClaim).toHaveBeenCalledTimes(1);
    expect(db.releaseMonthlyReportClaim).toHaveBeenCalledWith("unavailable-org", "2026-09");
    expect(log).toHaveBeenCalledWith("monthly report email allowance unavailable");
  });

  it("reopens a claimed digest when report preparation fails before any delivery", async () => {
    const db = repo();
    db.monthlyReport.mockRejectedValue(new Error("private database DSN"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await sendMonthlyReports(db as never, when)).toBe(0);
    expect(db.releaseMonthlyReportClaim).toHaveBeenCalledWith("synthetic-org", "2026-09");
    expect(sendEmail).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("monthly report preparation unavailable");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private database DSN");
  });

  it("does not retry a digest after a partial send or an ambiguous mail provider failure", async () => {
    const db = repo();
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error("provider accepted but failed to acknowledge"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await sendMonthlyReports(db as never, when)).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(db.releaseMonthlyReportClaim).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("monthly report email delivery failed");
    expect(JSON.stringify(log.mock.calls)).not.toContain("provider accepted but failed to acknowledge");
  });

  it("logs only a generic error if releasing an unattempted claim fails", async () => {
    const db = repo();
    db.releaseMonthlyReportClaim.mockRejectedValue(new Error("tenant secret database connection"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const meter = { ...unmetered, spendEmails: async () => { throw new Error("meter unavailable"); } };
    expect(await sendMonthlyReports(db as never, when, meter)).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("monthly report claim release failed");
    expect(JSON.stringify(log.mock.calls)).not.toContain("tenant secret");
  });

  it("sends only the number granted by the quota backend", async () => {
    const meter = { ...unmetered, spendEmails: vi.fn(async () => 1) };
    expect(await sendMonthlyReports(repo() as never, when, meter)).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendEmail).mock.calls[0][0].to).toBe(owners[0].email);
  });

  it("keeps the explicit self-hosted unmetered default usable", async () => {
    expect(await sendMonthlyReports(repo() as never, when)).toBe(2);
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it("does not claim or send past the monthly reporting window", async () => {
    const db = repo();
    expect(await sendMonthlyReports(db as never, new Date("2026-10-04T10:00:00Z"))).toBe(0);
    expect(db.claimMonthlyReports).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
