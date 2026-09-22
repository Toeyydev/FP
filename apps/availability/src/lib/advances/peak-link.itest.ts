import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Only the session is stubbed. Everything else — the switches, the triggers, the
// unique indexes — is the real thing against a real database.
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { linkExistingPeakDocument, type DocumentLookup, type PeakDocument } from "./peak-link";
import { syncAdvanceBatch } from "./peak-sync";
import { POST as createAdvance } from "@/app/api/advances/route";
import type { NextRequest } from "next/server";

// Linking runs against a real database because the things that can go wrong are
// database things: a trigger that queues a journal the moment a return is confirmed,
// a unique index that has to refuse a second use of one document number, and a
// transaction that must leave nothing behind when a later step fails.
//
// Every figure, guide and document number below is invented.

const CONFIG = {
  advanceAccountCode: "111100", advanceAccountSubId: "sub-advance",
  bankName: "Company account", bankAccountCode: "111300", bankAccountSubId: "sub-bank",
  journalTypeIds: { ADVANCE: "5", RETURN: "5", EXPENSE: "5" }, expenseAccounts: {},
};
const actor = { actorId: "u_admin", actorRole: "ADMIN" };
const GUIDE = "G-901";
const SHEET_DATE = "2026-11-04";

const journalFor = (kind: "ADVANCE" | "RETURN" | "EXPENSE", baht: number, code: string): PeakDocument => {
  const advanceLine = { accountCode: "111100", accountSubId: "sub-advance", debit: kind === "ADVANCE" ? baht : 0, credit: kind === "ADVANCE" ? 0 : baht };
  const bankLine = { accountCode: "111300", accountSubId: "sub-bank", debit: kind === "RETURN" ? baht : 0, credit: kind === "RETURN" ? 0 : baht };
  const costLine = { accountCode: "510104", debit: baht, credit: 0 };
  return { code, documentType: "DAILY_JOURNAL", contactId: null, entries: kind === "EXPENSE" ? [costLine, advanceLine] : [advanceLine, bankLine] };
};
/** A lookup that answers for one document, so no test needs a PEAK connection. */
const lookupOf = (doc: PeakDocument): DocumentLookup => async (documentNo) =>
  documentNo === doc.code ? { ok: true, document: { ...doc, code: documentNo } } : { ok: false, notFound: true, desc: "not found" };

async function fixture(over: { expenses?: Prisma.InputJsonValue } = {}) {
  await seedGuide(GUIDE);
  const sheet = await prisma.jobSheet.create({
    data: {
      guideId: GUIDE, date: SHEET_DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", ref: "FOLK-TEST-0001",
      approvalStatus: "APPROVED", bookings: [], guideFee: { price: 1000, time: 1, whtPct: 3 },
      expenses: over.expenses ?? [{ description: "Temple ticket", price: 300, pax: 2, expenseType: "entrance", paidBy: "advance" }],
    },
  });
  const advance = await prisma.guideAdvance.create({
    data: {
      guideId: GUIDE, date: SHEET_DATE, slotIdx: 0, amount: 900, paidAt: new Date(), method: "bank", txRef: "TX-1",
      advanceNo: "FOLK-ADV-202611-001", advanceDate: SHEET_DATE, amountSatang: 90_000, accountingPeriod: "2026-11",
      jobNo: sheet.ref, slipUrl: "https://example.test/slip",
    },
  });
  const receipt = await prisma.guideAdvanceReceipt.create({
    data: { receiptNo: "FOLK-ADR-202611-001", guideId: GUIDE, receivedDate: SHEET_DATE, amountSatang: 30_000, status: "CLAIMED", method: "bank" },
  });
  return { sheet, advance, receipt };
}

const outbox = (kind: string, sourceId: string) => prisma.advancePeakSync.findUnique({ where: { id: `${kind}:${sourceId}` } });

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.stubEnv("PEAK_ADVANCE_CONFIG", JSON.stringify(CONFIG));
  vi.stubEnv("ADVANCE_WRITES_FROZEN", "0");
  vi.stubEnv("ADVANCE_EXISTING_PEAK_LINKS_ENABLED", "1");
  vi.stubEnv("PEAK_ADVANCE_AUTO_SYNC", "0");
  authMock.auth.mockResolvedValue({ user: { id: "u_admin", role: "ADMIN" } });
  await resetDatabase();
});
afterEach(() => vi.unstubAllEnvs());

