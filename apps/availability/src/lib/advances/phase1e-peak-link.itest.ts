import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Advance settlement, Phase 1E, against a real database: MANUAL PEAK linking, hardened.
// Explicit settlement lines are the only amounts; any allowed category through the saved
// chart; an advance issue is never an expense; a return is linked for what reached the
// advance, never its face value; one ownership check across every place FolkOPS records a
// PEAK number; idempotent retries; an audited correction; nothing ever sent to PEAK.
// Every guide, figure and document number below is invented — this repo is public.

const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
const fetchSpy = vi.hoisted(() => vi.fn(async () => { throw new Error("no network in this test"); }));
vi.stubGlobal("fetch", fetchSpy);

import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { financialIdentity } from "@/lib/protected-expense-fields";
import { approveRefund, allocateReceipt, payRefund, recordReceipt, recordRefund, reverseEntry, settleFromExpenses, verifyReceipt } from "./service";
import { linkExistingPeakDocument, previewLink, unlinkPeakDocument, type DocumentLookup, type LinkRequest, type PeakDocument } from "./peak-link";
import { syncAdvanceBatch } from "./peak-sync";
import { summariesFor } from "./summaries";
import { guidePayoutTotal } from "@/lib/peak-sync";
import { POST as LINK } from "@/app/api/advances/peak-link/route";
import { POST as UNLINK } from "@/app/api/advances/peak-link/unlink/route";
import type { Expense } from "@/lib/jobsheet";

const CONFIG = {
  advanceAccountCode: "111100", advanceAccountSubId: "sub-advance",
  bankName: "Company account", bankAccountCode: "111300", bankAccountSubId: "sub-bank",
  journalTypeIds: { ADVANCE: "5", RETURN: "5", EXPENSE: "5" }, expenseAccounts: {},
};
const G = "G-918", DATE = "2099-12-04";
const COST = "510104"; // what the migrations seed for entrance, transport and meal
let admin = { actorId: "", actorRole: "ADMIN" }, other = { actorId: "", actorRole: "ADMIN" };
let seq = 0;

// ── PEAK documents, as a read-only lookup would return them ──────────────────
const advLine = (debit: number, credit: number) => ({ accountCode: "111100", accountSubId: "sub-advance", debit, credit });
const bankLine = (debit: number, credit: number) => ({ accountCode: "111300", accountSubId: "sub-bank", debit, credit });
const issueDoc = (code: string, baht: number, extra: Partial<PeakDocument> = {}): PeakDocument => ({ code, documentType: "DAILY_JOURNAL", contactId: null, entries: [advLine(baht, 0), bankLine(0, baht)], ...extra });
const returnDoc = (code: string, toAdvance: number, toBank = toAdvance): PeakDocument => ({ code, documentType: "DAILY_JOURNAL", contactId: null, entries: [bankLine(toBank, 0), advLine(0, toAdvance)] });
const expenseDoc = (code: string, byAccount: Record<string, number>, fromAdvance = Object.values(byAccount).reduce((a, b) => a + b, 0)): PeakDocument => ({
  code, documentType: "DAILY_JOURNAL", contactId: null,
  entries: [...Object.entries(byAccount).map(([accountCode, debit]) => ({ accountCode, debit, credit: 0 })), advLine(0, fromAdvance)],
});
const lookupCalls: string[] = [];
const lookupOf = (...docs: PeakDocument[]): DocumentLookup => async (no) => {
  lookupCalls.push(no);
  const d = docs.find((x) => x.code === no);
  return d ? { ok: true, document: d } : { ok: false, notFound: true, desc: "not found" };
};

