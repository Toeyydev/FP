import { describe, it, expect } from "vitest";
import { currentJobFigures, documentChangeReasons, documentDrift } from "@/lib/payment-document-drift";
import type { Expense } from "@/lib/jobsheet";

// A combined PEAK document against the current approved job sheets.
// All data is invented — this repo is public.
const water = (n: number): Expense => ({ description: "Water", price: 10, pax: n, paidBy: "guide" } as Expense);
const review = (n: number, rate: number): Expense => ({ description: "Review reward", price: rate, pax: n } as Expense);
const fee = (price: number) => ({ price, time: 1, whtPct: price ? 3 : 0 });

// The document as created: four jobs. Job D still had an ฿800 fee then.
const stored = {
  total: 4471,
  jobs: [
    { ref: "FOLK-TEST-A", date: "2099-04-01", slotIdx: 2, payout: 1264 },
    { ref: "FOLK-TEST-B", date: "2099-04-01", slotIdx: 7, payout: 1107 },
    { ref: "FOLK-TEST-E", date: "2099-04-05", slotIdx: 0, payout: 1254 },
    { ref: "FOLK-TEST-D", date: "2099-04-05", slotIdx: 3, payout: 846 },
  ],
  lines: [
    { jobRef: "FOLK-TEST-A", date: "2099-04-01", slotIdx: 2, kind: "GUIDE_FEE", price: 1200, wht: 36 },
    { jobRef: "FOLK-TEST-A", date: "2099-04-01", slotIdx: 2, kind: "REIMBURSEMENT", price: 100, wht: 0 },
    { jobRef: "FOLK-TEST-B", date: "2099-04-01", slotIdx: 7, kind: "GUIDE_FEE", price: 1100, wht: 33 },
    { jobRef: "FOLK-TEST-B", date: "2099-04-01", slotIdx: 7, kind: "REVIEW_REWARD", price: 40, wht: 0 },
    { jobRef: "FOLK-TEST-E", date: "2099-04-05", slotIdx: 0, kind: "GUIDE_FEE", price: 1200, wht: 36 },
    { jobRef: "FOLK-TEST-E", date: "2099-04-05", slotIdx: 0, kind: "REIMBURSEMENT", price: 90, wht: 0 },
    { jobRef: "FOLK-TEST-D", date: "2099-04-05", slotIdx: 3, kind: "GUIDE_FEE", price: 800, wht: 24 },
    { jobRef: "FOLK-TEST-D", date: "2099-04-05", slotIdx: 3, kind: "REIMBURSEMENT", price: 10, wht: 0 },
    { jobRef: "FOLK-TEST-D", date: "2099-04-05", slotIdx: 3, kind: "REVIEW_REWARD", price: 60, wht: 0 },
  ],
};
// Today's approved job sheets. D's fee is now an intentional ฿0 (run together with another job).
const sheets: Record<string, { expenses: Expense[]; guideFee: { price: number; time: number; whtPct: number } }> = {
  "2099-04-01|2": { expenses: [water(4), { description: "Bus", price: 15, pax: 4, paidBy: "guide" } as Expense], guideFee: fee(1200) },
  "2099-04-01|7": { expenses: [{ description: "Food", price: 600, pax: 1, paidBy: "advance" } as Expense, review(1, 40)], guideFee: fee(1100) },
  "2099-04-05|0": { expenses: [water(3), { description: "Bus", price: 20, pax: 3, paidBy: "guide" } as Expense], guideFee: fee(1200) },
  "2099-04-05|3": { expenses: [water(1), review(2, 30)], guideFee: fee(0) },
};
const currentOf = (j: { date: string; slotIdx: number }) => { const s = sheets[`${j.date}|${j.slotIdx}`]; return s ? currentJobFigures(s.expenses, s.guideFee) : null; };
// Job C: wrongly marked paid when the document was made, now put back — approved, unpaid, in no document.
const jobC = { date: "2099-04-03", slotIdx: 7, ref: "FOLK-TEST-C", ...currentJobFigures([{ description: "Food", price: 500, pax: 1, paidBy: "guide" } as Expense], fee(1000)) };

