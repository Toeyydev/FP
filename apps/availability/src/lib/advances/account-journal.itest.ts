import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The account journal of company advances, against a real database: every movement as its
// double entry; what would be posted and why not; and that looking at it changes nothing and
// sends nothing. Every guide, figure and document number below is invented — this repo is public.

const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
const fetchSpy = vi.hoisted(() => vi.fn(async () => { throw new Error("no network in this test"); }));
vi.stubGlobal("fetch", fetchSpy);

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide, workerMatchesEnv } from "@/test/db";
import { financialIdentity } from "@/lib/protected-expense-fields";
import { allocateReceipt, recordReceipt, settleFromExpenses, verifyReceipt } from "./service";
import { accountJournal, journalLines, type JournalEntry } from "./account-journal";
import { linkExistingPeakDocument, previewLink, type PeakDocument } from "./peak-link";
import { syncAdvanceBatch } from "./peak-sync";
import { GET as JOURNAL } from "@/app/api/advances/journal/route";

const CONFIG = {
  advanceAccountCode: "111100", advanceAccountSubId: "sub-advance",
  bankName: "Company account", bankAccountCode: "111300", bankAccountSubId: "sub-bank",
  journalTypeIds: { ADVANCE: "5", RETURN: "5", EXPENSE: "5" }, expenseAccounts: {},
};
const G = "G-931", DATE = "2099-11-06", JOBNO = "FOLK-TEST-JRN-01";
const COST = "510104"; // what the migrations seed for entrance, transport and meal
let admin = { actorId: "", actorRole: "ADMIN" };