// ── the ledger, through the ordinary paths ───────────────────────────────────
type Row = Partial<Expense> & { description: string; price: number; pax: number; expenseType: string };
async function job(rows: Row[], cats: string[], over: { slotIdx?: number; amount?: number } = {}) {
  const slotIdx = over.slotIdx ?? 0;
  const sheet = await prisma.jobSheet.create({ data: {
    ref: `FOLK-TEST-1E-${++seq}`, guideId: G, date: DATE, slotIdx, tourId: "T-900", status: "Confirmed", approvalStatus: "APPROVED",
    bookings: [{ name: "Guest Example Person", bookingNo: "GYGEXAMPLE1E", bookedPax: 2 }] as never, guideFee: { price: 1000, time: 1, whtPct: 3 },
    expenses: rows.map((r) => ({ paidBy: "advance", paidBySource: "operator", ...r })) as unknown as Prisma.InputJsonValue,
  } });
  const amount = over.amount ?? 1000;
  const advance = await prisma.guideAdvance.create({ data: {
    guideId: G, date: DATE, slotIdx, amount, paidAt: new Date("2099-12-03T03:00:00Z"), method: "bank", txRef: `TX-1E-${seq}`,
    advanceNo: `FOLK-ADV-209912-${String(seq).padStart(3, "0")}`, advanceDate: "2099-12-03", amountSatang: amount * 100, accountingPeriod: "2099-12",
    jobNo: sheet.ref, slipUrl: "https://example.test/slip", allowedCategories: cats,
  } });
  const linked = (sheet.expenses as unknown as Row[]).map((r) => (r.paidBy === "advance" ? { ...r, advanceId: advance.id } : r));
  await prisma.jobSheet.update({ where: { id: sheet.id }, data: { expenses: linked as unknown as Prisma.InputJsonValue } });
  return { sheet, advance };
}
async function settle(advanceId: string, sheetId: string) {
  const sheet = await prisma.jobSheet.findUniqueOrThrow({ where: { id: sheetId } });
  const rows = sheet.expenses as unknown as Parameters<typeof financialIdentity>[0][];
  const lines = rows.map((r, index) => ({ r, index })).filter(({ r }) => (r as { advanceId?: string }).advanceId === advanceId).map(({ r, index }) => ({ index, identity: financialIdentity(r) }));
  const res = await settleFromExpenses(prisma, { advanceId, jobSheetId: sheetId, sheetVersion: sheet.updatedAt.toISOString(), lines, actor: admin });
  if (!res.ok) throw new Error(res.reasons.join("; "));
  return res.entryId;
}
async function verifiedReturn(amount: number, advanceId: string) {
  const r = await recordReceipt(prisma, { guideId: G, receivedDate: "2026-09-05", amount, byGuide: true, today: "2099-12-31", bankRef: null, note: null, advanceId, jobSheetId: null, actor: { actorId: null, actorRole: "GUIDE" } });
  if (!r.ok) throw new Error(r.reasons.join(";"));
  const v = await verifyReceipt(prisma, { receiptId: r.receipt.id, bankRef: `BANK-1E-${++seq}`, actor: admin });
  if (!v.ok) throw new Error(v.reasons.join(";"));
  return r.receipt.id;
}
const expense = (advanceId: string, jobSheetId: string, documentNo: string, over: Partial<Extract<LinkRequest, { kind: "EXPENSE" }>> = {}): LinkRequest =>
  ({ kind: "EXPENSE", advanceId, jobSheetId, documentNo, documentType: "DAILY_JOURNAL", note: "matched in PEAK by the accountant (example)", acknowledgeWarnings: true, requestKey: `rk-${++seq}-example`, actor: admin, ...over });
const issue = (advanceId: string, documentNo: string, over: Partial<LinkRequest> = {}): LinkRequest =>
  ({ kind: "ADVANCE", advanceId, documentNo, documentType: "DAILY_JOURNAL", note: "the transfer on the statement (example)", acknowledgeWarnings: true, requestKey: `rk-${++seq}-example`, actor: admin, ...over } as LinkRequest);
const ret = (receiptId: string, documentNo: string): LinkRequest =>
  ({ kind: "RETURN", receiptId, documentNo, documentType: "DAILY_JOURNAL", note: "the return on the statement (example)", acknowledgeWarnings: true, requestKey: `rk-${++seq}-example`, actor: admin, allocations: [] });
const reasons = (r: unknown) => ((r as { reasons?: string[] }).reasons ?? []).join(" ");

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.stubEnv("PEAK_ADVANCE_CONFIG", JSON.stringify(CONFIG));
  vi.stubEnv("ADVANCE_WRITES_FROZEN", "0");
  vi.stubEnv("ADVANCE_EXISTING_PEAK_LINKS_ENABLED", "1");
  vi.stubEnv("PEAK_ADVANCE_AUTO_SYNC", "0");
  fetchSpy.mockClear(); lookupCalls.length = 0;
  await resetDatabase();
  await seedGuide(G);
  const a = await prisma.user.create({ data: { email: "admin-1e@example.test", displayName: "Admin Example", role: "ADMIN", state: "ACTIVE" } });
  const b = await prisma.user.create({ data: { email: "admin2-1e@example.test", displayName: "Second Admin Example", role: "ADMIN", state: "ACTIVE" } });
  admin = { actorId: a.id, actorRole: "ADMIN" }; other = { actorId: b.id, actorRole: "ADMIN" };
});
afterEach(() => vi.unstubAllEnvs());