describe("currentJobFigures — gross − WHT = net, zero fee kept", () => {
  it("a job with an intentional ฿0 fee books only what is still owed: no fee, no WHT", () => {
    expect(currentJobFigures(sheets["2099-04-05|3"].expenses, sheets["2099-04-05|3"].guideFee)).toEqual({ gross: 70, wht: 0, net: 70 });
  });
  it("company-advance rows are not in gross or net; review rewards are, without WHT", () => {
    expect(currentJobFigures(sheets["2099-04-01|7"].expenses, sheets["2099-04-01|7"].guideFee)).toEqual({ gross: 1140, wht: 33, net: 1107 });
    expect(jobC).toMatchObject({ gross: 1500, wht: 30, net: 1470 });
  });
});

describe("documentDrift — the stored document vs the current job sheets", () => {
  const drift = documentDrift({ document: stored, currentOf, leftOut: [jobC] });

  it("keeps the document's own figures exactly as created", () => {
    expect(drift.stored).toEqual({ jobs: 4, gross: 4600, wht: 129, net: 4471 });
  });
  it("counts the current payout from today's job sheets, including the job left out", () => {
    expect(drift.current).toEqual({ jobs: 5, gross: 5300, wht: 135, net: 5165 });
    expect(drift.current.gross - drift.current.wht).toBe(drift.current.net);
  });
  it("reports the difference, the changed job and the job left out — and is out of sync", () => {
    expect(drift.delta).toEqual({ gross: 700, wht: 6, net: 694 });
    expect(drift.changed).toEqual([{ date: "2099-04-05", slotIdx: 3, ref: "FOLK-TEST-D", stored: { gross: 870, wht: 24, net: 846 }, current: { gross: 70, wht: 0, net: 70 } }]);
    expect(drift.leftOut.map((j) => j.ref)).toEqual(["FOLK-TEST-C"]);
    expect(drift.inSync).toBe(false);
  });
  it("refuses the payment for the job whose figures changed, naming old and new gross, WHT and payout", () => {
    const reasons = documentChangeReasons(drift, "EXP-TEST-0004");
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toBe("FOLK-TEST-D now pays ฿70.00, but EXP-TEST-0004 was created for ฿846.00 — its figures changed after the PEAK document was made: gross ฿70.00 (was ฿870.00), WHT ฿0.00 (was ฿24.00)");
    expect(reasons[1]).toContain("net −฿776.00 on the jobs in it");
  });
  it("a job only left out is shown, not a refusal — it may be paid by a later document", () => {
    const onlyLeftOut = documentDrift({ document: stored, currentOf: (j) => (j.slotIdx === 3 && j.date === "2099-04-05" ? { gross: 870, wht: 24, net: 846 } : currentOf(j)), leftOut: [jobC] });
    expect(onlyLeftOut.inSync).toBe(false);
    expect(onlyLeftOut.delta.net).toBe(1470);
    expect(documentChangeReasons(onlyLeftOut, "EXP-TEST-0004")).toEqual([]);
  });
  it("a document that still matches is in sync and blocks nothing", () => {
    const unchanged = documentDrift({ document: stored, currentOf: (j) => stored.jobs.find((x) => x.date === j.date && x.slotIdx === j.slotIdx)!.ref === "FOLK-TEST-D" ? { gross: 870, wht: 24, net: 846 } : currentOf(j), leftOut: [] });
    expect(unchanged.inSync).toBe(true);
    expect(unchanged.delta).toEqual({ gross: 0, wht: 0, net: 0 });
    expect(documentChangeReasons(unchanged, "EXP-TEST-0004")).toEqual([]);
  });
  it("a job whose sheet is gone is a difference, not a silent zero", () => {
    const gone = documentDrift({ document: stored, currentOf: (j) => (j.slotIdx === 7 ? null : currentOf(j)), leftOut: [] });
    expect(gone.changed.find((c) => c.ref === "FOLK-TEST-B")?.current).toBeNull();
    expect(gone.inSync).toBe(false);
  });
});
