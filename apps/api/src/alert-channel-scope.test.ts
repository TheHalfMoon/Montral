import { afterEach, expect, it, vi } from "vitest";
import { dispatchAlert, retryDeliveries, sendEscalations } from "./alerts";
import { sendEmail } from "./email";

vi.mock("./email", async (original) => ({ ...await original<typeof import("./email")>(), sendEmail: vi.fn(async () => {}) }));
afterEach(() => vi.clearAllMocks());
const incident = { id: "incident", organizationId: "org", projectId: "a", title: "Down", resolvedAt: null };
const monitor = { id: "monitor", projectId: "a", name: "API", target: "https://example.com" };
const channel = (id: string, projectId: string | null, organizationId = "org") => ({ id, projectId, organizationId, type: "email", name: id, enabled: true, config: { to: `${id}@example.com` } });
function fixture(noRows = false) {
  const channels = [channel("own", "a"), channel("shared", null), channel("hidden", "b"), channel("foreign", null, "other")];
  const repo = {
    channelsToAlert: async () => channels, channelsByIds: async () => channels,
    listProjects: async () => [], ownerLocale: async () => "en", localeByEmail: async () => null,
    subscribersFor: async () => [], logDeliveries: vi.fn(async () => {}),
    queueDeliveries: vi.fn(async (rows: any[]) => noRows ? [] : rows.map((r) => ({ ...r, id: r.channelId }))),
    claimDelivery: async (id: string) => ({ id, kind: "incident.opened", attempts: 0 }),
    finishDelivery: vi.fn(async () => {}),
    claimRetries: async () => channels.map((c) => ({ delivery: { id: c.id, organizationId: "org", kind: "incident.opened", attempts: 1 }, incident, monitor, channel: c })),
    claimEscalations: async () => [{ incident, monitor, level: 1, step: { channelIds: channels.map((c) => c.id), userIds: [], scheduleIds: [] } }],
    underMaintenance: async () => false, recordEscalationNotice: vi.fn(async () => {}),
  };
  return repo;
}
it.each([false, true])("filters channel authority before queueing or fallback delivery (no rows: %s)", async (noRows) => {
  const repo = fixture(noRows);
  await dispatchAlert(repo as never, "org", { kind: "incident.opened", incident, monitor });
  expect(sendEmail).toHaveBeenCalledTimes(2);
  expect(repo.queueDeliveries.mock.calls[0][0].map((r: any) => r.channelId)).toEqual(["own", "shared"]);
  expect(JSON.stringify(repo.logDeliveries.mock.calls)).not.toMatch(/hidden|foreign/);
});
it("skips historical retries for a different project or organization", async () => {
  const repo = fixture();
  await retryDeliveries(repo as never);
  expect(sendEmail).toHaveBeenCalledTimes(2);
  for (const id of ["hidden", "foreign"]) expect(repo.finishDelivery).toHaveBeenCalledWith(id, expect.objectContaining({ status: "skipped" }));
});
it("omits forbidden escalation channels from delivery and timeline notices", async () => {
  const repo = fixture();
  await sendEscalations(repo as never);
  expect(sendEmail).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(repo.recordEscalationNotice.mock.calls)).not.toMatch(/hidden|foreign/);
  expect(repo.recordEscalationNotice).toHaveBeenCalledWith(expect.objectContaining({ channelCount: 2 }));
});
