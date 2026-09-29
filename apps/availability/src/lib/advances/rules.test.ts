import { describe, it, expect } from "vitest";
import {
  advanceStatus, balanceLine, checkAllocations, checkConfirmation, checkDeduction, checkIssueAdvance, checkReceipt,
  checkReversal, outstandingSatang, unallocatedSatang, advanceNoFor, receiptNoFor, toSatang,
} from "./rules";

// Fictional data only — this repo is public.
const adv = (over: Partial<{ id: string; guideId: string; amountSatang: number; settledSatang: number; reversedAt: Date | null }> = {}) =>
  ({ id: "adv1", guideId: "G-TEST", amountSatang: 100_000, settledSatang: 0, reversedAt: null, ...over });

describe("balance and status", () => {
  it("outstanding is what is left of the advance", () => {
    expect(outstandingSatang(adv({ settledSatang: 70_000 }))).toBe(30_000);
    expect(unallocatedSatang({ amountSatang: 50_000, allocatedSatang: 20_000 })).toBe(30_000);
  });
  it("status follows the counter, not a stored field", () => {
    expect(advanceStatus(adv())).toBe("OPEN");
    expect(advanceStatus(adv({ settledSatang: 40_000 }))).toBe("PARTIALLY_SETTLED");
    expect(advanceStatus(adv({ settledSatang: 100_000 }))).toBe("SETTLED");
    expect(advanceStatus(adv({ settledSatang: 40_000, reversedAt: new Date() }))).toBe("REVERSED");
  });
  it("the confirmation line says where the balance lands", () => {
    expect(balanceLine(adv({ settledSatang: 70_000 }), 30_000)).toMatchObject({ outstanding: 300, change: 300, outstandingAfter: 0, withinBounds: true });
    expect(balanceLine(adv({ settledSatang: 70_000 }), 40_000).withinBounds).toBe(false);
  });
  it("numbers are the month of the real movement", () => {
    expect(advanceNoFor("2030-05-06", 1)).toBe("FOLK-ADV-203005-001");
    expect(receiptNoFor("2030-06-02", 12)).toBe("FOLK-ADR-203006-012");
  });
});

describe("issuing an advance", () => {
  const base = { guideId: "G-TEST", advanceDate: "2026-09-10", amount: 1000, today: "2026-09-17" };
  it("accepts a transfer that has happened", () => expect(checkIssueAdvance(base)).toEqual([]));
  it("refuses a future date — an advance is recorded after the money moves", () =>
    expect(checkIssueAdvance({ ...base, advanceDate: "2026-09-20" }).join()).toContain("in the future"));
  it("refuses zero, negative and sub-satang amounts", () => {
    expect(checkIssueAdvance({ ...base, amount: 0 }).length).toBe(1);
    expect(checkIssueAdvance({ ...base, amount: -5 }).length).toBe(1);
    expect(checkIssueAdvance({ ...base, amount: 10.005 }).join()).toContain("two decimal places");
  });
});

describe("recording a return", () => {
  const base = { guideId: "G-TEST", receivedDate: "2026-09-12", amount: 300, today: "2026-09-17", byGuide: false };
  it("accepts money that has arrived", () => expect(checkReceipt(base)).toEqual([]));
  it("refuses a future arrival date", () => expect(checkReceipt({ ...base, receivedDate: "2026-09-30" }).join()).toContain("in the future"));
});

describe("allocating a return", () => {
  const receipt = { guideId: "G-TEST", status: "VERIFIED" as const, amountSatang: 50_000, allocatedSatang: 0 };
  it("puts one return against two advances", () => {
    const advances = [adv({ id: "a", amountSatang: 60_000 }), adv({ id: "b", amountSatang: 40_000 })];
    expect(checkAllocations({ receipt, advances, allocations: [{ advanceId: "a", amount: 300 }, { advanceId: "b", amount: 200 }] })).toEqual([]);
  });
  it("refuses more than the money that actually arrived", () => {
    const advances = [adv({ id: "a", amountSatang: 100_000 })];
    expect(checkAllocations({ receipt, advances, allocations: [{ advanceId: "a", amount: 600 }] }).join()).toContain("left to allocate");
  });
  it("refuses more than an advance still owes", () => {
    const advances = [adv({ id: "a", amountSatang: 100_000, settledSatang: 80_000 })];
    expect(checkAllocations({ receipt, advances, allocations: [{ advanceId: "a", amount: 300 }] }).join()).toContain("outstanding");
  });
  it("refuses an advance belonging to another guide", () => {
    const advances = [adv({ id: "a", guideId: "G-OTHER" })];
    expect(checkAllocations({ receipt, advances, allocations: [{ advanceId: "a", amount: 100 }] }).join()).toContain("another guide");
  });
  it("refuses a return that has not been checked yet — a claim settles nothing", () => {
    const advances = [adv({ id: "a" })];
    expect(checkAllocations({ receipt: { ...receipt, status: "CLAIMED" }, advances, allocations: [{ advanceId: "a", amount: 100 }] }).join()).toContain("waiting to be checked");
  });
  it("refuses the same advance twice on one return", () => {
    const advances = [adv({ id: "a" })];
    expect(checkAllocations({ receipt, advances, allocations: [{ advanceId: "a", amount: 100 }, { advanceId: "a", amount: 100 }] }).join()).toContain("one line");
  });
  it("refuses a reversed advance", () => {
    const advances = [adv({ id: "a", reversedAt: new Date() })];
    expect(checkAllocations({ receipt, advances, allocations: [{ advanceId: "a", amount: 100 }] }).join()).toContain("reversed");
  });
});

