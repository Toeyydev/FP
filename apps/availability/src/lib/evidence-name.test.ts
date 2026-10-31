import { describe, it, expect } from "vitest";
import { evidenceName, jobLead, bahtPart } from "@/lib/evidence-name";

describe("evidence file names", () => {
  it("lead with the Job No., then what, who, when, how much, refs", () => {
    expect(evidenceName({ jobs: ["FOLK-BKK-20261015-02"], what: "advance slip", guide: "Somchai Jaidee", date: "2026-10-15", amount: 3000, refs: ["KB2610151234", "G-001"], ext: "jpg" }))
      .toBe("FOLK-BKK-20261015-02 — advance slip — Somchai Jaidee — 2026-10-15 — ฿3,000 — KB2610151234 — G-001.jpg");
  });
  it("say how many more jobs one file covers", () => {
    expect(jobLead(["A-1", "A-2", "A-3"])).toBe("A-1 (+2 jobs)");
    expect(jobLead(["A-1", "A-1"])).toBe("A-1");
    expect(jobLead(["A-1", "A-2"])).toBe("A-1 (+1 job)");
  });
  it("never start blank", () => {
    expect(evidenceName({ jobs: [null, ""], what: "guide pay slip" })).toBe("NO-JOB — guide pay slip");
    expect(evidenceName({ jobs: [], noJob: "SUPPLEMENTAL", what: "guide pay slip" })).toBe("SUPPLEMENTAL — guide pay slip");
  });
  it("drop empty parts and characters Drive or a search would trip on", () => {
    expect(evidenceName({ jobs: ["J-1"], what: 'taxi / "airport"', refs: [null, undefined, ""] })).toBe("J-1 — taxi airport");
  });
  it("spell one amount one way", () => {
    expect(bahtPart(2584.5)).toBe("฿2,584.50");
    expect(bahtPart(90)).toBe("฿90");
  });
});