async function seedJob(rows: object[], over: { bankAccount?: string | null; allowed?: string[]; amount?: number; peakContact?: boolean } = {}) {
  if (over.peakContact !== false) await prisma.user.updateMany({ where: { guideId: G }, data: { peakContactId: "contact-example" } });
  const sheet = await prisma.jobSheet.create({ data: {
    ref: JOBNO, guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", approvalStatus: "APPROVED",
    bookings: [], guideFee: { price: 1000, time: 1, whtPct: 3 },
    expenses: rows.map((r) => ({ paidBy: "advance", paidBySource: "operator", ...r })) as Prisma.InputJsonValue,
  } });
  const amount = over.amount ?? 1000;
  const advance = await prisma.guideAdvance.create({ data: {
    guideId: G, date: DATE, slotIdx: 0, amount, paidAt: new Date("2099-11-05T03:00:00Z"), method: "bank", txRef: "TX-JRN-1",
    advanceNo: "FOLK-ADV-209911-001", advanceDate: "2099-11-05", amountSatang: amount * 100, accountingPeriod: "2099-11",
    jobNo: JOBNO, slipUrl: "https://example.test/slip", allowedCategories: over.allowed ?? ["entrance", "meal"],
    bankAccount: over.bankAccount === undefined ? "sub-bank" : over.bankAccount,
  } });
  const linked = (sheet.expenses as unknown as Record<string, unknown>[]).map((r) => ({ ...r, advanceId: advance.id }));
  await prisma.jobSheet.update({ where: { id: sheet.id }, data: { expenses: linked as Prisma.InputJsonValue } });
  return { sheet, advance };
}
async function settle(advanceId: string, sheetId: string) {
  const sheet = await prisma.jobSheet.findUniqueOrThrow({ where: { id: sheetId } });
  const rows = sheet.expenses as unknown as Parameters<typeof financialIdentity>[0][];
  const lines = rows.map((r, index) => ({ index, identity: financialIdentity(r) }));
  const res = await settleFromExpenses(prisma, { advanceId, jobSheetId: sheetId, sheetVersion: sheet.updatedAt.toISOString(), lines, actor: admin });
  if (!res.ok) throw new Error(res.reasons.join("; "));
  return res.entryId;
}
async function verifiedReturn(amount: number, advanceId: string, over: { verify?: boolean; bankAccount?: string } = {}) {
  const r = await recordReceipt(prisma, { guideId: G, receivedDate: "2099-11-07", amount, byGuide: true, today: "2099-12-31", bankRef: null, note: null, advanceId, jobSheetId: null, actor: { actorId: null, actorRole: "GUIDE" } });
  if (!r.ok) throw new Error(r.reasons.join(";"));
  if (over.verify === false) return r.receipt.id;
  const v = await verifyReceipt(prisma, { receiptId: r.receipt.id, bankRef: "BANK-JRN-1", bankAccount: over.bankAccount ?? "sub-bank", actor: admin });
  if (!v.ok) throw new Error(v.reasons.join(";"));
  await allocateReceipt(prisma, { receiptId: r.receipt.id, allocations: [{ advanceId, amount }], requestKey: "alloc-jrn-1", actor: admin });
  return r.receipt.id;
}
/** Everything the journal reads, so "looking changed nothing" can be said of all of it. */
const footprint = async () => JSON.stringify({
  outbox: await prisma.advancePeakSync.findMany({ orderBy: { id: "asc" } }),
  links: await prisma.advancePeakDocumentLink.findMany({ orderBy: { id: "asc" } }),
  advances: await prisma.guideAdvance.findMany({ orderBy: { id: "asc" } }),
  receipts: await prisma.guideAdvanceReceipt.findMany({ orderBy: { id: "asc" } }),
  entries: await prisma.guideAdvanceEntry.findMany({ orderBy: { id: "asc" } }),
  audits: await prisma.auditLog.count(),
});
const pick = (j: { entries: JournalEntry[] }, kind: string) => j.entries.find((e) => e.kind === kind)!;
const drcr = (e: JournalEntry) => e.lines.map((l) => [l.role, l.accountCode, l.debit, l.credit]);

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.stubEnv("PEAK_ADVANCE_CONFIG", JSON.stringify(CONFIG));
  vi.stubEnv("ADVANCE_WRITES_FROZEN", "0");
  vi.stubEnv("ADVANCE_EXISTING_PEAK_LINKS_ENABLED", "0");
  vi.stubEnv("PEAK_ADVANCE_AUTO_SYNC", "0");
  fetchSpy.mockClear();
  await resetDatabase();
  await workerMatchesEnv(); // both services hold the same switches (lib/peak-switches)
  await seedGuide(G);
  const a = await prisma.user.create({ data: { email: "admin-jrn@example.test", displayName: "Admin Example", role: "ADMIN", state: "ACTIVE" } });
  admin = { actorId: a.id, actorRole: "ADMIN" };
  authMock.auth.mockResolvedValue({ user: { id: a.id, role: "ADMIN" } });
});
afterEach(() => vi.unstubAllEnvs());

