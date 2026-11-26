import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RegionUsageSummary } from "../lib/api";
import { RegionUsageSummaryView } from "./Usage";

const summary: RegionUsageSummary = {
  periodStart: "2026-11-01T00:00:00.000Z",
  periodEnd: "2026-12-01T00:00:00.000Z",
  regions: [{
    region: "eu-west",
    planned: 8,
    completed: 5,
    failedResults: 1,
    unavailable: 1,
    reserved: 1,
    unverified: 2,
    creditsCharged: 6,
    creditsRefunded: 2,
  }],
};

describe("customer regional usage summary", () => {
  it("shows state and credit totals without implying remote acceptance or automatic refund", () => {
    const html = renderToStaticMarkup(createElement(RegionUsageSummaryView, { summary }));
    expect(html).toContain("Regional check usage");
    expect(html).toContain("2026-11");
    expect(html).toContain("eu-west");
    for (const label of ["Planned", "Completed results", "Failed results", "Unavailable", "Reserved", "Unverified", "Credits charged", "Credits refunded"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("8");
    expect(html).toContain("6");
    expect(html).toContain("2");
    expect(html).toContain("An unavailable or unverified result does not prove that no remote work occurred.");
    expect(html).toContain("Unverified reservations are not automatically refunded.");
  });

  it("explains an empty metered month instead of showing a blank panel", () => {
    const html = renderToStaticMarkup(createElement(RegionUsageSummaryView, { summary: { ...summary, regions: [] } }));
    expect(html).toContain("No regional checks have been recorded this month.");
  });
});