describe("recording an advance that PEAK already carries", () => {
  it("records the document, and closes the queue against it", async () => {
    const { advance } = await fixture();
    const result = await linkExistingPeakDocument(prisma, {
      kind: "ADVANCE", advanceId: advance.id, documentNo: "JV-000001", documentType: "DAILY_JOURNAL",
      note: "matched the transfer on the company statement", acknowledgeWarnings: true, requestKey: "req-advance-1", actor,
    }, lookupOf(journalFor("ADVANCE", 900, "JV-000001")));

    expect(result).toMatchObject({ ok: true, replayed: false, documentNo: "JV-000001" });
    expect(await prisma.guideAdvance.findUnique({ where: { id: advance.id } })).toMatchObject({ peakDocumentNo: "JV-000001", peakRef: "JV-000001" });
    expect(await outbox("ADVANCE", advance.id)).toMatchObject({ status: "POSTED", documentNo: "JV-000001" });
    const link = await prisma.advancePeakDocumentLink.findUnique({ where: { kind_sourceId: { kind: "ADVANCE", sourceId: advance.id } } });
    expect(link).toMatchObject({ source: "EXISTING_PEAK_DOCUMENT", documentType: "DAILY_JOURNAL", linkedById: "u_admin" });
    expect(link!.note.length).toBeGreaterThan(4);
  });

  it("pressing it again changes nothing", async () => {
    const { advance } = await fixture();
    const req = {
      kind: "ADVANCE" as const, advanceId: advance.id, documentNo: "JV-000001", documentType: "DAILY_JOURNAL" as const,
      note: "matched the transfer on the company statement", acknowledgeWarnings: true, requestKey: "req-advance-1", actor,
    };
    const lookup = lookupOf(journalFor("ADVANCE", 900, "JV-000001"));
    await linkExistingPeakDocument(prisma, req, lookup);
    const again = await linkExistingPeakDocument(prisma, { ...req, requestKey: "req-advance-2" }, lookup);

    expect(again).toMatchObject({ ok: true, replayed: true });
    expect(await prisma.advancePeakDocumentLink.count()).toBe(1);
    expect(await prisma.advancePeakSync.count()).toBe(1);
    expect(await prisma.guideAdvanceEntry.count()).toBe(0);
  });

  it("refuses a document number that is already recorded elsewhere", async () => {
    const { advance, receipt } = await fixture();
    const lookup: DocumentLookup = async (no) => ({ ok: true, document: { ...journalFor("ADVANCE", 900, no), code: no } });
    await linkExistingPeakDocument(prisma, {
      kind: "ADVANCE", advanceId: advance.id, documentNo: "JV-000001", documentType: "DAILY_JOURNAL",
      note: "the transfer out", acknowledgeWarnings: true, requestKey: "req-1", actor,
    }, lookup);

    const second = await linkExistingPeakDocument(prisma, {
      kind: "RETURN", receiptId: receipt.id, documentNo: "JV-000001", documentType: "DAILY_JOURNAL",
      note: "same number by mistake", acknowledgeWarnings: true, requestKey: "req-2", actor,
      bankRef: "STMT-77", allocations: [{ advanceId: advance.id, amount: 300 }],
    }, lookup);

    expect(second).toMatchObject({ ok: false, status: 409 });
    expect((second as { reasons: string[] }).reasons.join(" ")).toContain("already recorded");
    expect(await prisma.guideAdvanceReceipt.findUnique({ where: { id: receipt.id } })).toMatchObject({ status: "CLAIMED" });
  });

  it("refuses a document whose figures do not match", async () => {
    const { advance } = await fixture();
    const result = await linkExistingPeakDocument(prisma, {
      kind: "ADVANCE", advanceId: advance.id, documentNo: "JV-000002", documentType: "DAILY_JOURNAL",
      note: "hoping nobody checks", acknowledgeWarnings: true, requestKey: "req-3", actor,
    }, lookupOf(journalFor("ADVANCE", 400, "JV-000002")));

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(await prisma.advancePeakDocumentLink.count()).toBe(0);
    expect(await prisma.guideAdvance.findUnique({ where: { id: advance.id } })).toMatchObject({ peakDocumentNo: null });
  });
});

