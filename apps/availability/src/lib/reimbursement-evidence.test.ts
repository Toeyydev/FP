import { afterEach, describe, expect, it, vi } from "vitest";
import { blockedReimbursements, checkWaiver, evidenceRequired, evidenceState, type ExpenseWithEvidence } from "./reimbursement-evidence";

// All data invented.
const guidePaid = (over: Partial<ExpenseWithEvidence> = {}): ExpenseWithEvidence =>
  ({ description: "Lunch", price: 45, pax: 2, expenseType: "meal", paidBy: "guide", ...over } as ExpenseWithEvidence);

afterEach(() => vi.unstubAllEnvs());

describe("what needs a receipt", () => {
  it("money going back to a guide does", () => {
    expect(evidenceState(guidePaid()).state).toBe("BLOCKED");
  });

  it("a receipt settles it, by link or by file id", () => {
    expect(evidenceState(guidePaid({ receiptUrl: "https://drive.example.test/r" })).state).toBe("HAS_RECEIPT");
    expect(evidenceState(guidePaid({ receiptFileId: "file_1" })).state).toBe("HAS_RECEIPT");
  });

  it("company money does not — it is evidenced on the company's own side", () => {
    expect(evidenceState(guidePaid({ paidBy: "company" })).state).toBe("NOT_REQUIRED");
    expect(evidenceState(guidePaid({ paidBy: "advance" })).state).toBe("NOT_REQUIRED");
  });

  it("a row worth nothing is nothing to evidence", () => {
    expect(evidenceState(guidePaid({ price: 0 })).state).toBe("NOT_REQUIRED");
  });

  it("says what is wrong in words an operator can act on", () => {
    const s = evidenceState(guidePaid());
    expect(s.state === "BLOCKED" && s.reason).toContain("no receipt attached");
    expect(s.state === "BLOCKED" && s.reason).toContain("Lunch");
  });

  it("lists every blocked row, in sheet order", () => {
    const rows = [guidePaid({ description: "Lunch" }), guidePaid({ description: "Van", receiptUrl: "u" }), guidePaid({ description: "Boat" })];
    expect(blockedReimbursements(rows).map((b) => b.expense.description)).toEqual(["Lunch", "Boat"]);
  });
});

describe("an admin accepting a row without one", () => {
  const waiver = { by: "u_admin", at: "2099-01-20T03:00:00.000Z", reason: "the temple prints no ticket" };

  it("is accepted when it names a person and a reason", () => {
    expect(evidenceState(guidePaid({ evidenceWaiver: waiver })).state).toBe("WAIVED");
  });

  it("is not accepted on a bare word — the reason is the point", () => {
    expect(evidenceState(guidePaid({ evidenceWaiver: { ...waiver, reason: "ok" } })).state).toBe("BLOCKED");
    expect(evidenceState(guidePaid({ evidenceWaiver: { ...waiver, by: "" } })).state).toBe("BLOCKED");
  });

  it("checkWaiver says both things that can be missing", () => {
    expect(checkWaiver({ reason: "the temple prints no ticket", by: "u_admin" })).toEqual([]);
    expect(checkWaiver({ reason: "lost", by: null })).toHaveLength(2);
  });
});

describe("the switch", () => {
  it("is off unless the deployment sets it", () => {
    expect(evidenceRequired()).toBe(false);
    vi.stubEnv("REIMBURSEMENT_EVIDENCE_REQUIRED", "0");
    expect(evidenceRequired()).toBe(false);
    vi.stubEnv("REIMBURSEMENT_EVIDENCE_REQUIRED", "1");
    expect(evidenceRequired()).toBe(true);
  });
});
