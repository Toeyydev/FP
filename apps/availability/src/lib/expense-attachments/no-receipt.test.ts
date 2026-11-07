import { describe, expect, it } from "vitest";
import { carryNoReceipt, checkNoReceiptReason, noReceiptReason, withoutNoReceipt } from "./no-receipt-row";
import { buildPayload, canonicalString, certifiableRows, payloadHash, type SheetFacts } from "@/lib/certificates/payload";
import { renderCertificateHtml } from "@/lib/certificates/document";
import { adoptReportedExpenses, type Expense } from "@/lib/jobsheet";

// "No receipt" + why on an expense row, and the certificate that prints it. All data invented.
const facts: SheetFacts = { jobRef: "FOLK-TEST-NR-01", tourDate: "2099-03-09", slotIdx: 0, guideId: "G-990", guideName: "Nok Example", guideReportedAt: new Date("2099-03-09T12:00:00Z") };
const op = { paidBySource: "operator", paidByAt: "2099-03-09T12:00:00Z", paidByBy: "u_op" };
const why = (reason: string) => ({ noReceipt: { reason, by: "u_g", role: "GUIDE", at: "2099-03-09T13:00:00Z" } });
const ticket = (over: Record<string, unknown> = {}) => ({ rowId: "r_aaaaaaaaaaaa", description: "Temple ticket", price: 200, pax: 2, expenseType: "entrance", paidBy: "advance", advanceId: "adv_1", ...op, ...over }) as unknown as Expense;
const ferry = (over: Record<string, unknown> = {}) => ({ rowId: "r_bbbbbbbbbbbb", description: "Ferry", price: 6, pax: 4, expenseType: "transport", paidBy: "guide", ...op, ...over }) as unknown as Expense;

describe("the reason on a row", () => {
  it("is read only while the row has no receipt", () => {
    expect(noReceiptReason(ticket(why("Stub only, no price")))).toBe("Stub only, no price");
    expect(noReceiptReason(ticket({ ...why("Stub only"), receiptUrl: "https://example.test/t.pdf" }))).toBeNull();
    expect(noReceiptReason(ticket())).toBeNull();
  });
  it("needs a few words, and not an essay", () => {
    expect(checkNoReceiptReason("  ")).toBe("reason-short");
    expect(checkNoReceiptReason("x".repeat(301))).toBe("reason-long");
    expect(checkNoReceiptReason("Ticket lost")).toBeNull();
  });
  it("a save carries the stored reason by row id, and drops one the browser sent", () => {
    const stored = [ticket(why("Ticket lost")), ferry()];
    const incoming = [ferry(why("forged by the browser")), ticket({ price: 250 })];
    const out = carryNoReceipt(stored as never, incoming as never) as unknown as Expense[];
    expect(out.map((r) => r.noReceipt?.reason ?? null)).toEqual([null, "Ticket lost"]);
    expect(out[1].price).toBe(250);
  });
  it("a row that now has a receipt loses the reason", () => {
    const out = carryNoReceipt([ticket(why("Ticket lost"))] as never, [ticket({ receiptUrl: "https://example.test/t.pdf" })] as never) as unknown as Expense[];
    expect(out[0].noReceipt).toBeUndefined();
    expect(withoutNoReceipt(ticket()) ).toEqual(ticket());
  });
  it("adopting the guide's figures keeps the official row's id, so its reason and files stay with it", () => {
    const official = [ferry(why("No ticket from the pier"))];
    const reported = [{ description: "Ferry", price: 6, pax: 5, expenseType: "transport", paidBy: "guide" } as Expense];
    expect(adoptReportedExpenses(official, reported)[0].rowId).toBe("r_bbbbbbbbbbbb");
  });
});

describe("on the certificate in lieu of a receipt", () => {
  it("each row carries its own reason, for both kinds", () => {
    expect(certifiableRows([ticket(why("Stub only, no price"))], "COMPANY_ADVANCE")[0].noReceiptReason).toBe("Stub only, no price");
    expect(certifiableRows([ferry(why("No ticket from the pier"))], "GUIDE_PAID")[0].noReceiptReason).toBe("No ticket from the pier");
  });
  it("a row with no reason fingerprints exactly as before — certificates already issued do not go stale", () => {
    const rows = certifiableRows([ferry()], "GUIDE_PAID");
    expect("noReceiptReason" in rows[0]).toBe(false);
    expect(canonicalString(buildPayload(facts, rows))).not.toMatch(/why=/);
  });
  it("the reason is part of the fingerprint: changing it changes what the document says", () => {
    const a = payloadHash(buildPayload(facts, certifiableRows([ferry(why("Ticket lost"))], "GUIDE_PAID")));
    const b = payloadHash(buildPayload(facts, certifiableRows([ferry(why("Seller gives none"))], "GUIDE_PAID")));
    const none = payloadHash(buildPayload(facts, certifiableRows([ferry()], "GUIDE_PAID")));
    expect(new Set([a, b, none]).size).toBe(3);
  });
  it("the document prints it under the row", () => {
    const view = (p: ReturnType<typeof buildPayload>) => renderCertificateHtml({ payload: p, certificateNo: "CERT-TEST", draft: true } as never);
    const html = view(buildPayload(facts, certifiableRows([ticket(why("Stub only, no price"))], "COMPANY_ADVANCE"), null, undefined, { advances: ["FOLK-ADV-209903-001"] }));
    expect(html).toContain("ไม่มีใบเสร็จ: Stub only, no price");
    expect(html).toContain("ตามที่ระบุไว้ในแต่ละรายการด้านล่าง");
    const plain = view(buildPayload(facts, certifiableRows([ferry()], "GUIDE_PAID")));
    expect(plain).not.toContain("ไม่มีใบเสร็จ:");
  });
});
