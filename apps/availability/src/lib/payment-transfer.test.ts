import { describe, expect, it } from "vitest";
import {
  bankNote, canTransfer, checkTransferEvidence, paymentPayloadHash, slipFileName, transferFigures, transferStage,
} from "./payment-transfer";
import type { PaymentLineTrace } from "./peak-payment-document";

// All data invented — this repo is public. A fictional guide, a fictional month.
const REF = "FOLK-PAY-209901-07";
const EXP = "EXP-20990100042";

const line = (over: Partial<PaymentLineTrace>): PaymentLineTrace =>
  ({ description: "", jobRef: "FOLK-BKK-20990105-01", date: "2099-01-05", slotIdx: 0, kind: "REIMBURSEMENT", category: null, accountCode: "510104", price: 0, wht: 0, ...over });

// Fee 2,000 + review 200 (both withheld on at 3%) + meals 150 + transport 300.
const DOC = {
  total: 2584,
  lines: [
    line({ kind: "GUIDE_FEE", accountCode: "510111", price: 2000, wht: 60, description: "Guide fee" }),
    line({ kind: "REVIEW_REWARD", accountCode: "510110", price: 200, wht: 6, description: "Review incentive" }),
    line({ kind: "REIMBURSEMENT", price: 150, description: "Meals" }),
    line({ kind: "REIMBURSEMENT", price: 300, description: "Transport" }),
  ],
};

describe("the figures the operator transfers against", () => {
  it("comes from the lines PEAK was given, not from the job sheets again", () => {
    expect(transferFigures(DOC)).toEqual({ gross: 2650, reimbursement: 450, whtBase: 2200, wht: 66, net: 2584 });
  });

  it("the base is whatever was withheld on, so a review incentive joins it without being told", () => {
    const feeOnly = { total: 2390, lines: DOC.lines.map((l) => (l.kind === "REVIEW_REWARD" ? { ...l, wht: 0 } : l)) };
    expect(transferFigures(feeOnly).whtBase).toBe(2000);
  });

  it("gross − wht + nothing else is the net the bank sends", () => {
    const f = transferFigures(DOC);
    expect(f.gross - f.wht).toBe(f.net);
  });

  it("a document with no lines yet is all zeros, not a crash", () => {
    expect(transferFigures({ lines: null, total: 0 })).toEqual({ gross: 0, reimbursement: 0, whtBase: 0, wht: 0, net: 0 });
  });
});

describe("what the operator pastes into the bank", () => {
  it("names the PEAK document first, then the FolkOPS payment", () => {
    expect(bankNote(EXP, REF)).toBe(`${EXP} ${REF}`);
  });

  it("falls back to the FolkOPS ref alone before PEAK has answered", () => {
    expect(bankNote(null, REF)).toBe(REF);
    expect(bankNote("  ", REF)).toBe(REF);
  });
});

describe("the slip's filename", () => {
  it("carries every field someone would otherwise open the file to learn", () => {
    expect(slipFileName({ documentNo: EXP, paymentRef: REF, guideId: "G-901", net: 2584, bankRef: "KB209901051234", ext: "jpeg" }))
      .toBe(`${EXP}_${REF}_G-901_2584.00_KB209901051234.jpeg`);
  });

  it("spells one amount one way", () => {
    const name = (net: number) => slipFileName({ documentNo: EXP, paymentRef: REF, guideId: "G-901", net, bankRef: "R1", ext: "jpeg" });
    expect(name(2584)).toContain("_2584.00_");
    expect(name(2584.5)).toContain("_2584.50_");
    expect(name(2584.004)).toContain("_2584.00_");
  });

  it("keeps underscores between the fields and out of them", () => {
    const n = slipFileName({ documentNo: EXP, paymentRef: REF, guideId: "G-901", net: 2584, bankRef: "KB 2099/01 #12", ext: "JPEG" });
    expect(n).toBe(`${EXP}_${REF}_G-901_2584.00_KB-2099-01-12.jpeg`);
    expect(n.split("_")).toHaveLength(5);
  });

  it("still names a file when the pieces are missing, rather than producing a blank one", () => {
    expect(slipFileName({ documentNo: null, paymentRef: REF, guideId: "G-901", net: 10, bankRef: "", ext: "pdf" }))
      .toBe(`NO-EXP_${REF}_G-901_10.00_NO-REF.pdf`);
  });
});