describe("recording a return that PEAK already carries", () => {
  it("confirms it, puts it against the advance and records the document — in one step", async () => {
    const { advance, receipt } = await fixture();
    const result = await linkExistingPeakDocument(prisma, {
      kind: "RETURN", receiptId: receipt.id, documentNo: "JV-000003", documentType: "DAILY_JOURNAL",
      note: "the money is on the statement, and this journal is it", acknowledgeWarnings: true, requestKey: "req-return-1", actor,
      bankRef: "STMT-42", bankAccount: "sub-bank", allocations: [{ advanceId: advance.id, amount: 300 }],
    }, lookupOf(journalFor("RETURN", 300, "JV-000003")));

    expect(result).toMatchObject({ ok: true, documentNo: "JV-000003" });
    expect(await prisma.guideAdvanceReceipt.findUnique({ where: { id: receipt.id } })).toMatchObject({
      status: "VERIFIED", bankRef: "STMT-42", allocatedSatang: 30_000, peakDocumentNo: "JV-000003",
    });
    expect(await prisma.guideAdvance.findUnique({ where: { id: advance.id } })).toMatchObject({ settledSatang: 30_000 });
    const entries = await prisma.guideAdvanceEntry.findMany();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "RETURN_ALLOCATION", amountSatang: 30_000, peakDocumentNo: "JV-000003" });
    // The confirmation fires a trigger that queues a journal. It must already be closed.
    expect(await outbox("RETURN", receipt.id)).toMatchObject({ status: "POSTED", documentNo: "JV-000003" });
  });

  it("leaves nothing behind when a later step fails", async () => {
    const { advance, receipt } = await fixture();
    // FolkOPS may already have sent something for this return and not know how it
    // ended. Linking must not paper over that — and must not half-confirm the return.
    await prisma.advancePeakSync.create({ data: { id: `RETURN:${receipt.id}`, kind: "RETURN", sourceId: receipt.id, status: "UNCERTAIN", error: "sender interrupted" } });

    const result = await linkExistingPeakDocument(prisma, {
      kind: "RETURN", receiptId: receipt.id, documentNo: "JV-000004", documentType: "DAILY_JOURNAL",
      note: "trying to link over an uncertain send", acknowledgeWarnings: true, requestKey: "req-return-2", actor,
      bankRef: "STMT-43", allocations: [{ advanceId: advance.id, amount: 300 }],
    }, lookupOf(journalFor("RETURN", 300, "JV-000004")));

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(await prisma.guideAdvanceReceipt.findUnique({ where: { id: receipt.id } })).toMatchObject({ status: "CLAIMED", allocatedSatang: 0, peakDocumentNo: null });
    expect(await prisma.guideAdvanceEntry.count()).toBe(0);
    expect(await prisma.advancePeakDocumentLink.count()).toBe(0);
    expect(await outbox("RETURN", receipt.id)).toMatchObject({ status: "UNCERTAIN" });
  });
});

