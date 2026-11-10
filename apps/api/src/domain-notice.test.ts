import { describe, expect, it } from "vitest";
import { domainNoticeMail } from "./domain-notice";

const v = { domain: "status.example.com", title: "Acme status", url: "https://montral.example/app/status-pages/p1" };

describe("custom domain notice emails", () => {
  for (const kind of ["domain.withdrawn", "domain.failing"] as const) {
    for (const reason of ["missing", "mismatch", "lookup_failed"] as const) {
      it(`${kind} / ${reason}: English names the domain, page and record; Chinese is fully translated`, () => {
        const en = domainNoticeMail(kind, "en", { ...v, reason });
        expect(en.subject).toContain("status.example.com");
        expect(en.text).toContain("_montral-challenge.status.example.com");
        expect(en.text).toContain("Acme status");
        expect(en.text).toContain(v.url);
        expect(en.html).toContain('lang="en"');
        const zh = domainNoticeMail(kind, "zh-CN", { ...v, reason });
        expect(zh.html).toContain('lang="zh-CN"');
        // nothing English is left besides names and the URL: every sentence has a translation
        const prose = zh.text.replaceAll(v.url, "").replaceAll("_montral-challenge.status.example.com", "").replaceAll("status.example.com", "")
          .replaceAll("Acme status", "").replaceAll("Montral", "").replaceAll("TXT", "").replaceAll("DNS", "");
        expect(prose).not.toMatch(/[A-Za-z]{3,}/);
      });
    }
  }

  it("says what happens next: withdrawn domains must be verified again, failing ones still serve the page", () => {
    expect(domainNoticeMail("domain.withdrawn", "en", { ...v, reason: "missing" }).text).toContain("verify the domain again");
    expect(domainNoticeMail("domain.failing", "en", { ...v, reason: "missing" }).text).toContain("within 24 hours");
    expect(domainNoticeMail("domain.failing", "en", { ...v, reason: "lookup_failed" }).text).toContain("for 7 days");
  });
});