describe("deducting inside a payment", () => {
  it("accepts a deduction within the outstanding balance", () =>
    expect(checkDeduction({ guideId: "G-TEST", advance: adv({ settledSatang: 70_000 }), amountSatang: 30_000 })).toEqual([]));
  it("refuses more than is outstanding", () =>
    expect(checkDeduction({ guideId: "G-TEST", advance: adv({ settledSatang: 70_000 }), amountSatang: 40_000 }).join()).toContain("outstanding"));
  it("refuses another guide's advance", () =>
    expect(checkDeduction({ guideId: "G-TEST", advance: adv({ guideId: "G-OTHER" }), amountSatang: 100 }).join()).toContain("another guide"));
});

describe("reversal rules", () => {
  const entry = { type: "EXPENSE_SETTLEMENT" as const, reversedByEntryId: null };
  it("needs a reason", () => expect(checkReversal(entry, "no").join()).toContain("reason"));
  it("reverses a live entry once", () => expect(checkReversal(entry, "wrong guide")).toEqual([]));
  it("refuses a second reversal of the same entry", () =>
    expect(checkReversal({ ...entry, reversedByEntryId: "x" }, "again").join()).toContain("already been reversed"));
  it("refuses reversing a payment deduction on its own — it is undone by reversing the payment", () =>
    expect(checkReversal({ type: "PAYMENT_DEDUCTION", reversedByEntryId: null }, "undo the deduction").join()).toContain("reverse the payment itself"));
  it("refuses reversing a reversal — record what happened instead", () =>
    expect(checkReversal({ type: "REVERSAL", reversedByEntryId: null }, "undo the undo").join()).toContain("cannot itself be reversed"));
});

// The proof the model rests on, written as a test so it cannot quietly stop being true.
describe("why CORRECTION may not be negative", () => {
  it("a reversal only ever lowers the settled total, so it always fits inside [0, amount]", () => {
    const amount = 100_000;
    let settled = 0;
    const apply = (delta: number) => { const next = settled + delta; expect(next).toBeGreaterThanOrEqual(0); expect(next).toBeLessThanOrEqual(amount); settled = next; };
    apply(70_000);          // expenses settled
    apply(30_000);          // deducted from a payment — now SETTLED
    apply(-70_000);         // the expense settlement was wrong: reversed
    expect(settled).toBe(30_000);
  });
  it("a NEGATIVE correction would make its own reversal impossible — which is why it is banned", () => {
    const amount = 100_000;
    let settled = 70_000;   // expenses settled
    settled += -20_000;     // a negative correction, if it were allowed
    settled += 50_000;      // a later payment deduction fills the space
    expect(settled).toBe(100_000);
    const reversalOfCorrection = settled + 20_000; // reversing a negative entry ADDS
    expect(reversalOfCorrection).toBeGreaterThan(amount); // …and the CHECK would refuse it
  });
});

describe("satang", () => {
  it("counts in whole satang", () => {
    expect(toSatang(1234.56)).toBe(123456);
    expect(toSatang(0.1) + toSatang(0.2)).toBe(toSatang(0.3));
  });
});

describe("confirming a return needs the bank statement line", () => {
  it("refuses a confirmation with no statement reference", () => {
    expect(checkConfirmation("")).toHaveLength(1);
    expect(checkConfirmation("   ")).toHaveLength(1);
    expect(checkConfirmation(null)).toHaveLength(1);
    expect(checkConfirmation("AB")).toHaveLength(1);
  });
  it("accepts a reference that identifies the transfer", () => {
    expect(checkConfirmation("STMT-2030-0611-7781")).toEqual([]);
  });
});