describe("1–3 · the settlement's explicit lines are the only amounts", () => {
  it("1 · linked as the ledger recorded it — a later change to the job sheet does not move the amount", async () => {
    const { sheet, advance } = await job([{ description: "Temple ticket", price: 300, pax: 2, expenseType: "entrance" }, { description: "Lunch", price: 100, pax: 2, expenseType: "meal" }], ["entrance", "meal"]);
    await settle(advance.id, sheet.id);
    // The sheet now says something else (a direct edit, as if from before protection existed).
    const rows = (await prisma.jobSheet.findUniqueOrThrow({ where: { id: sheet.id } })).expenses as unknown as Row[];
    await prisma.jobSheet.update({ where: { id: sheet.id }, data: { expenses: rows.map((r) => ({ ...r, price: r.price + 50 })) as unknown as Prisma.InputJsonValue } });
    expect(reasons(await linkExistingPeakDocument(prisma, expense(advance.id, sheet.id, "JV-1E-101"), lookupOf(expenseDoc("JV-1E-101", { [COST]: 1000 }))))).toMatch(/takes 1,000.00 out of the advance account, not 800.00/);
    expect(await linkExistingPeakDocument(prisma, expense(advance.id, sheet.id, "JV-1E-102"), lookupOf(expenseDoc("JV-1E-102", { [COST]: 800 })))).toMatchObject({ ok: true });
  });
  it("2 · the older `rows` copy can never set the amount — and a settlement with only `rows` is refused", async () => {
    const { sheet, advance } = await job([{ description: "Temple ticket", price: 500, pax: 1, expenseType: "entrance" }], ["entrance"]);
    const entryId = await settle(advance.id, sheet.id);
    const e = await prisma.guideAdvanceEntry.findUniqueOrThrow({ where: { id: entryId } });
    const snap = e.snapshot as { rows: { amount: number }[] };
    await prisma.$executeRawUnsafe(`UPDATE "GuideAdvanceEntry" SET snapshot = $1::jsonb WHERE id = $2`, JSON.stringify({ ...snap, rows: snap.rows.map((r) => ({ ...r, amount: 999 })) }), entryId);
    expect((await linkExistingPeakDocument(prisma, expense(advance.id, sheet.id, "JV-1E-201"), lookupOf(expenseDoc("JV-1E-201", { [COST]: 999 })))).ok).toBe(false);
    expect((await linkExistingPeakDocument(prisma, expense(advance.id, sheet.id, "JV-1E-202"), lookupOf(expenseDoc("JV-1E-202", { [COST]: 500 })))).ok).toBe(true);

    // An entry from before explicit lines: rows only.
    const two = await job([{ description: "Old ticket", price: 400, pax: 1, expenseType: "entrance" }], ["entrance"], { slotIdx: 1 });
    await prisma.guideAdvance.update({ where: { id: two.advance.id }, data: { settledSatang: 40_000 } });
    await prisma.guideAdvanceEntry.create({ data: { advanceId: two.advance.id, type: "EXPENSE_SETTLEMENT", amountSatang: 40_000, effectiveDate: DATE, accountingPeriod: "2099-12", sourceType: "JOB_SHEET", sourceId: two.sheet.id, jobNo: two.sheet.ref, requestKey: "legacy-rows-example", idempotencyKey: "legacy-rows-example", snapshot: { rows: [{ description: "Old ticket", amount: 400, category: "entrance" }] } } });
    const legacy = await linkExistingPeakDocument(prisma, expense(two.advance.id, two.sheet.id, "JV-1E-203"), lookupOf(expenseDoc("JV-1E-203", { [COST]: 400 })));
    expect(reasons(legacy)).toMatch(/no explicit lines/);
  });
  it("3 · lines that do not add up to the ledger entry are refused", async () => {
    const { sheet, advance } = await job([{ description: "Temple ticket", price: 500, pax: 1, expenseType: "entrance" }], ["entrance"]);
    const entryId = await settle(advance.id, sheet.id);
    const e = await prisma.guideAdvanceEntry.findUniqueOrThrow({ where: { id: entryId } });
    const snap = e.snapshot as { lines: { amountSatang: number }[] };
    await prisma.$executeRawUnsafe(`UPDATE "GuideAdvanceEntry" SET snapshot = $1::jsonb WHERE id = $2`, JSON.stringify({ ...snap, lines: snap.lines.map((l) => ({ ...l, amountSatang: 45_000 })) }), entryId);
    expect(reasons(await linkExistingPeakDocument(prisma, expense(advance.id, sheet.id, "JV-1E-301"), lookupOf(expenseDoc("JV-1E-301", { [COST]: 500 }))))).toMatch(/must agree exactly/);
    expect(await prisma.advancePeakDocumentLink.count()).toBe(0);
  });
});

describe("4–7 · any category the advance allowed, through the saved chart", () => {
  for (const [n, cat] of [["4", "entrance"], ["5", "meal"], ["6", "transport"]] as const) {
    it(`${n} · a ${cat} settlement links to its mapped account`, async () => {
      const { sheet, advance } = await job([{ description: `${cat} cost (example)`, price: 250, pax: 2, expenseType: cat }], [cat]);
      await settle(advance.id, sheet.id);
      expect(await linkExistingPeakDocument(prisma, expense(advance.id, sheet.id, `JV-1E-40${n}`), lookupOf(expenseDoc(`JV-1E-40${n}`, { [COST]: 500 })))).toMatchObject({ ok: true });
    });
  }
  it("6b · with the transport mapping switched off, the same link is refused — never a guessed account", async () => {
    const { sheet, advance } = await job([{ description: "Boat (example)", price: 250, pax: 2, expenseType: "transport" }], ["transport"]);
    await settle(advance.id, sheet.id);
    await prisma.peakAccountMapping.update({ where: { folkopsCategory: "TRANSPORTATION" }, data: { isActive: false } });
    try {
      expect(reasons(await linkExistingPeakDocument(prisma, expense(advance.id, sheet.id, "JV-1E-406"), lookupOf(expenseDoc("JV-1E-406", { [COST]: 500 }))))).toMatch(/No PEAK account is mapped for transport \(TRANSPORTATION\)/);
    } finally {
      await prisma.peakAccountMapping.update({ where: { folkopsCategory: "TRANSPORTATION" }, data: { isActive: true } });
    }
  });
  it("7 · 'other' with no mapped account is refused, naming the category", async () => {
    const { sheet, advance } = await job([{ description: "Longtail hire (example)", price: 300, pax: 1, expenseType: "other" }], ["entrance", "other"]);
    await settle(advance.id, sheet.id);
    expect(reasons(await linkExistingPeakDocument(prisma, expense(advance.id, sheet.id, "JV-1E-407"), lookupOf(expenseDoc("JV-1E-407", { [COST]: 300 }))))).toMatch(/No PEAK account is mapped for other \(OTHER_TOUR_COST\)/);
  });
  it("a journal that puts the right total on the wrong expense account is refused", async () => {
    const { sheet, advance } = await job([{ description: "Temple ticket", price: 500, pax: 1, expenseType: "entrance" }], ["entrance"]);
    await settle(advance.id, sheet.id);
    expect(reasons(await linkExistingPeakDocument(prisma, expense(advance.id, sheet.id, "JV-1E-408"), lookupOf(expenseDoc("JV-1E-408", { "510199": 500 }))))).toMatch(/debits 0.00 to expense account 510104/);
  });
});

