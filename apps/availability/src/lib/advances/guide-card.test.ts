import { describe, expect, it } from "vitest";
import { guideAdvanceCard } from "./guide-card";

type V = Parameters<typeof guideAdvanceCard>[0] & object;
const adv = (over: Record<string, unknown> = {}) => ({ id: "a1", advanceNo: "FOLK-ADV-209901-001", amount: 5000, method: "bank", status: "OPEN", txRef: "TX-SECRET", slipUrl: "https://drive/slip", note: "n", ...over });
const view = (advances: unknown[], returns: unknown[] = [], outstanding = 5000, frozen = false) =>
  ({ advances, returns, totals: { outstanding }, frozen } as unknown as V);

describe("guideAdvanceCard", () => {
  it("a live bank advance → amount + Transferred", () => {
    expect(guideAdvanceCard(view([adv()]))).toEqual({ amount: 5000, transferred: true, toReturn: 5000, frozen: false });
  });
  it("never carries a reference, date, slip, note or ADV number", () => {
    const s = JSON.stringify(guideAdvanceCard(view([adv()])));
    for (const leak of ["FOLK-ADV", "TX-SECRET", "drive", "advanceNo", "txRef", "slip", "note", "paidAt"]) expect(s).not.toContain(leak);
  });
  it("no advance, a reversed one, or a ledger it cannot reconcile → nothing (no false Transferred)", () => {
    expect(guideAdvanceCard(view([]))).toBeNull();
    expect(guideAdvanceCard(view([adv({ status: "VOID" })]))).toBeNull();
    expect(guideAdvanceCard(view([adv({ status: "REVERSED" })]))).toBeNull();
    expect(guideAdvanceCard(view([adv({ status: null })]))).toBeNull();
    expect(guideAdvanceCard(null)).toBeNull();
  });
  it("only bank transfers count", () => {
    expect(guideAdvanceCard(view([adv({ method: "cash" })]))).toBeNull();
    expect(guideAdvanceCard(view([adv(), adv({ id: "a2", amount: 700, method: "cash" })]))?.amount).toBe(5000);
  });
  it("sums several live bank advances", () => {
    expect(guideAdvanceCard(view([adv(), adv({ id: "a2", amount: 1000.5, status: "SETTLED" })]))?.amount).toBe(6000.5);
  });
  it("To return = outstanding less returns already sent and awaiting a check", () => {
    const returns = [{ status: "CLAIMED", amount: 300 }, { status: "VERIFIED", amount: 200, unallocated: 200 }, { status: "VERIFIED", amount: 100, unallocated: 0 }];
    expect(guideAdvanceCard(view([adv()], returns, 1000))?.toReturn).toBe(500);
    expect(guideAdvanceCard(view([adv()], returns, 100))?.toReturn).toBe(0);
  });
  it("passes the recording freeze through", () => {
    expect(guideAdvanceCard(view([adv()], [], 0, true))?.frozen).toBe(true);
  });
});
