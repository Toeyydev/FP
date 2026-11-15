import { describe, expect, it } from "vitest";
import { documentStages, primaryReference } from "./primary-ref";

// The PEAK EXP is the reference an operator sees (owner 2026-11-15). Numbers invented.
describe("primaryReference", () => {
  const p = (...exps: (string | null)[]) => ({ paymentNo: "FOLK-PMT-209911-001", jobs: exps.map((e) => ({ peakDocumentNo: e })) });
  it("one EXP across the jobs → the EXP", () => expect(primaryReference(p("EXP-20991100031", "EXP-20991100031"))).toMatchObject({ label: "EXP-20991100031", kind: "EXP" }));
  it("several EXPs → the first, +n more", () => expect(primaryReference(p("EXP-20991100032", "EXP-20991100031"))).toMatchObject({ label: "EXP-20991100031 +1 more", kind: "EXPS", exps: ["EXP-20991100031", "EXP-20991100032"] }));
  it("none → FOLK-PMT, marked as having no EXP", () => expect(primaryReference(p(null, " "))).toMatchObject({ label: "FOLK-PMT-209911-001", kind: "NONE" }));
  it("a released job does not count", () => expect(primaryReference({ paymentNo: "X", jobs: [{ peakDocumentNo: "EXP-1", active: false }, { peakDocumentNo: "EXP-2" }] }).label).toBe("EXP-2"));
  it("never shows the bank memo", () => expect(primaryReference(p(null)).label).not.toMatch(/^PAY /));
});

describe("documentStages — four independent states", () => {
  const states = (d: Parameters<typeof documentStages>[0]) => documentStages(d).map((s) => `${s.key}:${s.state}`);
  it("created, approved, not yet transferred", () => expect(states({ status: "AWAITING_PAYMENT", peakDocumentNo: "EXP-1", approvedInPeak: true })).toEqual(["CREATED:done", "APPROVED:done", "TRANSFER:todo", "PEAK_PAYMENT:todo"]));
  it("a failed PEAK payment is a problem on that step only", () => expect(states({ status: "AWAITING_PAYMENT", peakDocumentNo: "EXP-1", approvedInPeak: true, error: "refused" })).toEqual(["CREATED:done", "APPROVED:done", "TRANSFER:todo", "PEAK_PAYMENT:problem"]));
  it("an unclear payment: transferred, check PEAK", () => expect(states({ status: "PAYMENT_UNCERTAIN", peakDocumentNo: "EXP-1" })).toEqual(["CREATED:done", "APPROVED:todo", "TRANSFER:done", "PEAK_PAYMENT:problem"]));
  it("paid: all done", () => expect(states({ status: "PAID", peakDocumentNo: "EXP-1" })).toEqual(["CREATED:done", "APPROVED:done", "TRANSFER:done", "PEAK_PAYMENT:done"]));
  it("PEAK says not ready (draft / voided / figures)", () => expect(states({ status: "AWAITING_PAYMENT", peakDocumentNo: "EXP-1", approvedInPeak: false })[1]).toBe("APPROVED:problem"));
});
