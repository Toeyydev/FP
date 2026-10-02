import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// "Booked in guide payment", against a real database: closing a settlement's pending PEAK
// outbox item when the same job's guide-payment document already carries the cost. Nothing is
// posted, no PEAK link is created, the reversal is blocked afterwards, and a second claim on
// the same cost is refused. Every guide, figure and document number is invented — this
// repository is public.

const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
const fetchSpy = vi.hoisted(() => vi.fn(async () => { throw new Error("no network in this test"); }));
vi.stubGlobal("fetch", fetchSpy);

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { financialIdentity } from "@/lib/protected-expense-fields";
import { markBookedInGuidePayment } from "./booked-in-guide-payment";
import { linkExistingPeakDocument } from "./peak-link";
import { syncAdvanceBatch } from "./peak-sync";
import { reverseEntry } from "./service";
import { POST as BOOKED } from "@/app/api/advances/entries/[id]/booked-in-guide-payment/route";
import type { Expense } from "@/lib/jobsheet";

const G = "G-942", OTHER_GUIDE = "G-943";
const DATE = "2099-03-05", OTHER_DATE = "2099-03-03";
const EXP = "EXP-20990300077", PV = "PV-209903011";
const actor = { actorId: "admin-booked-payment", actorRole: "ADMIN" };

beforeAll(() => { requireTestDatabase(); });
beforeEach(async () => {
  vi.clearAllMocks();
  delete process.env.ADVANCE_WRITES_FROZEN;
  await resetDatabase();
  await seedGuide(G);
  await prisma.user.create({ data: { id: actor.actorId, email: "admin-booked-payment@example.test", displayName: "Admin Example", role: "ADMIN", state: "ACTIVE" } });
  authMock.auth.mockResolvedValue({ user: { id: actor.actorId, role: "ADMIN" } });
});
afterEach(() => vi.unstubAllEnvs());

/** A ฿900 advance, a ฿300 museum ticket settled from it (explicit line), its outbox item, and the job's guide payment naming EXP. */
async function fixture(over: { paymentDate?: string; outboxStatus?: string } = {}) {
  const advance = await prisma.guideAdvance.create({ data: {
    guideId: G, date: DATE, slotIdx: 0, amount: 900, paidAt: new Date("2099-03-04T03:00:00Z"), method: "bank",
    advanceNo: "FOLK-ADV-209903-001", advanceDate: "2099-03-04", amountSatang: 90_000, settledSatang: 30_000, accountingPeriod: "2099-03", allowedCategories: ["entrance"],
  } });
  const row = { description: "Museum ticket (example)", expenseType: "entrance", price: 300, pax: 1, paidBy: "advance", paidBySource: "operator", advanceId: advance.id } as Expense & { advanceId: string };
  const sheet = await prisma.jobSheet.create({ data: {
    ref: "FOLK-TEST-BKD-01", guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", approvalStatus: "APPROVED",
    bookings: [{ name: "Guest Example Person", bookingNo: "GYGEXAMPLEBKD", bookedPax: 2 }] as never, expenses: [row] as never, guideFee: { price: 1000, time: 1, whtPct: 3 },
  } });
  const entry = await prisma.guideAdvanceEntry.create({ data: {
    advanceId: advance.id, type: "EXPENSE_SETTLEMENT", amountSatang: 30_000, effectiveDate: DATE, accountingPeriod: "2099-03",
    sourceType: "JOB_SHEET", sourceId: sheet.id, jobNo: sheet.ref, requestKey: "settle-booked-example", idempotencyKey: `settle-booked-example:${advance.id}`, provenance: "OPERATOR",
    snapshot: { lines: [{ index: 0, identity: financialIdentity(row), category: "entrance", amountSatang: 30_000, advanceId: advance.id, description: row.description }], total: 30_000 },
  } });
  await prisma.advancePeakSync.upsert({
    where: { id: `EXPENSE:${entry.id}` },
    create: { id: `EXPENSE:${entry.id}`, kind: "EXPENSE", sourceId: entry.id, status: over.outboxStatus ?? "PENDING" },
    update: { status: over.outboxStatus ?? "PENDING" },
  });
  await prisma.tourPayment.create({ data: { guideId: G, date: over.paymentDate ?? DATE, slotIdx: 0, tourId: "T-900", status: "PAID", peakRef: EXP } as never });
  return { sheet, advance, entry };
}
const mark = (entryId: string, over: Partial<{ expenseDocumentNo: string; paymentEvidenceNo: string }> = {}) => markBookedInGuidePayment(prisma, {
  entryId, expenseDocumentNo: EXP, paymentEvidenceNo: PV,
  reason: "Ticket is already booked and paid from the advance inside the guide payment (example)", actor, ...over,
});
const outboxOf = (entryId: string) => prisma.advancePeakSync.findUniqueOrThrow({ where: { id: `EXPENSE:${entryId}` } });
const reasons = (r: unknown) => ((r as { reasons?: string[] }).reasons ?? []).join(" ");

