import { describe, expect, it } from "vitest";
import { buildPayload, canonicalString, certifiableRows, checkDrift, isFoodTour, payloadHash, type SheetFacts } from "./payload";
import { renderCertificateHtml, wordingFor } from "./document";
import { outstandingCertificates } from "./outstanding";
import type { Expense } from "@/lib/jobsheet";

// All data invented.
const facts: SheetFacts = { jobRef: "FOLK-TEST-CERT-01", tourDate: "2099-03-09", slotIdx: 0, guideId: "G-990", guideName: "Nok Example", guideReportedAt: new Date("2099-03-09T12:00:00Z") };
const op = { paidBySource: "operator", paidByAt: "2099-03-09T12:00:00Z", paidByBy: "u_op" };
const ticket = (over: Partial<Expense> = {}) => ({ description: "Temple ticket", price: 500, pax: 2, expenseType: "entrance", paidBy: "advance", advanceId: "adv_1", ...op, ...over }) as unknown as Expense;
const water = { description: "Water (Inc. Guide)", price: 10, pax: 3, expenseType: "meal", paidBy: "guide", ...op } as unknown as Expense;
const food = { description: "Food Cost", price: 650, pax: 1, expenseType: "meal", paidBy: "guide", ...op } as unknown as Expense;

describe("advance-paid rows", () => {
  it("a ticket paid from a company advance with no ticket attached needs a certificate; with its ticket attached it does not", () => {
    expect(certifiableRows([ticket()], "COMPANY_ADVANCE")).toHaveLength(1);
    expect(certifiableRows([ticket({ receiptUrl: "https://example.test/ticket.jpg" } as Partial<Expense>)], "COMPANY_ADVANCE")).toHaveLength(0);
  });
  it("the two kinds never take each other's rows", () => {
    const rows = [ticket(), water];
    expect(certifiableRows(rows, "COMPANY_ADVANCE").map((r) => r.description)).toEqual(["Temple ticket"]);
    expect(certifiableRows(rows, "GUIDE_PAID").map((r) => r.description)).toEqual(["Water (Inc. Guide)"]);
  });
  it("a payer only suggested by a Rate is not a payer: nothing to certify", () => {
    expect(certifiableRows([ticket({ paidBySource: "rate" } as Partial<Expense>)], "COMPANY_ADVANCE")).toHaveLength(0);
  });
});

describe("food cost only on food tours", () => {
  it("a food cost is certifiable on an 'Eat like a local' tour, and not on any other", () => {
    expect(isFoodTour("Eat Like a Local — China Town")).toBe(true);
    expect(certifiableRows([food], "GUIDE_PAID", { tourName: "Eat Like a Local — China Town" })).toHaveLength(1);
    expect(certifiableRows([food], "GUIDE_PAID", { tourName: "Riverside Temples" })).toHaveLength(0);
    expect(certifiableRows([food], "GUIDE_PAID")).toHaveLength(0); // tour unknown: not a food tour
  });
  it("drinking water is not a food cost — certifiable on every tour", () => {
    expect(certifiableRows([water], "GUIDE_PAID", { tourName: "Riverside Temples" })).toHaveLength(1);
  });
});

describe("fingerprints", () => {
  it("a guide-paid payload hashes exactly as before: no kind, no advances in it", () => {
    const p = buildPayload(facts, certifiableRows([water], "GUIDE_PAID"));
    expect(canonicalString(p)).not.toMatch(/kind=|advances=/);
    expect(p.kind).toBeUndefined();
  });
  it("an advance payload carries its kind and advances, and a changed advance is drift", () => {
    const rows = certifiableRows([ticket()], "COMPANY_ADVANCE");
    const p = buildPayload(facts, rows, null, undefined, { advances: ["FOLK-ADV-209903-001"] });
    expect(canonicalString(p)).toMatch(/kind=COMPANY_ADVANCE;advances=FOLK-ADV-209903-001/);
    const stored = { payloadHash: payloadHash(p), coveredRows: rows, kind: "COMPANY_ADVANCE" as const };
    expect(checkDrift(stored, { facts, expenses: [ticket()], advances: ["FOLK-ADV-209903-001"] }).drifted).toBe(false);
    expect(checkDrift(stored, { facts, expenses: [ticket()], advances: ["FOLK-ADV-209903-002"] }).drifted).toBe(true);
  });
});

describe("what the document says", () => {
  const view = (p: ReturnType<typeof buildPayload>) => renderCertificateHtml({ payload: p, certificateNo: "CERT-TEST", draft: true } as never);
  it("advance-paid: the company's own cost, nothing owed to the guide, the advances named", () => {
    const html = view(buildPayload(facts, certifiableRows([ticket()], "COMPANY_ADVANCE"), null, undefined, { advances: ["FOLK-ADV-209903-001"] }));
    expect(html).toContain("ชำระด้วยเงินทดรองจ่ายที่บริษัทโอนให้ไว้ล่วงหน้า");
    expect(html).toContain("FOLK-ADV-209903-001");
    expect(html).toContain("รวมค่าใช้จ่ายที่ชำระจากเงินทดรองของบริษัท");
    expect(html).not.toContain("รวมเป็นเงินที่ต้องจ่ายคืนไกด์");
    expect(html).not.toContain("ไกด์ผู้สำรองจ่าย");
  });
  it("a food cost is not called a fixed standard rate", () => {
    expect(wordingFor({ rows: [{ category: "meal", description: "Food Cost" }] } as never).amounts).not.toMatch(/^อัตราที่เบิกเป็นราคาคงที่/);
    expect(wordingFor({ rows: [{ category: "meal", description: "Water (Inc. Guide)" }, { category: "transport", description: "Bus" }] } as never).amounts).toMatch(/^อัตราที่เบิกเป็นราคาคงที่/);
  });
});

describe("the outstanding list", () => {
  const sheet = (id: string, expenses: Expense[], tourId = "T-1") => ({ id, ref: `FOLK-TEST-${id}`, guideId: "G-990", date: "2099-03-09", slotIdx: 0, tourId, expenses, approvalStatus: "APPROVED" });
  it("lists each kind a job still needs, drops LINKED ones, shows in-progress ones apart", () => {
    const jobs = outstandingCertificates(
      [sheet("a", [ticket(), water]), sheet("b", [water]), sheet("c", [water])],
      new Map([["T-1", "Riverside Temples"]]),
      [{ jobSheetId: "b", kind: "GUIDE_PAID", status: "LINKED", certificateNo: "CERT-B" }, { jobSheetId: "c", kind: "GUIDE_PAID", status: "ATTESTED", certificateNo: "CERT-C" }],
    );
    expect(jobs.map((j) => `${j.jobRef}:${j.kind}:${j.state}`)).toEqual([
      "FOLK-TEST-a:GUIDE_PAID:NOT_ISSUED", "FOLK-TEST-a:COMPANY_ADVANCE:NOT_ISSUED", "FOLK-TEST-c:GUIDE_PAID:IN_PROGRESS",
    ]);
  });
});