describe("the double entry of each movement", () => {
  it("issue 1,000 · tickets 500 + lunch 200 settled · 300 returned: three balanced entries, and the advance account nets to zero", async () => {
    const { sheet, advance } = await seedJob([
      { description: "Temple ticket", price: 250, pax: 2, expenseType: "entrance" },
      { description: "Lunch", price: 100, pax: 2, expenseType: "meal" },
    ]);
    await settle(advance.id, sheet.id);
    await verifiedReturn(300, advance.id);

    const j = await accountJournal(prisma);
    expect(j.configured).toBe(true);
    expect(j.entries.map((e) => [e.kind, e.date, e.amount, e.balanced])).toEqual([["ADVANCE", "2099-11-05", 1000, true], ["EXPENSE", DATE, 700, true], ["RETURN", "2099-11-07", 300, true]]);
    expect(drcr(pick(j, "ADVANCE"))).toEqual([["ADVANCE", "111100", 1000, 0], ["BANK", "111300", 0, 1000]]);
    // One debit per settled line, as the sender posts them — here both on the same mapped cost account.
    expect(drcr(pick(j, "EXPENSE"))).toEqual([["COST", COST, 500, 0], ["COST", COST, 200, 0], ["ADVANCE", "111100", 0, 700]]);
    expect(drcr(pick(j, "RETURN"))).toEqual([["BANK", "111300", 300, 0], ["ADVANCE", "111100", 0, 300]]);
    expect(pick(j, "ADVANCE")).toMatchObject({ reference: "FOLK-ADV-209911-001", guideId: G, jobNo: JOBNO });
    expect(pick(j, "EXPENSE").lines.map((l) => l.label)).toEqual(["Entrance tickets — Temple ticket", "Meals — Lunch", "Guide advances"]);
    expect(j.totals.advanceAccountNet).toBe(0);
  });

  it("on one day the entries read in the order the money moved: handed over, spent, returned", async () => {
    const { sheet, advance } = await seedJob([{ description: "Temple ticket", price: 250, pax: 2, expenseType: "entrance" }]);
    await settle(advance.id, sheet.id);
    const receiptId = await verifiedReturn(500, advance.id);
    await prisma.guideAdvance.update({ where: { id: advance.id }, data: { advanceDate: DATE } });
    await prisma.guideAdvanceReceipt.update({ where: { id: receiptId }, data: { receivedDate: DATE } });
    expect((await accountJournal(prisma)).entries.map((e) => [e.date, e.kind])).toEqual([[DATE, "ADVANCE"], [DATE, "EXPENSE"], [DATE, "RETURN"]]);
  });

  it("an advance not yet used is money the guide still holds, by the books", async () => {
    await seedJob([{ description: "Temple ticket", price: 250, pax: 2, expenseType: "entrance" }]);
    expect((await accountJournal(prisma)).totals.advanceAccountNet).toBe(1000);
  });

  it("the lines are a pure function of the movement and the configured accounts", () => {
    const cfg = { ...CONFIG, expenseAccounts: { entrance: "590005", meal: "590004" } };
    expect(journalLines("EXPENSE", 70000, cfg, [{ category: "entrance", amountSatang: 30000 }, { category: "entrance", amountSatang: 20000 }, { category: "meal", amountSatang: 20000 }]).map((l) => [l.accountCode, l.debit, l.credit]))
      .toEqual([["590005", 300, 0], ["590005", 200, 0], ["590004", 200, 0], ["111100", 0, 700]]); // one debit per line, as posted
    // No configuration: the entry is still shown, with no account to name.
    expect(journalLines("ADVANCE", 100000, null).map((l) => l.accountCode)).toEqual([null, null]);
  });
});