describe("recording ticket costs that PEAK already carries", () => {
  it("settles the advance against the existing document without creating a journal", async () => {
    const { advance, sheet } = await fixture();
    const result = await linkExistingPeakDocument(prisma, {
      kind: "EXPENSE", advanceId: advance.id, jobSheetId: sheet.id, amount: 600, documentNo: "PV-000009", documentType: "DAILY_JOURNAL",
      note: "the ticket line inside the payment document for this job", acknowledgeWarnings: true, requestKey: "req-expense-1", actor,
    }, lookupOf(journalFor("EXPENSE", 600, "PV-000009")));

    expect(result).toMatchObject({ ok: true, documentNo: "PV-000009" });
    const entries = await prisma.guideAdvanceEntry.findMany();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "EXPENSE_SETTLEMENT", amountSatang: 60_000, jobNo: sheet.ref, peakDocumentNo: "PV-000009" });
    expect(await prisma.guideAdvance.findUnique({ where: { id: advance.id } })).toMatchObject({ settledSatang: 60_000 });
    expect(await outbox("EXPENSE", entries[0].id)).toMatchObject({ status: "POSTED", documentNo: "PV-000009" });
  });

  it("refuses to clear a meal through a ticket advance", async () => {
    const { advance, sheet } = await fixture({ expenses: [{ description: "Lunch", price: 600, pax: 1, expenseType: "meal", paidBy: "advance" }] });
    const result = await linkExistingPeakDocument(prisma, {
      kind: "EXPENSE", advanceId: advance.id, jobSheetId: sheet.id, amount: 600, documentNo: "PV-000010", documentType: "DAILY_JOURNAL",
      note: "food bought with the ticket advance", acknowledgeWarnings: true, requestKey: "req-expense-2", actor,
    }, lookupOf(journalFor("EXPENSE", 600, "PV-000010")));

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect((result as { reasons: string[] }).reasons.join(" ")).toContain("customer tickets only");
    expect(await prisma.guideAdvanceEntry.count()).toBe(0);
    expect(await prisma.advancePeakDocumentLink.count()).toBe(0);
  });
});

describe("the sender", () => {
  it("does not run at all while reconciliation is open", async () => {
    const { advance } = await fixture();
    await prisma.advancePeakSync.update({ where: { id: `ADVANCE:${advance.id}` }, data: { status: "PENDING" } });
    vi.stubEnv("PEAK_ADVANCE_AUTO_SYNC", "1"); // even with the sender switched on
    const post = vi.fn();

    expect(await syncAdvanceBatch(prisma, post)).toBe(0);
    expect(post).not.toHaveBeenCalled();
    expect(await outbox("ADVANCE", advance.id)).toMatchObject({ status: "PENDING" });
  });

  it("never sends an event that already has a PEAK document", async () => {
    const { advance } = await fixture();
    await linkExistingPeakDocument(prisma, {
      kind: "ADVANCE", advanceId: advance.id, documentNo: "JV-000005", documentType: "DAILY_JOURNAL",
      note: "already in the accountant's books", acknowledgeWarnings: true, requestKey: "req-4", actor,
    }, lookupOf(journalFor("ADVANCE", 900, "JV-000005")));
    // Put the queue back to PENDING, the worst case: a row that looks unsent.
    await prisma.advancePeakSync.update({ where: { id: `ADVANCE:${advance.id}` }, data: { status: "PENDING", documentNo: null } });

    // Reconciliation is over and the sender has been turned on: the state in which
    // a forgotten PENDING row would otherwise produce a second document.
    vi.stubEnv("ADVANCE_EXISTING_PEAK_LINKS_ENABLED", "0");
    vi.stubEnv("PEAK_ADVANCE_AUTO_SYNC", "1");
    const post = vi.fn();
    const sent = await syncAdvanceBatch(prisma, post);

    expect(post).not.toHaveBeenCalled();
    expect(sent).toBe(0);
    expect(await outbox("ADVANCE", advance.id)).toMatchObject({ status: "POSTED", documentNo: "JV-000005" });
  });
});