describe("Booked in guide payment", () => {
  it("closes only the outbox, creates no PEAK link, audits both references, blocks reversal and is idempotent", async () => {
    const { entry, advance, sheet } = await fixture();
    const before = JSON.stringify([await prisma.guideAdvance.findUniqueOrThrow({ where: { id: advance.id } }), await prisma.guideAdvanceEntry.findMany(), await prisma.jobSheet.findUniqueOrThrow({ where: { id: sheet.id } }), await prisma.tourPayment.findMany()]);
    expect(await mark(entry.id)).toMatchObject({ ok: true, replayed: false });
    expect(await outboxOf(entry.id)).toMatchObject({ status: "CANCELLED", documentNo: EXP, error: expect.stringContaining(PV) });
    expect(await prisma.advancePeakDocumentLink.count()).toBe(0);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "advance.settlement_booked_in_guide_payment" } });
    expect(audit).toMatchObject({ actorId: actor.actorId, actorRole: "ADMIN", entityId: entry.id });
    expect(audit.detail).toMatchObject({ expenseDocumentNo: EXP, paymentEvidenceNo: PV, amount: 300, result: "OUTBOX_CANCELLED_WITHOUT_POSTING" });
    expect(JSON.stringify(audit.detail)).not.toMatch(/Guest Example Person|GYGEXAMPLEBKD/);
    // The ledger, the advance, the job sheet and the guide payment are untouched.
    expect(JSON.stringify([await prisma.guideAdvance.findUniqueOrThrow({ where: { id: advance.id } }), await prisma.guideAdvanceEntry.findMany(), await prisma.jobSheet.findUniqueOrThrow({ where: { id: sheet.id } }), await prisma.tourPayment.findMany()])).toBe(before);
    const rev = await reverseEntry(prisma, { entryId: entry.id, reason: "trying to undo a booked expense (example)", actor });
    expect(rev).toMatchObject({ ok: false, status: 409 });
    expect(reasons(rev)).toMatch(/booked in the guide payment/);
    expect(await mark(entry.id)).toMatchObject({ ok: true, replayed: true });
    expect(await prisma.auditLog.count({ where: { action: "advance.settlement_booked_in_guide_payment" } })).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled(); // nothing called PEAK
  });

  it("a repeat with a different document or different payment evidence is refused, not echoed back", async () => {
    const { entry } = await fixture();
    await mark(entry.id);
    expect(await mark(entry.id, { paymentEvidenceNo: "PV-209903099" })).toMatchObject({ ok: false, status: 409 });
    expect(await mark(entry.id, { expenseDocumentNo: "EXP-20990300099" })).toMatchObject({ ok: false, status: 409 });
    expect(await outboxOf(entry.id)).toMatchObject({ documentNo: EXP, error: expect.stringContaining(PV) });
  });

  it("the sender, switched on later, never posts a booked settlement", async () => {
    const { entry } = await fixture();
    await mark(entry.id);
    vi.stubEnv("PEAK_ADVANCE_AUTO_SYNC", "1"); vi.stubEnv("ADVANCE_EXISTING_PEAK_LINKS_ENABLED", "0");
    vi.stubEnv("PEAK_ADVANCE_CONFIG", JSON.stringify({ advanceAccountCode: "111100", bankAccountCode: "111300", bankAccountSubId: "sub-bank", journalTypeIds: { ADVANCE: "5", RETURN: "5", EXPENSE: "5" }, expenseAccounts: {} }));
    const post = vi.fn();
    await syncAdvanceBatch(prisma, post);
    expect(post).not.toHaveBeenCalled();
    expect(await outboxOf(entry.id)).toMatchObject({ status: "CANCELLED", documentNo: EXP });
  });

  it("refuses a document that is the guide payment of another job only", async () => {
    const { entry } = await fixture({ paymentDate: OTHER_DATE });
    const r = await mark(entry.id);
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(reasons(r)).toMatch(/is not recorded as the guide-payment document for FOLK-TEST-BKD-01/);
    expect(await outboxOf(entry.id)).toMatchObject({ status: "PENDING", documentNo: null });
  });

  it("accepts one transfer's document that covers this job AND the same guide's other job", async () => {
    const { entry } = await fixture();
    await prisma.tourPayment.create({ data: { guideId: G, date: OTHER_DATE, slotIdx: 0, tourId: "T-900", status: "PAID", peakRef: EXP } as never });
    expect(await mark(entry.id)).toMatchObject({ ok: true, replayed: false });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "advance.settlement_booked_in_guide_payment" } });
    expect((audit.detail as { guidePaymentOwners: unknown[] }).guidePaymentOwners).toHaveLength(1); // only the owner that IS this job is cited as proof
  });

  it("refuses a document that another guide's payment, a supplemental payment or an advance event also names", async () => {
    const a = await fixture();
    await seedGuide(OTHER_GUIDE);
    await prisma.tourPayment.create({ data: { guideId: OTHER_GUIDE, date: DATE, slotIdx: 0, tourId: "T-900", status: "PAID", peakRef: EXP } as never });
    expect(reasons(await mark(a.entry.id))).toMatch(/has another recorded owner/);
    await prisma.tourPayment.deleteMany({ where: { guideId: OTHER_GUIDE } });
    await prisma.supplementalPayment.create({ data: { guideId: G, type: "BONUS", accountingCategory: "GUIDE_FEE", grossAmount: 200, whtPct: 0, whtSource: "ENTERED", wht: 0, netAmount: 200, reason: "example bonus", peakRef: EXP } as never });
    expect(reasons(await mark(a.entry.id))).toMatch(/has another recorded owner/);
    expect(await outboxOf(a.entry.id)).toMatchObject({ status: "PENDING" });
  });

  // Financial duplication safeguards: each of these already owns the document in FolkOPS's own
  // records, so closing the settlement against it would put one PEAK document behind two events.
  it("refuses a document that a payroll run also names", async () => {
    const { entry } = await fixture();
    await prisma.payrollStatus.create({ data: { guideId: G, period: "2099-03", peakRef: EXP } as never });
    const r = await mark(entry.id);
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(reasons(r)).toMatch(/has another recorded owner/);
    expect(await outboxOf(entry.id)).toMatchObject({ status: "PENDING", documentNo: null });
    expect(await prisma.auditLog.count({ where: { action: "advance.settlement_booked_in_guide_payment" } })).toBe(0);
  });

  it("refuses a document that is the job sheet's own PEAK document — even this job's sheet", async () => {
    const { entry, sheet } = await fixture();
    await prisma.jobSheet.update({ where: { id: sheet.id }, data: { peakDocumentNo: EXP } });
    const r = await mark(entry.id);
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(reasons(r)).toMatch(/has another recorded owner/);
    expect(await outboxOf(entry.id)).toMatchObject({ status: "PENDING", documentNo: null });
    expect(await prisma.auditLog.count({ where: { action: "advance.settlement_booked_in_guide_payment" } })).toBe(0);
  });

  it("refuses a document that an advance event already carries — even this settlement's own advance", async () => {
    const { entry, advance } = await fixture();
    await prisma.guideAdvance.update({ where: { id: advance.id }, data: { peakDocumentNo: EXP } });
    const r = await mark(entry.id);
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(reasons(r)).toMatch(/has another recorded owner/);
    expect(await outboxOf(entry.id)).toMatchObject({ status: "PENDING", documentNo: null });
    expect(await prisma.auditLog.count({ where: { action: "advance.settlement_booked_in_guide_payment" } })).toBe(0);
  });

  it("refuses an outbox item that is sending, uncertain or posted, and a reversed or unknown settlement", async () => {
    for (const status of ["SENDING", "UNCERTAIN", "POSTED"]) {
      await resetDatabase(); await seedGuide(G);
      const { entry } = await fixture({ outboxStatus: status });
      expect(await mark(entry.id)).toMatchObject({ ok: false, status: 409 });
      expect(await outboxOf(entry.id)).toMatchObject({ status });
    }
    expect(await mark("no-such-entry")).toMatchObject({ ok: false, status: 404 });
  });

  it("an item cancelled for another reason (a removed manual link keeps its old number) does NOT block reversal", async () => {
    const { entry } = await fixture();
    await prisma.advancePeakSync.update({ where: { id: `EXPENSE:${entry.id}` }, data: { status: "CANCELLED", documentNo: "JV-209903-OLD", error: "Manual PEAK link JV-209903-OLD removed: wrong journal (example). Link the right document — nothing will be sent automatically." } });
    expect(await reverseEntry(prisma, { entryId: entry.id, reason: "settled by mistake (example)", actor })).toMatchObject({ ok: true });
  });

  it("a booked settlement cannot afterwards be linked to another PEAK document", async () => {
    const { entry, advance, sheet } = await fixture();
    expect(await mark(entry.id)).toMatchObject({ ok: true });
    vi.stubEnv("ADVANCE_EXISTING_PEAK_LINKS_ENABLED", "1"); vi.stubEnv("PEAK_ADVANCE_AUTO_SYNC", "0");
    vi.stubEnv("PEAK_ADVANCE_CONFIG", JSON.stringify({ advanceAccountCode: "111100", bankAccountCode: "111300", bankAccountSubId: "sub-bank", journalTypeIds: { ADVANCE: "5", RETURN: "5", EXPENSE: "5" }, expenseAccounts: {} }));
    const doc = { code: "JV-209903-9", documentType: "DAILY_JOURNAL" as const, contactId: null, entries: [{ accountCode: "510104", debit: 300, credit: 0 }, { accountCode: "111100", debit: 0, credit: 300 }] };
    const r = await linkExistingPeakDocument(prisma, { kind: "EXPENSE", advanceId: advance.id, jobSheetId: sheet.id, documentNo: "JV-209903-9", documentType: "DAILY_JOURNAL", note: "trying to link a second document (example)", acknowledgeWarnings: true, requestKey: "rk-booked-link", actor }, async () => ({ ok: true, document: doc }));
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(reasons(r)).toMatch(/already booked in guide payment EXP-20990300077/);
    expect(await prisma.advancePeakDocumentLink.count()).toBe(0);
    expect(await outboxOf(entry.id)).toMatchObject({ status: "CANCELLED", documentNo: EXP });
  });
});