describe("8–9 · an advance issue", () => {
  it("8 · the issued amount must match exactly", async () => {
    const { advance } = await job([], ["entrance"]);
    expect(reasons(await linkExistingPeakDocument(prisma, issue(advance.id, "JV-1E-801"), lookupOf(issueDoc("JV-1E-801", 900))))).toMatch(/debits 900.00 to the advance account, not 1,000.00/);
    expect(await linkExistingPeakDocument(prisma, issue(advance.id, "JV-1E-802"), lookupOf(issueDoc("JV-1E-802", 1000)))).toMatchObject({ ok: true });
  });
  it("9 · is never an expense: an expense document, or a journal that books it to an expense account, is refused", async () => {
    const { advance } = await job([], ["entrance"]);
    expect(reasons(await linkExistingPeakDocument(prisma, issue(advance.id, "EXP-1E-901", { documentType: "EXPENSE" }), lookupOf({ code: "EXP-1E-901", documentType: "EXPENSE" })))).toMatch(/never an expense document/);
    const asExpense: PeakDocument = { code: "JV-1E-902", documentType: "DAILY_JOURNAL", contactId: null, entries: [{ accountCode: COST, debit: 1000, credit: 0 }, bankLine(0, 1000)] };
    expect(reasons(await linkExistingPeakDocument(prisma, issue(advance.id, "JV-1E-902"), lookupOf(asExpense)))).toMatch(/does not touch the guide advance account/);
    expect(await prisma.advancePeakDocumentLink.count()).toBe(0);
  });
  // Phase 1F: a real PEAK journal carries no reference field (the parser no longer invents one);
  // a contact is compared only when a document has one.
  it("a document for another PEAK contact, or a voided document, is refused", async () => {
    const { advance } = await job([], ["entrance"]);
    await prisma.user.updateMany({ where: { guideId: G }, data: { peakContactId: "contact-guide-example" } });
    expect(reasons(await linkExistingPeakDocument(prisma, issue(advance.id, "JV-1E-903"), lookupOf(issueDoc("JV-1E-903", 1000, { contactId: "contact-someone-else" }))))).toMatch(/another PEAK contact/);
    expect(reasons(await linkExistingPeakDocument(prisma, issue(advance.id, "JV-1E-904"), lookupOf(issueDoc("JV-1E-904", 1000, { isVoid: true }))))).toMatch(/void in PEAK/);
    expect(await linkExistingPeakDocument(prisma, issue(advance.id, "JV-1E-905"), lookupOf(issueDoc("JV-1E-905", 1000, { contactId: "contact-guide-example" })))).toMatchObject({ ok: true });
  });
});

describe("10 · a settlement's amount", () => {
  it("an amount typed for the link that is not the ledger's is refused; so is a document that carries another", async () => {
    const { sheet, advance } = await job([{ description: "Temple ticket", price: 500, pax: 1, expenseType: "entrance" }], ["entrance"]);
    await settle(advance.id, sheet.id);
    expect(reasons(await linkExistingPeakDocument(prisma, expense(advance.id, sheet.id, "JV-1E-1001", { amount: 450 }), lookupOf(expenseDoc("JV-1E-1001", { [COST]: 500 }))))).toMatch(/The settlement is 500, not 450/);
    expect(reasons(await linkExistingPeakDocument(prisma, expense(advance.id, sheet.id, "JV-1E-1002"), lookupOf(expenseDoc("JV-1E-1002", { [COST]: 450 }, 450))))).toMatch(/not 500.00/);
    expect(await prisma.advancePeakDocumentLink.count()).toBe(0);
  });
  it("there is nothing to link before the rows are settled — linking never writes a settlement", async () => {
    const { sheet, advance } = await job([{ description: "Temple ticket", price: 500, pax: 1, expenseType: "entrance" }], ["entrance"]);
    expect(reasons(await linkExistingPeakDocument(prisma, expense(advance.id, sheet.id, "JV-1E-1003"), lookupOf(expenseDoc("JV-1E-1003", { [COST]: 500 }))))).toMatch(/no live settlement/);
    expect(await prisma.guideAdvanceEntry.count()).toBe(0);
  });
});