describe("the reconciliation switch", () => {
  const linkTheAdvance = (advanceId: string, over: Record<string, unknown> = {}) => linkExistingPeakDocument(prisma, {
    kind: "ADVANCE", advanceId, documentNo: "JV-000100", documentType: "DAILY_JOURNAL",
    note: "the transfer, already in the accountant's books", acknowledgeWarnings: true, requestKey: "req-mode-1", actor, ...over,
  } as Parameters<typeof linkExistingPeakDocument>[1], lookupOf(journalFor("ADVANCE", 900, "JV-000100")));

  it("records an existing document while ordinary writes are frozen", async () => {
    const { advance } = await fixture();
    vi.stubEnv("ADVANCE_WRITES_FROZEN", "1");

    expect(await linkTheAdvance(advance.id)).toMatchObject({ ok: true, documentNo: "JV-000100" });
    expect(await prisma.advancePeakDocumentLink.count()).toBe(1);
  });

  it("refuses when the reconciliation switch is off", async () => {
    const { advance } = await fixture();
    vi.stubEnv("ADVANCE_EXISTING_PEAK_LINKS_ENABLED", "0");

    const result = await linkTheAdvance(advance.id);
    expect(result).toMatchObject({ ok: false, status: 503 });
    expect((result as { reasons: string[] }).reasons.join(" ")).toContain("ADVANCE_EXISTING_PEAK_LINKS_ENABLED");
    expect(await prisma.advancePeakDocumentLink.count()).toBe(0);
  });

  it("leaves the ordinary write paths frozen", async () => {
    // The opening is for existing documents only: recording a NEW advance is still
    // refused, by the route that has always refused it.
    vi.stubEnv("ADVANCE_WRITES_FROZEN", "1");
    const res = await createAdvance(new Request("http://localhost/api/advances", { method: "POST", body: new FormData() }) as unknown as NextRequest);
    expect(res.status).toBe(503);
    expect(await prisma.guideAdvance.count()).toBe(0);
  });

  it("refuses while the automatic sender is on", async () => {
    const { advance } = await fixture();
    vi.stubEnv("PEAK_ADVANCE_AUTO_SYNC", "1");

    const result = await linkTheAdvance(advance.id);
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect((result as { reasons: string[] }).reasons.join(" ")).toContain("PEAK_ADVANCE_AUTO_SYNC");
    expect(await prisma.advancePeakDocumentLink.count()).toBe(0);
  });

  it("refuses while the sender has this movement in flight", async () => {
    const { advance } = await fixture();
    // SENDING is this codebase's name for a send in progress; the guard also covers
    // a PROCESSING row, should the outbox ever use that word.
    // The trigger queued this row the moment the advance was created; put it into
    // the state a half-finished send leaves behind.
    await prisma.advancePeakSync.update({ where: { id: `ADVANCE:${advance.id}` }, data: { status: "SENDING" } });

    const result = await linkTheAdvance(advance.id);
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect((result as { reasons: string[] }).reasons.join(" ")).toMatch(/middle of sending/i);
    expect(await prisma.advancePeakDocumentLink.count()).toBe(0);
    expect(await outbox("ADVANCE", advance.id)).toMatchObject({ status: "SENDING" });
  });

  it("treats the same number typed differently as the same document", async () => {
    const { advance, receipt } = await fixture();
    expect(await linkTheAdvance(advance.id, { documentNo: "JV-000100" })).toMatchObject({ ok: true });

    // Same movement, typed loosely: the first answer, and nothing written twice.
    const again = await linkTheAdvance(advance.id, { documentNo: "  jv-000100 ", requestKey: "req-mode-2" });
    expect(again).toMatchObject({ ok: true, replayed: true, documentNo: "JV-000100" });
    expect(await prisma.advancePeakDocumentLink.count()).toBe(1);

    // A DIFFERENT movement, same number typed loosely: refused by the unique key.
    const elsewhere = await linkExistingPeakDocument(prisma, {
      kind: "RETURN", receiptId: receipt.id, documentNo: " jv-000100 ", documentType: "DAILY_JOURNAL",
      note: "the same number, typed in lower case", acknowledgeWarnings: true, requestKey: "req-mode-3", actor,
      bankRef: "STMT-90", allocations: [{ advanceId: advance.id, amount: 300 }],
    }, lookupOf(journalFor("RETURN", 300, "JV-000100")));
    expect(elsewhere).toMatchObject({ ok: false, status: 409 });
    expect(await prisma.advancePeakDocumentLink.count()).toBe(1);
    expect(await prisma.guideAdvanceReceipt.findUnique({ where: { id: receipt.id } })).toMatchObject({ status: "CLAIMED" });
  });
});
