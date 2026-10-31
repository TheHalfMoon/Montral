import { describe, expect, it } from "vitest";
import { defaultReviewMonth, validReviewRequest } from "./MailReview";
import type { MonthlyReviewCandidate } from "../lib/api";

const selected: MonthlyReviewCandidate = { recipientUserId: "synthetic-review-id", state: "uncertain", attemptedAt: "2026-10-01T00:00:00Z" };

describe("staged monthly reconciliation operator UI guard", () => {
  it("computes previous UTC calendar month at year and leap boundaries", () => {
    expect(defaultReviewMonth(new Date("2026-01-01T00:00:00Z"))).toBe("2025-12");
    expect(defaultReviewMonth(new Date("2024-03-01T00:00:00Z"))).toBe("2024-02");
    expect(defaultReviewMonth(new Date("2026-10-31T23:59:00Z"))).toBe("2026-09");
  });
  it("cannot enable a submission without selected record, safe token and explicit evidence attestation", () => {
    expect(validReviewRequest("2026-09", selected, "provider:confirmation-123", true)).toBe(true);
    expect(validReviewRequest("2026-13", selected, "provider:confirmation-123", true)).toBe(false);
    expect(validReviewRequest("2026-09", null, "provider:confirmation-123", true)).toBe(false);
    expect(validReviewRequest("2026-09", selected, "provider:confirmation-123", false)).toBe(false);
    expect(validReviewRequest("2026-09", selected, "alice@example.test", true)).toBe(false);
    expect(validReviewRequest("2026-09", selected, "raw provider token with spaces", true)).toBe(false);
    expect(validReviewRequest("2026-09", selected, "x".repeat(161), true)).toBe(false);
  });
});
