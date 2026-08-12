import { describe, it, expect } from "vitest";
import { JOB_SHEET_CERTIFIER, certificationDate, fmtCertDate } from "@/lib/certifier";

describe("job-sheet certification date", () => {
  it("uses the first-save timestamp when present", () => {
    const d = certificationDate({ certifiedAt: "2026-08-13T01:20:15+07:00", approvedAt: "2026-08-15T10:00:00+07:00" });
    expect(fmtCertDate(d)).toBe("13 Aug 2026");
  });

  it("falls back to the approval time for historical sheets", () => {
    const d = certificationDate({ certifiedAt: null, approvedAt: "2026-07-20T18:00:00+07:00" });
    expect(fmtCertDate(d)).toBe("20 Jul 2026");
  });

  it("returns null (blank) when no trustworthy timestamp exists — never the tour date", () => {
    expect(certificationDate({ certifiedAt: null, approvedAt: null })).toBeNull();
    expect(fmtCertDate(null)).toBe("");
  });

  it("displays in Asia/Bangkok — a late-night UTC stamp is the NEXT Thai day", () => {
    // 2026-08-12 18:30 UTC = 2026-08-13 01:30 Bangkok
    const d = certificationDate({ certifiedAt: "2026-08-12T18:30:00.000Z" });
    expect(fmtCertDate(d)).toBe("13 Aug 2026");
  });

  it("certifier is the fixed authorized person with the existing repo asset", () => {
    expect(JOB_SHEET_CERTIFIER.nameTh).toBe("หทัยวรรณ ใจปลอด");
    expect(JOB_SHEET_CERTIFIER.signatureUrl).toBe("/approver-signature.png");
  });
});