describe("the route", () => {
  const call = async (role: string, body: unknown, entryId: string) => {
    authMock.auth.mockResolvedValue({ user: { id: actor.actorId, role, ...(role === "GUIDE" ? { guideId: G } : {}) } });
    const r = await BOOKED(new NextRequest("http://test.local/x", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id: entryId }) });
    return { status: r.status, body: await r.json() };
  };
  const good = { expenseDocumentNo: EXP, paymentEvidenceNo: PV, reason: "Ticket already paid from the advance in the guide payment (example)" };

  it("admin only — operator, accountant and guide get 403 and nothing changes", async () => {
    const { entry } = await fixture();
    for (const role of ["OPERATOR", "ACCOUNTANT", "GUIDE"]) expect((await call(role, good, entry.id)).status).toBe(403);
    expect(await outboxOf(entry.id)).toMatchObject({ status: "PENDING" });
  });
  it("refuses malformed evidence, a missing reason and unknown fields (400); refuses while writes are frozen (503); then succeeds for an admin", async () => {
    const { entry } = await fixture();
    expect((await call("ADMIN", { ...good, expenseDocumentNo: "JV-1" }, entry.id)).status).toBe(400);
    expect((await call("ADMIN", { ...good, paymentEvidenceNo: "EXP-1" }, entry.id)).status).toBe(400);
    expect((await call("ADMIN", { ...good, reason: "short" }, entry.id)).status).toBe(400);
    expect((await call("ADMIN", { ...good, status: "POSTED" }, entry.id)).status).toBe(400);
    process.env.ADVANCE_WRITES_FROZEN = "1";
    expect((await call("ADMIN", good, entry.id)).status).toBe(503);
    delete process.env.ADVANCE_WRITES_FROZEN;
    expect(await outboxOf(entry.id)).toMatchObject({ status: "PENDING" });
    expect(await call("ADMIN", good, entry.id)).toMatchObject({ status: 200, body: { ok: true, replayed: false } });
  });
  it("two admins at once → closed once, one audit row", async () => {
    const { entry } = await fixture();
    const [a, b] = await Promise.all([mark(entry.id), mark(entry.id)]);
    expect([a.ok, b.ok].filter(Boolean).length).toBeGreaterThanOrEqual(1);
    expect(await prisma.auditLog.count({ where: { action: "advance.settlement_booked_in_guide_payment" } })).toBe(1);
    expect(await outboxOf(entry.id)).toMatchObject({ status: "CANCELLED", documentNo: EXP });
  });
});