describe("where each entry stands, and why", () => {
  it("everything in order: the three entries are READY, in the order they must be posted", async () => {
    const { sheet, advance } = await seedJob([{ description: "Temple ticket", price: 250, pax: 2, expenseType: "entrance" }]);
    await settle(advance.id, sheet.id);
    const j = await accountJournal(prisma);
    expect(pick(j, "ADVANCE")).toMatchObject({ state: "READY", reason: null, documentNo: null });
    // The settlement waits for its advance to be in PEAK first — the sender's own rule, said here.
    expect(pick(j, "EXPENSE")).toMatchObject({ state: "BLOCKED", reason: expect.stringMatching(/Sync or reconcile the original advance first/) });
    expect(j.totals.byState).toMatchObject({ READY: { count: 1, amount: 1000 }, BLOCKED: { count: 1, amount: 500 } });
  });

  it("says what is missing: no PEAK contact for the guide, no bank account on the advance, an unconfirmed return", async () => {
    const { advance } = await seedJob([{ description: "Temple ticket", price: 250, pax: 2, expenseType: "entrance" }], { bankAccount: null, peakContact: false });
    await verifiedReturn(200, advance.id, { verify: false });
    const j = await accountJournal(prisma);
    expect(pick(j, "ADVANCE")).toMatchObject({ state: "BLOCKED", reason: expect.stringMatching(/Confirm the advance bank account before syncing/) });
    expect(pick(j, "RETURN")).toMatchObject({ state: "BLOCKED", reason: expect.stringMatching(/Confirm the bank return before syncing/) });
    // A return nobody has confirmed against the bank is listed, but is not yet money in the books.
    expect(j.totals.advanceAccountNet).toBe(1000);

    await prisma.guideAdvance.update({ where: { id: advance.id }, data: { bankAccount: "sub-bank" } });
    expect(pick(await accountJournal(prisma), "ADVANCE")).toMatchObject({ state: "BLOCKED", reason: expect.stringMatching(/guide's PEAK contact/) });
  });

  it("with no advance accounts configured every unposted entry is BLOCKED and says so — and is still listed", async () => {
    await seedJob([{ description: "Temple ticket", price: 250, pax: 2, expenseType: "entrance" }]);
    vi.stubEnv("PEAK_ADVANCE_CONFIG", "");
    const j = await accountJournal(prisma);
    expect(j.configured).toBe(false);
    expect(pick(j, "ADVANCE")).toMatchObject({ state: "BLOCKED", reason: "The advance accounts are not configured for PEAK", amount: 1000 });
    expect(drcr(pick(j, "ADVANCE"))).toEqual([["ADVANCE", null, 1000, 0], ["BANK", null, 0, 1000]]);
  });

  it("an entry linked to an existing PEAK document shows that document, and whether it was fully checked", async () => {
    const { advance } = await seedJob([{ description: "Temple ticket", price: 250, pax: 2, expenseType: "entrance" }]);
    vi.stubEnv("ADVANCE_EXISTING_PEAK_LINKS_ENABLED", "1");
    await workerMatchesEnv(); // both services hold the same switches (lib/peak-switches)
    const doc: PeakDocument = { code: "JV-JRN-0001", documentType: "DAILY_JOURNAL", contactId: null, entries: [{ accountCode: "111100", accountSubId: "sub-advance", debit: 1000, credit: 0 }, { accountCode: "111300", accountSubId: "sub-bank", debit: 0, credit: 1000 }] };
    const look = async () => ({ ok: true as const, document: doc });
    const req = { kind: "ADVANCE" as const, advanceId: advance.id, documentNo: "JV-JRN-0001", documentType: "DAILY_JOURNAL" as const, note: "the transfer on the statement (example)", requestKey: "rk-jrn-1", actor: admin };
    const shown = await previewLink(prisma, req, look);
    const linked = await linkExistingPeakDocument(prisma, { ...req, acknowledgedWarnings: shown.ok ? shown.warnings : [] }, look);
    expect(linked.ok).toBe(true);
    expect(pick(await accountJournal(prisma), "ADVANCE")).toMatchObject({ state: "LINKED", documentNo: "JV-JRN-0001", verified: false, reason: null });
  });

  it("a settlement closed as 'booked in guide payment' is shown as that, with its document — and still leaves the advance account", async () => {
    const { sheet, advance } = await seedJob([{ description: "Temple ticket", price: 250, pax: 2, expenseType: "entrance" }]);
    const entryId = await settle(advance.id, sheet.id);
    await prisma.advancePeakSync.upsert({ where: { id: `EXPENSE:${entryId}` }, create: { id: `EXPENSE:${entryId}`, kind: "EXPENSE", sourceId: entryId, status: "CANCELLED", documentNo: "EXP-TEST-0900", error: "BOOKED_IN_GUIDE_PAYMENT: expense already booked in EXP-TEST-0900 (example)" }, update: { status: "CANCELLED", documentNo: "EXP-TEST-0900", error: "BOOKED_IN_GUIDE_PAYMENT: expense already booked in EXP-TEST-0900 (example)" } });
    const j = await accountJournal(prisma);
    expect(pick(j, "EXPENSE")).toMatchObject({ state: "BOOKED_IN_GUIDE_PAYMENT", documentNo: "EXP-TEST-0900" });
    expect(j.totals.advanceAccountNet).toBe(500); // 1,000 issued − 500 of tickets
  });

  it("a reversed advance and a rejected return are not in the journal", async () => {
    const { advance } = await seedJob([{ description: "Temple ticket", price: 250, pax: 2, expenseType: "entrance" }]);
    const receiptId = await verifiedReturn(200, advance.id, { verify: false });
    await prisma.guideAdvanceReceipt.update({ where: { id: receiptId }, data: { status: "REJECTED", rejectedReason: "not on the statement (example)" } });
    expect((await accountJournal(prisma)).entries.map((e) => e.kind)).toEqual(["ADVANCE"]);
    await prisma.guideAdvance.update({ where: { id: advance.id }, data: { reversedAt: new Date(), reversalReason: "never sent (example)" } });
    expect((await accountJournal(prisma)).entries).toEqual([]);
  });
});

describe("what is shown as READY is what the sender sends", () => {
  it("the journal the worker posts for a READY advance has the same accounts, sides and amounts — and the entry then reads POSTED", async () => {
    const { advance } = await seedJob([{ description: "Temple ticket", price: 250, pax: 2, expenseType: "entrance" }]);
    await prisma.advancePeakSync.upsert({ where: { id: `ADVANCE:${advance.id}` }, create: { id: `ADVANCE:${advance.id}`, kind: "ADVANCE", sourceId: advance.id, nextAttemptAt: new Date(0) }, update: { nextAttemptAt: new Date(0) } }); // due now, whatever the database's clock zone
    const shown = pick(await accountJournal(prisma), "ADVANCE");
    expect(shown.state).toBe("READY");

    // The real sender, with PEAK replaced by a recorder: nothing leaves this process.
    vi.stubEnv("PEAK_ADVANCE_AUTO_SYNC", "1");
    await workerMatchesEnv(); // both services hold the same switches (lib/peak-switches)
    const sent: { reference: string; journalEntries: { accountCode: string; debit: string; credit: string }[] }[] = [];
    const posted = await syncAdvanceBatch(prisma, (async (payload: (typeof sent)[number]) => { sent.push(payload); return { ok: true, id: "peak-jrn-1", code: "JV-TEST-0001" }; }) as never);
    expect(posted).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].reference).toBe(shown.reference);
    expect(sent[0].journalEntries.map((l) => [l.accountCode, Number(l.debit), Number(l.credit)])).toEqual(shown.lines.map((l) => [l.accountCode, l.debit, l.credit]));

    expect(pick(await accountJournal(prisma), "ADVANCE")).toMatchObject({ state: "POSTED", documentNo: "JV-TEST-0001" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("it is a read", () => {
  it("reading the journal changes no row — not the outbox, not an attempt count, not a payload — and sends nothing", async () => {
    const { sheet, advance } = await seedJob([{ description: "Temple ticket", price: 250, pax: 2, expenseType: "entrance" }]);
    await settle(advance.id, sheet.id);
    await verifiedReturn(300, advance.id);
    const before = await footprint();
    await accountJournal(prisma);
    await accountJournal(prisma);
    expect(await footprint()).toBe(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the route answers finance roles, refuses a guide, and writes nothing", async () => {
    await seedJob([{ description: "Temple ticket", price: 250, pax: 2, expenseType: "entrance" }]);
    const before = await footprint();
    for (const role of ["ADMIN", "OPERATOR", "ACCOUNTANT"]) {
      authMock.auth.mockResolvedValue({ user: { id: admin.actorId, role } });
      const res = await JOURNAL();
      expect([role, res.status]).toEqual([role, 200]);
      const body = await res.json();
      expect(body.entries).toHaveLength(1);
      expect(body).toMatchObject({ configured: true, autoSync: false });
    }
    authMock.auth.mockResolvedValue({ user: { id: "g", role: "GUIDE", guideId: G } });
    expect((await JOURNAL()).status).toBe(403);
    authMock.auth.mockResolvedValue(null);
    expect((await JOURNAL()).status).toBe(403);
    expect(await footprint()).toBe(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("says when automatic posting is on", async () => {
    await seedJob([{ description: "Temple ticket", price: 250, pax: 2, expenseType: "entrance" }]);
    vi.stubEnv("PEAK_ADVANCE_AUTO_SYNC", "1");
    await workerMatchesEnv(); // both services hold the same switches (lib/peak-switches)
    expect((await accountJournal(prisma)).autoSync).toBe(true);
  });
});