describe("11–13 · a return is linked for what reached the advance", () => {
  async function overReturn() {
    // Advance 1,000; ฿700 of tickets settled; the guide sends back ฿500; ฿300 is owed, ฿200 is refunded.
    const { sheet, advance } = await job([{ description: "Temple ticket", price: 700, pax: 1, expenseType: "entrance" }], ["entrance"]);
    await settle(advance.id, sheet.id);
    const receiptId = await verifiedReturn(500, advance.id);
    const al = await allocateReceipt(prisma, { receiptId, allocations: [{ advanceId: advance.id, amount: 300 }], requestKey: "alloc-1e-example", actor: admin });
    if (!al.ok) throw new Error(al.reasons.join(";"));
    const f = await recordRefund(prisma, { receiptId, amount: 200, reason: "guide sent too much (example)", actor: admin });
    if (!f.ok) throw new Error(f.reasons.join(";"));
    return { sheet, advance, receiptId, refundId: f.refund.id };
  }
  it("11 · not the receipt's face value — and not while a refund is still undecided", async () => {
    const { receiptId, refundId } = await overReturn();
    expect(reasons(await linkExistingPeakDocument(prisma, ret(receiptId, "JV-1E-1101"), lookupOf(returnDoc("JV-1E-1101", 300))))).toMatch(/still recorded — pay or void it first/);
    await approveRefund(prisma, { refundId, actor: other });
    await payRefund(prisma, { refundId, paidAt: "2026-09-06T10:00:00+07:00", bankRef: "REFUND-1E-1", actor: admin });
    expect(reasons(await linkExistingPeakDocument(prisma, ret(receiptId, "JV-1E-1102"), lookupOf(returnDoc("JV-1E-1102", 500))))).toMatch(/credits 500.00 to the advance account, not 300.00/);
  });
  it("12–13 · 500 received → 300 allocated → the link is for 300; the ฿200 refund leaves the advance's 'returned' alone", async () => {
    const { advance, receiptId, refundId } = await overReturn();
    await approveRefund(prisma, { refundId, actor: other });
    await payRefund(prisma, { refundId, paidAt: "2026-09-06T10:00:00+07:00", bankRef: "REFUND-1E-2", actor: admin });
    const preview = await previewLink(prisma, ret(receiptId, "JV-1E-1201"), lookupOf(returnDoc("JV-1E-1201", 300, 500)));
    expect(preview).toMatchObject({ ok: true, amount: 300 });
    if (preview.ok) expect(preview.warnings.join(" ")).toMatch(/accountant decision/);
    const done = await linkExistingPeakDocument(prisma, ret(receiptId, "JV-1E-1201"), lookupOf(returnDoc("JV-1E-1201", 300, 500)));
    expect(done).toMatchObject({ ok: true });
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: "advance.peak_document_linked" } })).detail).toMatchObject({ amount: 300 });
    const s = (await summariesFor(prisma, [await prisma.guideAdvance.findUniqueOrThrow({ where: { id: advance.id } })])).get(advance.id)!;
    expect(s).toMatchObject({ issued: 100_000, used: 70_000, returned: 30_000, outstanding: 0, status: "SETTLED", driftSatang: 0 });
  });
});

