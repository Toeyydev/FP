import { describe, expect, it } from "vitest";
import { amountsByAccount, expenseAccountsFrom, settlementLines } from "./expense-accounts";
import { incompatibleOwners, type PeakOwner } from "./peak-ownership";
import { checkDocumentMatches, type PeakDocument } from "./peak-link";

// Phase 1E, the pure rules: explicit lines, the account chart, ownership, document checks.
// Invented figures only.

const line = (over: Record<string, unknown> = {}) => ({ index: 0, identity: "id-0", category: "entrance", amountSatang: 50_000, advanceId: "adv-1", description: "Temple ticket", ...over });
const entry = (lines: unknown[], amountSatang = 50_000, extra: Record<string, unknown> = {}) => ({ advanceId: "adv-1", amountSatang, snapshot: { lines, total: amountSatang, ...extra } });
const adv = { allowedCategories: ["entrance", "meal", "transport", "other"], advanceNo: "FOLK-ADV-209901-001" };

describe("settlementLines — the only amounts", () => {
  it("accepts lines that add up to the ledger entry", () => {
    expect(settlementLines(entry([line(), line({ index: 1, category: "meal", amountSatang: 20_000 })], 70_000), adv)).toMatchObject({ ok: true, totalSatang: 70_000 });
  });
  it("ignores the older rows copy entirely", () => {
    expect(settlementLines(entry([line()], 50_000, { rows: [{ amount: 999 }] }), adv)).toMatchObject({ ok: true, totalSatang: 50_000 });
  });
  it("refuses: no lines; a line for another advance; a category the advance does not allow; a total that disagrees", () => {
    expect(settlementLines({ advanceId: "adv-1", amountSatang: 50_000, snapshot: { rows: [{ amount: 500 }] } }, adv).ok).toBe(false);
    expect(settlementLines(entry([line({ advanceId: "adv-2" })]), adv).ok).toBe(false);
    expect(settlementLines(entry([line({ category: "meal" })]), { ...adv, allowedCategories: ["entrance"] }).ok).toBe(false);
    expect(settlementLines(entry([line({ category: "guide_fee" })]), adv).ok).toBe(false);
    expect(settlementLines(entry([line()], 60_000), adv).ok).toBe(false);
    expect(settlementLines(entry([line({ amountSatang: 0 })], 0), adv).ok).toBe(false);
  });
});

describe("the account chart", () => {
  const chart = expenseAccountsFrom([
    { folkopsCategory: "ENTRANCE_TICKET", peakAccountCode: "510104", isActive: true },
    { folkopsCategory: "MEAL_REFRESHMENT", peakAccountCode: "510105", isActive: true },
    { folkopsCategory: "TRANSPORTATION", peakAccountCode: "510106", isActive: false },
    { folkopsCategory: "OTHER_TOUR_COST", peakAccountCode: "  ", isActive: true },
  ]);
  it("maps only live, non-blank codes", () => expect(chart).toEqual({ entrance: "510104", meal: "510105" }));
  it("sums lines per account and refuses any unmapped category by name", () => {
    expect(amountsByAccount([line(), line({ category: "meal", amountSatang: 1_000 })] as never, chart)).toMatchObject({ ok: true, byAccount: new Map([["510104", 50_000], ["510105", 1_000]]) });
    const r = amountsByAccount([line({ category: "transport" }), line({ category: "other" })] as never, chart);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join(" ")).toMatch(/transport \(TRANSPORTATION\).*other \(OTHER_TOUR_COST\)/);
  });
});