describe("evidence of the transfer", () => {
  const ok = { bankRef: "KB209901051234", slipAmount: 2584, hasSlip: true };

  it("passes when the slip, its amount and the bank reference all agree", () => {
    expect(checkTransferEvidence(ok, 2584)).toEqual([]);
  });

  it("refuses a blank bank reference", () => {
    expect(checkTransferEvidence({ ...ok, bankRef: "   " }, 2584).join(" ")).toContain("bank reference");
  });

  it("refuses a missing slip", () => {
    expect(checkTransferEvidence({ ...ok, hasSlip: false }, 2584).join(" ")).toContain("Attach the payment slip");
  });

  it("refuses a slip whose amount was never entered", () => {
    expect(checkTransferEvidence({ ...ok, slipAmount: null }, 2584).join(" ")).toContain("amount printed on the slip");
  });

  it("refuses a slip for a different amount, and says both figures", () => {
    const [why] = checkTransferEvidence({ ...ok, slipAmount: 2500 }, 2584);
    expect(why).toContain("2,500");
    expect(why).toContain("2,584");
  });

  it("allows the half-satang rounding the rest of the money allows", () => {
    expect(checkTransferEvidence({ ...ok, slipAmount: 2584.004 }, 2584)).toEqual([]);
    expect(checkTransferEvidence({ ...ok, slipAmount: 2584.02 }, 2584)).not.toEqual([]);
  });

  it("lists everything wrong at once, not one refusal per press", () => {
    expect(checkTransferEvidence({ bankRef: "", slipAmount: null, hasSlip: false }, 2584)).toHaveLength(3);
  });
});

describe("where the payment stands", () => {
  const at = (status: string, over: Record<string, unknown> = {}) => ({ status, peakDocumentNo: EXP, ...over });

  it("waits while PEAK has not answered", () => {
    expect(transferStage(at("CREATING"))).toBe("WAITING_FOR_PEAK");
    expect(transferStage(at("CREATE_UNCERTAIN"))).toBe("WAITING_FOR_PEAK");
    expect(transferStage(at("AWAITING_PAYMENT", { peakDocumentNo: null }))).toBe("WAITING_FOR_PEAK");
  });

  it("says a document exists before anyone has re-read it", () => {
    expect(transferStage(at("AWAITING_PAYMENT"))).toBe("PEAK_CREATED");
  });

  it("only says ready once a server has checked PEAK just now and found no drift", () => {
    expect(transferStage(at("AWAITING_PAYMENT"), { peakOpen: true, drift: false })).toBe("READY_TO_TRANSFER");
    expect(canTransfer(transferStage(at("AWAITING_PAYMENT")))).toBe(false);
    expect(canTransfer(transferStage(at("AWAITING_PAYMENT"), { peakOpen: true }))).toBe(true);
  });

  it("drift outranks everything the document says about itself", () => {
    expect(transferStage(at("AWAITING_PAYMENT"), { peakOpen: true, drift: true })).toBe("PEAK_DRIFT");
    expect(canTransfer("PEAK_DRIFT")).toBe(false);
  });

  it("a document PEAK no longer holds open is voided, whatever FolkOPS stored", () => {
    expect(transferStage(at("AWAITING_PAYMENT"), { peakOpen: false })).toBe("PEAK_VOIDED");
    expect(transferStage(at("VOIDED"))).toBe("PEAK_VOIDED");
  });

  it("evidence uploaded is the gap between the money leaving and PEAK confirming", () => {
    expect(transferStage(at("PAYING", { slipUrl: "https://drive.example.test/s" }))).toBe("EVIDENCE_UPLOADED");
    expect(transferStage(at("PAYMENT_UNCERTAIN", { bankRef: "KB1" }))).toBe("EVIDENCE_UPLOADED");
    expect(transferStage(at("PAYING"))).toBe("WAITING_FOR_PEAK");
  });

  it("paid is paid, including the legacy one-step value", () => {
    expect(transferStage(at("PAID"))).toBe("PAID");
    expect(transferStage(at("POSTED"))).toBe("PAID");
  });

  it("nothing but a checked, drift-free document may be transferred against", () => {
    const stages = ["WAITING_FOR_PEAK", "PEAK_CREATED", "EVIDENCE_UPLOADED", "PAID", "PEAK_DRIFT", "PEAK_VOIDED", "FAILED"] as const;
    expect(stages.filter(canTransfer)).toEqual([]);
  });
});

describe("the payload fingerprint", () => {
  const payload = { issuedDate: "20990105", products: [{ accountCode: "510111", price: 2000 }], reference: REF };

  it("is stable across key order — the same payload is the same document", () => {
    expect(paymentPayloadHash(payload)).toBe(paymentPayloadHash({ reference: REF, products: [{ price: 2000, accountCode: "510111" }], issuedDate: "20990105" }));
  });

  it("moves when an account, an amount or the order of the jobs moves", () => {
    const h = paymentPayloadHash(payload);
    expect(paymentPayloadHash({ ...payload, products: [{ accountCode: "510104", price: 2000 }] })).not.toBe(h);
    expect(paymentPayloadHash({ ...payload, products: [{ accountCode: "510111", price: 2000.5 }] })).not.toBe(h);
    expect(paymentPayloadHash({ ...payload, products: [{ accountCode: "510111", price: 2000 }, { accountCode: "510104", price: 1 }] })).not.toBe(h);
  });

  it("is eight hex characters, not a secret", () => {
    expect(paymentPayloadHash(payload)).toMatch(/^[0-9a-f]{8}$/);
  });
});
