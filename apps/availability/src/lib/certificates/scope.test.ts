import { describe, expect, it } from "vitest";
import type { Expense } from "@/lib/jobsheet";
import { buildPayload, certifiableRows, payloadHash, type SheetFacts } from "@/lib/certificates/payload";
import { renderCertificateHtml, SCOPE_NOTICE_TH } from "@/lib/certificates/document";

// What a certificate in lieu of a receipt is allowed to say, and what it must never say.
//
// PEAK prints its own "ใบรับรองแทนใบเสร็จรับเงิน" from a whole EXP, and for a combined
// guide payment that page adds up the fee, the review reward, the withholding and the
// net transfer along with the reimbursements. It certifies a number that is mostly
// wages, which makes it worthless as evidence for the part that has no receipt.
//
// This document is the opposite on purpose: the unreceipted reimbursement rows, their
// total, and nothing else. The figures below are the ones that must never appear on it.
//
// All data invented — this repo is public.

// One guide, one transfer, four things in it.
const EXP_TOTAL = 1924;        // what PEAK's own page would certify
const GUIDE_FEE = 1500;        // wages
const REVIEW_REWARD = 100;     // earned, not spent
const MEAL = 90;               // the guide's own money, no receipt
const TRANSPORT = 234;         // the guide's own money, no receipt
const CERTIFIED = MEAL + TRANSPORT; // 324

const FACTS: SheetFacts = {
  jobRef: "FOLK-TEST-20990401-01", tourDate: "2099-04-01", slotIdx: 0,
  guideId: "G-900", guideName: "Somchai Testsuite",
  guideReportedAt: new Date("2099-04-02T06:30:00.000Z"),
};

/** Everything on the sheet the EXP was built from. The fee is not here — it is a field. */
const SHEET: Expense[] = [
  { description: "Lunch, no receipt issued", price: MEAL, pax: 1, expenseType: "meal", paidBy: "guide", paidBySource: "operator" },
  { description: "Ferry and bus", price: TRANSPORT, pax: 1, expenseType: "transport", paidBy: "guide", paidBySource: "operator" },
  { description: "Review reward", price: REVIEW_REWARD, pax: 1, expenseType: "other", paidBy: "guide", paidBySource: "operator" },
  { description: "Temple tickets", price: 600, pax: 1, expenseType: "entrance", paidBy: "advance", paidBySource: "operator" },
  { description: "Van hire", price: 1200, pax: 1, expenseType: "transport", paidBy: "company", paidBySource: "operator" },
  { description: "Boat with a receipt", price: 150, pax: 1, expenseType: "transport", paidBy: "guide", paidBySource: "operator", receiptUrl: "https://drive.example.test/r" },
] as Expense[];

describe("a certificate covers the unreceipted reimbursements and nothing else", () => {
  it("picks up the two rows the guide fronted with no receipt, and only those", () => {
    const rows = certifiableRows(SHEET);
    expect(rows.map((r) => r.description)).toEqual(["Lunch, no receipt issued", "Ferry and bus"]);
  });

  it("the total is the covered rows' total — ฿324, not the ฿1,924 the transfer was", () => {
    const payload = buildPayload(FACTS, certifiableRows(SHEET));
    expect(payload.totalSatang).toBe(CERTIFIED * 100);
    expect(payload.totalSatang).not.toBe(EXP_TOTAL * 100);
    expect(payload.rows).toHaveLength(2);
  });

  it("no wage, reward, advance or company row can reach the payload at all", () => {
    const json = JSON.stringify(buildPayload(FACTS, certifiableRows(SHEET)));
    for (const forbidden of ["Review reward", "Temple tickets", "Van hire", "Boat with a receipt"]) {
      expect(json, `${forbidden} reached the certificate`).not.toContain(forbidden);
    }
    // A fee is not even an expense row — it is `guideFee` on the sheet — so there is no
    // shape of this data in which it could be picked up. This says so out loud.
    expect(json).not.toContain("guideFee");
  });
});

describe("the figures that must never be printed on it", () => {
  const html = () =>
    renderCertificateHtml({
      certificateNo: "CERT-FOLK-TEST-20990401-01-01",
      payload: buildPayload(FACTS, certifiableRows(SHEET)),
      payloadHash: payloadHash(buildPayload(FACTS, certifiableRows(SHEET))),
      attestedByName: "Anong Testsuite", attestedByRole: "ADMIN",
      attestedAt: "2099-04-03T04:00:00.000Z", auditRef: "cert_test_1",
    } as never);

  it("shows ฿324, and says so in words as well as figures", () => {
    const out = html();
    expect(out).toContain("324.00");
    expect(out).toContain("สามร้อยยี่สิบสี่บาทถ้วน");
  });

  it("shows neither the fee, the reward, the EXP total, nor a net transfer", () => {
    const out = html();
    for (const [what, amount] of [
      ["the guide's fee", GUIDE_FEE],
      ["the review reward", REVIEW_REWARD],
      ["the whole EXP", EXP_TOTAL],
    ] as const) {
      expect(out, `${what} (${amount}) is printed on the certificate`).not.toContain(`${amount.toLocaleString("en-US")}.00`);
    }
    // And no heading under which any of them could be added later.
    for (const word of ["ค่าจ้าง", "ค่าตอบแทน", "หัก ณ ที่จ่าย", "ยอดโอน", "ยอดสุทธิ", "WHT", "EXP-"]) {
      // "ไม่ถือเป็นค่าตอบแทนของไกด์" and the scope notice are the document saying what it
      // is NOT, so the check is for a printed FIGURE beside the word, not the word.
      const near = out.split(word).slice(1).map((t) => t.slice(0, 40));
      for (const after of near) {
        expect(after, `a figure is printed next to "${word}"`).not.toMatch(/\d[\d,]*\.\d\d/);
      }
    }
  });

  it("says in as many words what it does not cover", () => {
    expect(html()).toContain(SCOPE_NOTICE_TH);
    expect(SCOPE_NOTICE_TH).toBe(
      "เอกสารฉบับนี้ครอบคลุมเฉพาะรายการค่าใช้จ่ายที่ระบุด้านล่าง และไม่ครอบคลุมค่าจ้าง ค่าตอบแทน หรือรายการอื่นในเอกสาร PEAK ที่อ้างอิง",
    );
  });

  it("the notice stands above the rows it is talking about", () => {
    const out = html();
    expect(out.indexOf(SCOPE_NOTICE_TH)).toBeLessThan(out.indexOf("Lunch, no receipt issued"));
  });
});