describe("ownership — one financial owner per PEAK document (owner decision 2026-10-02)", () => {
  const job = { sheetId: "sheet-1", guideId: "G-990", date: "2099-01-02", slotIdx: 0 };
  const sameJobPay: PeakOwner = { domain: "GUIDE_PAYMENT", id: "tp-1", label: "x", job: { guideId: "G-990", date: "2099-01-02", slotIdx: 0 } };
  const sameJobCombined: PeakOwner = { domain: "COMBINED_PAYMENT", id: "pd-1", label: "FOLK-PAY", guideId: "G-990", jobs: [{ date: "2099-01-02", slotIdx: 0 }] };
  const sameJobSheet: PeakOwner = { domain: "JOB_SHEET", id: "sheet-1", label: "FOLK-TEST", job: { guideId: "G-990", date: "2099-01-02", slotIdx: 0 } };
  const sameGuideSupp: PeakOwner = { domain: "SUPPLEMENTAL_PAYMENT", id: "s", label: "s", guideId: "G-990" };
  it("an advance issue or a return shares with nothing", () => {
    expect(incompatibleOwners([sameJobPay], { kind: "ADVANCE", sourceId: "a" })).toEqual([sameJobPay]);
    expect(incompatibleOwners([sameJobPay], { kind: "RETURN", sourceId: "r" })).toEqual([sameJobPay]);
  });
  it("its own record is not a clash (a replay)", () => {
    expect(incompatibleOwners([{ domain: "ADVANCE_ISSUE", id: "a", label: "FOLK-ADV" }], { kind: "ADVANCE", sourceId: "a" })).toEqual([]);
    expect(incompatibleOwners([{ domain: "ADVANCE_SETTLEMENT", id: "e", label: "x" }], { kind: "EXPENSE", sourceId: "e", job })).toEqual([]);
  });
  it("a settlement shares nothing — not its own job's guide payment, combined payment, job sheet document or payment transfer, nor anything of the same guide", () => {
    for (const o of [sameJobPay, sameJobCombined, sameJobSheet, sameGuideSupp, { domain: "PAYMENT_TRANSACTION", id: "t", label: "t" } as PeakOwner, { domain: "ADVANCE_SETTLEMENT", id: "other-entry", label: "x" } as PeakOwner]) {
      expect(incompatibleOwners([o], { kind: "EXPENSE", sourceId: "e", job })).toEqual([o]);
    }
  });
});

describe("checkDocumentMatches — Phase 1E", () => {
  const config = { advanceAccountCode: "111100", bankAccountCode: "111300", bankAccountSubId: "sub-bank" };
  const jv = (entries: PeakDocument["entries"], extra: Partial<PeakDocument> = {}): PeakDocument => ({ code: "JV-9", documentType: "DAILY_JOURNAL", contactId: "c-1", entries, ...extra });
  it("an advance issue or a return is never an expense document", () => {
    for (const kind of ["ADVANCE", "RETURN"] as const) expect(checkDocumentMatches({ kind, amountSatang: 100, document: { code: "EXP-9", documentType: "EXPENSE" }, config }).reasons).toHaveLength(1);
  });
  it("an advance issue that also credits the advance account is refused", () => {
    const r = checkDocumentMatches({ kind: "ADVANCE", amountSatang: 100_000, config, document: jv([{ accountCode: "111100", debit: 1000, credit: 0 }, { accountCode: "111100", debit: 0, credit: 200 }, { accountCode: "111300", accountSubId: "sub-bank", debit: 0, credit: 1000 }]) });
    expect(r.reasons.join(" ")).toMatch(/also credits the advance account/);
  });
  it("a settlement journal must put each line's amount on its own account, exactly", () => {
    const doc = jv([{ accountCode: "510104", debit: 500, credit: 0 }, { accountCode: "510105", debit: 200, credit: 0 }, { accountCode: "111100", debit: 0, credit: 700 }]);
    expect(checkDocumentMatches({ kind: "EXPENSE", amountSatang: 70_000, config, document: doc, expenseByAccount: new Map([["510104", 50_000], ["510105", 20_000]]) }).reasons).toEqual([]);
    expect(checkDocumentMatches({ kind: "EXPENSE", amountSatang: 70_000, config, document: doc, expenseByAccount: new Map([["510104", 70_000]]) }).reasons.join(" ")).toMatch(/510104/);
  });
  it("a return with a refunded excess: the advance side is checked, the bank side is left to the accountant — with a warning", () => {
    const doc = jv([{ accountCode: "111300", accountSubId: "sub-bank", debit: 500, credit: 0 }, { accountCode: "111100", debit: 0, credit: 300 }, { accountCode: "219999", debit: 0, credit: 200 }]);
    const r = checkDocumentMatches({ kind: "RETURN", amountSatang: 30_000, config, document: doc, bankSideUnchecked: true });
    expect(r.reasons).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/accountant decision/);
    expect(checkDocumentMatches({ kind: "RETURN", amountSatang: 30_000, config, document: doc }).reasons.join(" ")).toMatch(/debits 500.00 to the bank, not 300.00/);
  });
});