describe("14–16 · ownership and idempotency", () => {
  it("14 · one PEAK number cannot carry two incompatible events — the owner is named", async () => {
    const { advance } = await job([], ["entrance"]);
    await prisma.tourPayment.create({ data: { guideId: G, date: "2099-12-01", slotIdx: 0, tourId: "T-900", status: "PAID", peakRef: "EXP-1E-1401" } as never });
    expect(reasons(await linkExistingPeakDocument(prisma, issue(advance.id, "EXP-1E-1401"), lookupOf(issueDoc("EXP-1E-1401", 1000))))).toMatch(/already recorded against a guide payment/);
    await linkExistingPeakDocument(prisma, issue(advance.id, "JV-1E-1402"), lookupOf(issueDoc("JV-1E-1402", 1000)));
    const second = await job([{ description: "Temple ticket", price: 200, pax: 1, expenseType: "entrance" }], ["entrance"], { slotIdx: 1 });
    expect(reasons(await linkExistingPeakDocument(prisma, issue(second.advance.id, "JV-1E-1402"), lookupOf(issueDoc("JV-1E-1402", 1000))))).toMatch(/already recorded against an advance issue \(FOLK-ADV-/);
  });
  // Owner decision 2026-10-02: one financial owner per PEAK document — no same-job, same-guide exception.
  const expDoc = (code: string): PeakDocument => ({ code, documentType: "EXPENSE" });
  async function settled() {
    const j = await job([{ description: "Temple ticket", price: 500, pax: 1, expenseType: "entrance" }], ["entrance"]);
    await settle(j.advance.id, j.sheet.id);
    return j;
  }
  it("O1 · a settlement cannot reuse its own job's guide payment document", async () => {
    const { sheet, advance } = await settled();
    await prisma.tourPayment.create({ data: { guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", status: "PAID", peakRef: "EXP-1E-1403" } as never });
    expect(reasons(await linkExistingPeakDocument(prisma, expense(advance.id, sheet.id, "EXP-1E-1403", { documentType: "EXPENSE" }), lookupOf(expDoc("EXP-1E-1403"))))).toMatch(/already recorded against a guide payment \(G-918 2099-12-04\)/);
    expect(await prisma.advancePeakDocumentLink.count()).toBe(0);
  });
  it("O2 · nor a combined payment document that includes its job", async () => {
    const { sheet, advance } = await settled();
    await prisma.guidePaymentDocument.create({ data: { paymentRef: "FOLK-PAY-209912-01", guideId: G, jobs: [{ date: DATE, slotIdx: 0, ref: sheet.ref, payout: 970 }], lines: [], total: 970, status: "PAID", peakDocumentNo: "EXP-1E-1405" } });
    expect(reasons(await linkExistingPeakDocument(prisma, expense(advance.id, sheet.id, "EXP-1E-1405", { documentType: "EXPENSE" }), lookupOf(expDoc("EXP-1E-1405"))))).toMatch(/already recorded against a combined guide payment \(FOLK-PAY-209912-01\)/);
  });
  it("O3 · the same job is no exception: its own job sheet document is refused too", async () => {
    const { sheet, advance } = await settled();
    await prisma.jobSheet.update({ where: { id: sheet.id }, data: { peakDocumentNo: "EXP-1E-1406" } });
    expect(reasons(await linkExistingPeakDocument(prisma, expense(advance.id, sheet.id, "EXP-1E-1406", { documentType: "EXPENSE" }), lookupOf(expDoc("EXP-1E-1406"))))).toMatch(/already recorded against a job sheet's expense document/);
  });
  it("O4 · the same guide is no exception: their supplemental payment's document is refused", async () => {
    const { sheet, advance } = await settled();
    await prisma.supplementalPayment.create({ data: { guideId: G, type: "BONUS", accountingCategory: "GUIDE_FEE", grossAmount: 300, whtPct: 0, whtSource: "ENTERED", wht: 0, netAmount: 300, reason: "example bonus", peakRef: "EXP-1E-1407" } as never });
    expect(reasons(await linkExistingPeakDocument(prisma, expense(advance.id, sheet.id, "EXP-1E-1407", { documentType: "EXPENSE" }), lookupOf(expDoc("EXP-1E-1407"))))).toMatch(/already recorded against a supplemental guide payment/);
  });
  it("15–16 · same event + same number is a replay (no second audit or row); same event + another number is refused", async () => {
    const { sheet, advance } = await job([{ description: "Temple ticket", price: 500, pax: 1, expenseType: "entrance" }], ["entrance"]);
    await settle(advance.id, sheet.id);
    const look = lookupOf(expenseDoc("JV-1E-1501", { [COST]: 500 }), expenseDoc("JV-1E-1502", { [COST]: 500 }));
    expect(await linkExistingPeakDocument(prisma, expense(advance.id, sheet.id, "JV-1E-1501"), look)).toMatchObject({ ok: true, replayed: false });
    expect(await linkExistingPeakDocument(prisma, expense(advance.id, sheet.id, "jv-1e-1501"), look)).toMatchObject({ ok: true, replayed: true });
    expect(reasons(await linkExistingPeakDocument(prisma, expense(advance.id, sheet.id, "JV-1E-1502"), look))).toMatch(/already linked to JV-1E-1501/);
    expect(await prisma.advancePeakDocumentLink.count()).toBe(1);
    expect(await prisma.advancePeakSync.count({ where: { kind: "EXPENSE" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "advance.peak_document_linked" } })).toBe(1);
  });
});

describe("17–19 · reversal and correction", () => {
  it("17 · a linked settlement cannot be reversed", async () => {
    const { sheet, advance } = await job([{ description: "Temple ticket", price: 500, pax: 1, expenseType: "entrance" }], ["entrance"]);
    const entryId = await settle(advance.id, sheet.id);
    await linkExistingPeakDocument(prisma, expense(advance.id, sheet.id, "JV-1E-1701"), lookupOf(expenseDoc("JV-1E-1701", { [COST]: 500 })));
    const r = await reverseEntry(prisma, { entryId, reason: "trying to undo (example)", actor: admin });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(reasons(r)).toMatch(/in PEAK \(JV-1E-1701\)/);
  });
  it("18 · an allocation of a linked return cannot be reversed", async () => {
    const { sheet, advance } = await job([{ description: "Temple ticket", price: 700, pax: 1, expenseType: "entrance" }], ["entrance"]);
    await settle(advance.id, sheet.id);
    const receiptId = await verifiedReturn(300, advance.id);
    await allocateReceipt(prisma, { receiptId, allocations: [{ advanceId: advance.id, amount: 300 }], requestKey: "alloc-1e-18", actor: admin });
    expect(await linkExistingPeakDocument(prisma, ret(receiptId, "JV-1E-1801"), lookupOf(returnDoc("JV-1E-1801", 300)))).toMatchObject({ ok: true });
    const alloc = await prisma.guideAdvanceEntry.findFirstOrThrow({ where: { receiptId, type: "RETURN_ALLOCATION" } });
    expect(reasons(await reverseEntry(prisma, { entryId: alloc.id, reason: "trying to undo (example)", actor: admin }))).toMatch(/in PEAK \(JV-1E-1801\)/);
  });
  it("19 · removing a wrong link needs a reason, is audited with what it was, never re-queues — and the right one can then be linked", async () => {
    const { sheet, advance } = await job([{ description: "Temple ticket", price: 500, pax: 1, expenseType: "entrance" }], ["entrance"]);
    const entryId = await settle(advance.id, sheet.id);
    const look = lookupOf(issueDoc("JV-1E-1901", 1000), issueDoc("JV-1E-1902", 1000), expenseDoc("JV-1E-1903", { [COST]: 500 }));
    await linkExistingPeakDocument(prisma, issue(advance.id, "JV-1E-1901"), look);
    expect(await unlinkPeakDocument(prisma, { kind: "ADVANCE", sourceId: advance.id, reason: "", actor: admin })).toMatchObject({ ok: false, status: 400 });
    // Something downstream rests on it: the settlement is in PEAK too.
    await linkExistingPeakDocument(prisma, expense(advance.id, sheet.id, "JV-1E-1903"), look);
    expect(reasons(await unlinkPeakDocument(prisma, { kind: "ADVANCE", sourceId: advance.id, reason: "wrong journal picked (example)", actor: admin }))).toMatch(/already in PEAK \(JV-1E-1903\)/);
    expect(await unlinkPeakDocument(prisma, { kind: "EXPENSE", sourceId: entryId, reason: "settlement journal was wrong (example)", actor: admin })).toMatchObject({ ok: true });
    expect(await unlinkPeakDocument(prisma, { kind: "ADVANCE", sourceId: advance.id, reason: "wrong journal picked (example)", actor: admin })).toMatchObject({ ok: true, documentNo: "JV-1E-1901" });
    expect(await prisma.advancePeakSync.findUnique({ where: { id: `ADVANCE:${advance.id}` } })).toMatchObject({ status: "CANCELLED" });
    expect(await prisma.guideAdvance.findUniqueOrThrow({ where: { id: advance.id } })).toMatchObject({ peakDocumentNo: null, peakRef: null });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "advance.peak_document_unlinked", entityId: advance.id } });
    expect(audit.detail).toMatchObject({ reason: "wrong journal picked (example)", before: { documentNo: "JV-1E-1901" } });
    expect(await linkExistingPeakDocument(prisma, issue(advance.id, "JV-1E-1902"), look)).toMatchObject({ ok: true });
    expect(await prisma.advancePeakSync.findUnique({ where: { id: `ADVANCE:${advance.id}` } })).toMatchObject({ status: "POSTED", documentNo: "JV-1E-1902" });
  });
  it("a document FolkOPS itself posted has no manual link to remove", async () => {
    const { advance } = await job([], ["entrance"]);
    await prisma.advancePeakSync.update({ where: { id: `ADVANCE:${advance.id}` }, data: { status: "POSTED", documentNo: "JV-1E-SENT" } });
    expect(reasons(await unlinkPeakDocument(prisma, { kind: "ADVANCE", sourceId: advance.id, reason: "trying anyway (example)", actor: admin }))).toMatch(/FolkOPS itself posted this/);
  });
});

describe("20–22 · nothing booked twice, nothing sent", () => {
  it("20–21 · O8 · guide-payment accounting is untouched: refused reuse changes nothing, the payout excludes the advance-funded cost, and the sender never posts the settlement again", async () => {
    const { sheet, advance } = await job([{ description: "Temple ticket", price: 500, pax: 1, expenseType: "entrance" }, { description: "Taxi (example)", price: 100, pax: 1, expenseType: "transport", paidBy: "guide", paidBySource: "operator" }], ["entrance"]);
    const entryId = await settle(advance.id, sheet.id);
    const pay = await prisma.tourPayment.create({ data: { guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", status: "PAID", peakRef: "EXP-1E-2001" } as never });
    const before = JSON.stringify(await prisma.tourPayment.findUniqueOrThrow({ where: { id: pay.id } }));
    expect((await linkExistingPeakDocument(prisma, expense(advance.id, sheet.id, "EXP-1E-2001", { documentType: "EXPENSE" }), lookupOf({ code: "EXP-1E-2001", documentType: "EXPENSE" }))).ok).toBe(false);
    // The settlement gets its own document.
    expect(await linkExistingPeakDocument(prisma, expense(advance.id, sheet.id, "JV-1E-2002"), lookupOf(expenseDoc("JV-1E-2002", { [COST]: 500 })))).toMatchObject({ ok: true });
    expect(JSON.stringify(await prisma.tourPayment.findUniqueOrThrow({ where: { id: pay.id } }))).toBe(before);
    const rows = (await prisma.jobSheet.findUniqueOrThrow({ where: { id: sheet.id } })).expenses as unknown as Expense[];
    const payout = guidePayoutTotal(rows, { price: 1000, time: 1, whtPct: 3 } as never);
    expect(payout.payoutExpenses).toBe(100); // only the guide's own taxi — the ฿500 ticket was the advance's
    expect(payout.excludedTagged).toBe(500);
    // The sender, switched on with reconciliation closed, finds the settlement already in PEAK.
    vi.stubEnv("PEAK_ADVANCE_AUTO_SYNC", "1"); vi.stubEnv("ADVANCE_EXISTING_PEAK_LINKS_ENABLED", "0");
    const post = vi.fn();
    await syncAdvanceBatch(prisma, post);
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ reference: `FOLK-SET-${entryId}` }));
    expect(await prisma.advancePeakSync.findUnique({ where: { id: `EXPENSE:${entryId}` } })).toMatchObject({ status: "POSTED", documentNo: "JV-1E-2002" });
  });
  it("22 · linking makes no network call and creates nothing in PEAK", async () => {
    const { sheet, advance } = await job([{ description: "Temple ticket", price: 500, pax: 1, expenseType: "entrance" }], ["entrance"]);
    await settle(advance.id, sheet.id);
    await linkExistingPeakDocument(prisma, issue(advance.id, "JV-1E-2201"), lookupOf(issueDoc("JV-1E-2201", 1000)));
    await linkExistingPeakDocument(prisma, expense(advance.id, sheet.id, "JV-1E-2202"), lookupOf(expenseDoc("JV-1E-2202", { [COST]: 500 })));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lookupCalls).toEqual(["JV-1E-2201", "JV-1E-2202"]); // reads only, through the lookup
    expect(await prisma.advancePeakSync.count({ where: { status: { in: ["SENDING", "UNCERTAIN"] } } })).toBe(0);
  });
});

describe("23–24 · who may link, and what the audit keeps", () => {
  it("23 · a guide, an operator and an accountant are refused linking and unlinking (403)", async () => {
    const { advance } = await job([], ["entrance"]);
    for (const role of ["GUIDE", "OPERATOR", "ACCOUNTANT"]) {
      authMock.auth.mockResolvedValue({ user: { id: "someone", role, ...(role === "GUIDE" ? { guideId: G } : {}) } });
      const link = await LINK(new NextRequest("http://test.local/x", { method: "POST", body: JSON.stringify({ kind: "ADVANCE", advanceId: advance.id, documentNo: "JV-1E-2301", note: "trying (example)", requestKey: "rk-2301-example" }) }));
      const unlink = await UNLINK(new NextRequest("http://test.local/x", { method: "POST", body: JSON.stringify({ kind: "ADVANCE", sourceId: advance.id, reason: "trying (example)" }) }));
      expect([role, link.status, unlink.status]).toEqual([role, 403, 403]);
    }
    expect(await prisma.advancePeakDocumentLink.count()).toBe(0);
  });
  it("24 · link and unlink audit carry no guest data", async () => {
    const { sheet, advance } = await job([{ description: "Temple ticket", price: 500, pax: 1, expenseType: "entrance" }], ["entrance"]);
    const entryId = await settle(advance.id, sheet.id);
    await linkExistingPeakDocument(prisma, expense(advance.id, sheet.id, "JV-1E-2401"), lookupOf(expenseDoc("JV-1E-2401", { [COST]: 500 })));
    await unlinkPeakDocument(prisma, { kind: "EXPENSE", sourceId: entryId, reason: "wrong journal (example)", actor: admin });
    const text = JSON.stringify(await prisma.auditLog.findMany({ where: { action: { startsWith: "advance.peak_document" } } }));
    for (const pii of ["Guest Example Person", "GYGEXAMPLE1E"]) expect(text).not.toContain(pii);
  });
});

describe("25 · an August-shaped case (invented figures), preview only", () => {
  it("issue 1,000 · expense 500 · return 500 — the economic cost is the 500 of tickets", async () => {
    const { sheet, advance } = await job([{ description: "Temple ticket", price: 500, pax: 1, expenseType: "entrance" }], ["entrance"]);
    await settle(advance.id, sheet.id);
    const receiptId = await verifiedReturn(500, advance.id);
    await allocateReceipt(prisma, { receiptId, allocations: [{ advanceId: advance.id, amount: 500 }], requestKey: "alloc-1e-25", actor: admin });
    const look = lookupOf(issueDoc("JV-1E-2501", 1000), expenseDoc("JV-1E-2502", { [COST]: 500 }), returnDoc("JV-1E-2503", 500));
    const a = await previewLink(prisma, issue(advance.id, "JV-1E-2501"), look);
    const b = await previewLink(prisma, expense(advance.id, sheet.id, "JV-1E-2502"), look);
    const c = await previewLink(prisma, ret(receiptId, "JV-1E-2503"), look);
    expect([a, b, c].map((p) => (p.ok ? p.amount : reasons(p)))).toEqual([1000, 500, 500]);
    expect(await prisma.advancePeakDocumentLink.count()).toBe(0); // a preview writes nothing
    const s = (await summariesFor(prisma, [await prisma.guideAdvance.findUniqueOrThrow({ where: { id: advance.id } })])).get(advance.id)!;
    expect(s).toMatchObject({ issued: 100_000, used: 50_000, returned: 50_000, outstanding: 0, status: "SETTLED", driftSatang: 0 });
  });
});
