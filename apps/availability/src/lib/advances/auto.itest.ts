import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The automatic steps of an advance (lib/advances/auto), against a real database: approving a
// job sheet settles the advance rows it covers; confirming a return puts it against the
// advance the guide named. A person still makes every decision; nothing is forced, and what
// the ledger refuses is reported and left undone. Every guide, figure and number is invented.

const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
const fetchSpy = vi.hoisted(() => vi.fn(async () => { throw new Error("no network in this test"); }));
vi.stubGlobal("fetch", fetchSpy);
vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPushToUser: vi.fn(async () => 0) }));
vi.mock("@/lib/line", async (orig) => ({ ...(await orig<typeof import("@/lib/line")>()), lineEnabled: false, linePush: vi.fn(async () => true), linePushFlex: vi.fn(async () => true) }));
vi.mock("@/lib/email", async (orig) => ({ ...(await orig<typeof import("@/lib/email")>()), sendEmail: vi.fn(async () => true) }));
vi.mock("@/lib/google-drive", async (orig) => ({ ...(await orig<typeof import("@/lib/google-drive")>()), googleDriveEnabled: false }));
vi.mock("@/lib/tour-calendar-sync", async (orig) => ({ ...(await orig<typeof import("@/lib/tour-calendar-sync")>()), removeTourEvents: vi.fn(async () => {}), pushTourToCalendars: vi.fn(async () => {}) }));

import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { recordReceipt } from "./service";
import { autoSettleSheet, settleableRows } from "./auto";
import { summariesFor } from "./summaries";
import { POST as APPROVE } from "@/app/api/jobsheet/approve/route";
import { POST as VERIFY } from "@/app/api/advances/returns/[id]/verify/route";
import type { SheetRow } from "./settlement";

const G = "G-941", DATE = "2099-10-12", JOBNO = "FOLK-TEST-AUTO-01";
const KEY = { guideId: G, date: DATE, slotIdx: 0 };
const sheetKey = { guideId_date_slotIdx: KEY };
let admin = { actorId: "", actorRole: "ADMIN" };
let n = 0;

const advanceRow = (description: string, price: number, pax: number, over: Record<string, unknown> = {}) =>
  ({ description, price, pax, expenseType: "entrance", paidBy: "advance", paidBySource: "operator", ...over });
async function seedAdvance(amount: number, allowed = ["entrance"]) {
  n++;
  return prisma.guideAdvance.create({ data: {
    guideId: G, date: DATE, slotIdx: 0, amount, paidAt: new Date("2099-10-11T03:00:00Z"), method: "bank", txRef: `TX-AUTO-${n}`,
    advanceNo: `FOLK-ADV-209910-${String(n).padStart(3, "0")}`, advanceDate: "2099-10-11", amountSatang: amount * 100, accountingPeriod: "2099-10",
    jobNo: JOBNO, slipUrl: "https://example.test/slip", allowedCategories: allowed, bankAccount: "sub-bank",
  } });
}
/** An unapproved, saved sheet whose rows are as given (`link` puts the advance's id on the advance rows, as a save would). */
async function seedSheet(rows: Record<string, unknown>[]) {
  return prisma.jobSheet.create({ data: { ref: JOBNO, guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [], guideFee: { price: 1000, time: 1, whtPct: 3 }, expenses: rows as Prisma.InputJsonValue } });
}
const approve = async (approveIt = true) => {
  const s = await prisma.jobSheet.findUniqueOrThrow({ where: sheetKey });
  const r = await APPROVE(new NextRequest("http://test.local/api/jobsheet/approve", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...KEY, approve: approveIt, reviewedUpdatedAt: s.updatedAt.toISOString() }) }));
  return { status: r.status, body: await r.json() };
};
const rowsNow = async () => (await prisma.jobSheet.findUniqueOrThrow({ where: sheetKey })).expenses as unknown as SheetRow[];
const settlements = () => prisma.guideAdvanceEntry.findMany({ where: { type: "EXPENSE_SETTLEMENT", reversedByEntryId: null }, orderBy: { createdAt: "asc" } });
const summaryOf = async (id: string) => (await summariesFor(prisma, [await prisma.guideAdvance.findUniqueOrThrow({ where: { id } })])).get(id)!;
async function claimedReturn(amount: number, advanceId: string | null) {
  const r = await recordReceipt(prisma, { guideId: G, receivedDate: "2099-10-13", amount, byGuide: true, today: "2099-12-31", bankRef: null, note: null, advanceId, jobSheetId: null, actor: { actorId: null, actorRole: "GUIDE" } });
  if (!r.ok) throw new Error(r.reasons.join(";"));
  return r.receipt.id;
}
const verify = async (receiptId: string) => {
  n++;
  const r = await VERIFY(new NextRequest("http://test.local/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bankRef: `BANK-AUTO-${n}`, bankAccount: "sub-bank" }) }), { params: Promise.resolve({ id: receiptId }) });
  return { status: r.status, body: await r.json() };
};

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.stubEnv("ADVANCE_WRITES_FROZEN", "0");
  vi.stubEnv("PEAK_ADVANCE_AUTO_SYNC", "0");
  fetchSpy.mockClear();
  await resetDatabase();
  await seedGuide(G);
  const a = await prisma.user.create({ data: { email: "admin-auto@example.test", displayName: "Admin Example", role: "ADMIN", state: "ACTIVE" } });
  admin = { actorId: a.id, actorRole: "ADMIN" };
  authMock.auth.mockResolvedValue({ user: { id: a.id, role: "ADMIN" } });
});
afterEach(() => vi.unstubAllEnvs());

describe("approving a job sheet settles the advance rows it covers", () => {
  it("1,000 advanced, 600 of tickets confirmed and linked: approval writes one settlement of 600 and marks the rows — no second click", async () => {
    const adv = await seedAdvance(1000);
    await seedSheet([advanceRow("Temple A", 200, 2, { advanceId: adv.id }), advanceRow("Temple B", 100, 2, { advanceId: adv.id }), { description: "Water", price: 20, pax: 2, expenseType: "meal", paidBy: "guide", paidBySource: "operator" }]);
    const res = await approve();
    expect(res.status).toBe(200);
    expect(res.body.advanceSettled).toEqual([{ advanceNo: adv.advanceNo, ok: true, amount: 600, rows: 2, reasons: [] }]);

    const entries = await settlements();
    expect(entries.map((e) => [e.advanceId, e.amountSatang, e.jobNo])).toEqual([[adv.id, 60000, JOBNO]]);
    expect((await rowsNow()).map((r) => !!r.advanceSettlement)).toEqual([true, true, false]);
    expect(await summaryOf(adv.id)).toMatchObject({ used: 60000, outstanding: 40000, driftSatang: 0 });
    // the version handed back is the sheet's version AFTER settling, so the next Save is not refused as stale
    expect(new Date(res.body.updatedAt).getTime()).toBe((await prisma.jobSheet.findUniqueOrThrow({ where: sheetKey })).updatedAt.getTime());
    // the settlement is queued for PEAK like any other, by the database's own trigger
    expect(await prisma.advancePeakSync.count({ where: { id: `EXPENSE:${entries[0].id}` } })).toBe(1);
    // Marked as automatic, with the action that caused it — and still the approver's, who made the decision.
    const settledAudit = await prisma.auditLog.findFirstOrThrow({ where: { action: "advance.expenses_settled" } });
    expect(settledAudit.actorId).toBe(admin.actorId);
    expect(settledAudit.detail).toMatchObject({ automatic: true, trigger: "jobsheet.approve" });
    expect(entries[0].provenance).toBe("SYSTEM");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("two advances on one job are each settled with their own rows", async () => {
    const tickets = await seedAdvance(1000, ["entrance"]);
    const meals = await seedAdvance(500, ["meal"]);
    await seedSheet([advanceRow("Temple", 250, 2, { advanceId: tickets.id }), advanceRow("Lunch", 150, 2, { expenseType: "meal", advanceId: meals.id })]);
    const res = await approve();
    expect(res.body.advanceSettled.map((x: { advanceNo: string; amount: number; ok: boolean }) => [x.advanceNo, x.amount, x.ok])).toEqual([[tickets.advanceNo, 500, true], [meals.advanceNo, 300, true]]);
    expect((await settlements()).map((e) => [e.advanceId, e.amountSatang]).sort()).toEqual([[tickets.id, 50000], [meals.id, 30000]].sort());
    expect((await rowsNow()).every((r) => !!r.advanceSettlement)).toBe(true);
  });

  it("approval is the decision and stands; a settlement the ledger refuses is reported and left undone", async () => {
    const adv = await seedAdvance(500);
    await seedSheet([advanceRow("Temple", 300, 2, { advanceId: adv.id })]); // 600 against 500
    const res = await approve();
    expect(res.status).toBe(200);
    expect(res.body.approvalStatus).toBe("APPROVED");
    expect(res.body.advanceSettled).toHaveLength(1);
    expect(res.body.advanceSettled[0]).toMatchObject({ advanceNo: adv.advanceNo, ok: false, amount: 0 });
    expect(res.body.advanceSettled[0].reasons.join(" ")).toMatch(/only 500 is outstanding/);
    expect(await settlements()).toEqual([]);
    expect((await rowsNow())[0].advanceSettlement ?? null).toBeNull();
  });

  it("only rows a person confirmed, linked to a live advance of this job, are touched", async () => {
    const adv = await seedAdvance(2000);
    await seedSheet([
      advanceRow("Unlinked", 100, 1),                                             // no advanceId
      advanceRow("Suggested", 100, 1, { advanceId: adv.id, paidBySource: "rate-default" }), // nobody confirmed the payer
      advanceRow("Other advance", 100, 1, { advanceId: "some-other-advance" }),
      advanceRow("Meal on a ticket advance", 100, 1, { advanceId: adv.id, expenseType: "meal" }),
      advanceRow("No amount", 100, 0, { advanceId: adv.id }),
      { description: "Guide paid", price: 100, pax: 1, expenseType: "entrance", paidBy: "guide", paidBySource: "operator", advanceId: adv.id },
      advanceRow("Confirmed and linked", 100, 1, { advanceId: adv.id }),
    ]);
    const res = await approve();
    expect(res.body.advanceSettled).toEqual([{ advanceNo: adv.advanceNo, ok: true, amount: 100, rows: 1, reasons: [] }]);
    expect((await rowsNow()).map((r) => !!r.advanceSettlement)).toEqual([false, false, false, false, false, false, true]);
  });

  it("nothing to settle is not an error: no advance, or no advance rows", async () => {
    await seedSheet([{ description: "Water", price: 20, pax: 2, expenseType: "meal", paidBy: "guide", paidBySource: "operator" }]);
    const res = await approve();
    expect(res.status).toBe(200);
    expect(res.body.advanceSettled).toEqual([]);
    expect(await prisma.guideAdvanceEntry.count()).toBe(0);
  });

  it("approving again after a withdrawal does not settle twice", async () => {
    const adv = await seedAdvance(1000);
    await seedSheet([advanceRow("Temple", 300, 2, { advanceId: adv.id })]);
    await approve();
    await approve(false);
    const again = await approve();
    expect(again.body.advanceSettled).toEqual([]); // the row already carries its settlement
    expect(await settlements()).toHaveLength(1);
    expect(await summaryOf(adv.id)).toMatchObject({ used: 60000, driftSatang: 0 });
  });

  it("two rows that read exactly the same are left for a person — the others still settle", async () => {
    const adv = await seedAdvance(2000);
    await seedSheet([advanceRow("Temple", 100, 1, { advanceId: adv.id }), advanceRow("Temple", 100, 1, { advanceId: adv.id }), advanceRow("Palace", 500, 1, { advanceId: adv.id })]);
    const rows = await rowsNow();
    expect(settleableRows(rows, adv).map((l) => l.index)).toEqual([2]);
    const res = await approve();
    expect(res.body.advanceSettled).toEqual([{ advanceNo: adv.advanceNo, ok: true, amount: 500, rows: 1, reasons: [] }]);
  });

  it("a reversed advance is not settled against, and nothing happens while advance writes are frozen", async () => {
    const adv = await seedAdvance(1000);
    await seedSheet([advanceRow("Temple", 300, 2, { advanceId: adv.id })]);
    vi.stubEnv("ADVANCE_WRITES_FROZEN", "1");
    expect((await approve()).body.advanceSettled).toEqual([]);
    expect(await settlements()).toEqual([]);
    vi.stubEnv("ADVANCE_WRITES_FROZEN", "0");
    await prisma.guideAdvance.update({ where: { id: adv.id }, data: { reversedAt: new Date(), reversalReason: "never sent (example)" } });
    expect(await autoSettleSheet(prisma, KEY, admin)).toEqual([]);
    expect(await settlements()).toEqual([]);
  });

  it("a sheet that is not approved is never settled, whoever asks", async () => {
    const adv = await seedAdvance(1000);
    await seedSheet([advanceRow("Temple", 300, 2, { advanceId: adv.id })]);
    expect(await autoSettleSheet(prisma, KEY, admin)).toEqual([]);
    expect(await settlements()).toEqual([]);
  });
});

describe("confirming a return puts it against the advance the guide named", () => {
  it("300 returned on an advance holding 400: confirmed against the bank, then allocated in full — one step", async () => {
    const adv = await seedAdvance(1000);
    await seedSheet([advanceRow("Temple", 300, 2, { advanceId: adv.id })]);
    await approve(); // 600 used, 400 left with the guide
    const receiptId = await claimedReturn(300, adv.id);
    const res = await verify(receiptId);
    expect(res.status).toBe(200);
    expect(res.body.allocated).toEqual({ advanceNo: adv.advanceNo, ok: true, amount: 300, left: 0, reasons: [] });
    expect(await prisma.guideAdvanceReceipt.findUniqueOrThrow({ where: { id: receiptId } })).toMatchObject({ status: "VERIFIED", allocatedSatang: 30000 });
    expect(await summaryOf(adv.id)).toMatchObject({ used: 60000, returned: 30000, outstanding: 10000, driftSatang: 0 });
    const allocAudit = await prisma.auditLog.findFirstOrThrow({ where: { action: "advance.return_allocated" } });
    expect(allocAudit.detail).toMatchObject({ automatic: true, trigger: "return.verify" });
    expect(allocAudit.actorId).toBe(admin.actorId);
    expect((await prisma.guideAdvanceEntry.findFirstOrThrow({ where: { type: "RETURN_ALLOCATION" } })).provenance).toBe("SYSTEM");
  });

  it("a return larger than what the advance holds: the advance is cleared and the excess is left for a person, never allocated away", async () => {
    const adv = await seedAdvance(1000);
    await seedSheet([advanceRow("Temple", 300, 2, { advanceId: adv.id })]);
    await approve(); // 400 left
    const receiptId = await claimedReturn(500, adv.id);
    const res = await verify(receiptId);
    expect(res.body.allocated).toMatchObject({ ok: true, amount: 400, left: 100 });
    expect(await prisma.guideAdvanceReceipt.findUniqueOrThrow({ where: { id: receiptId } })).toMatchObject({ allocatedSatang: 40000, amountSatang: 50000 });
    expect(await summaryOf(adv.id)).toMatchObject({ outstanding: 0, status: "SETTLED", driftSatang: 0 });
    expect(await prisma.guideAdvanceRefund.count()).toBe(0); // the refund of an excess stays a person's two steps
  });

  it("a return that names no advance is confirmed and left for a person to allocate", async () => {
    await seedAdvance(1000);
    const receiptId = await claimedReturn(300, null);
    const res = await verify(receiptId);
    expect(res.status).toBe(200);
    expect(res.body.allocated).toBeNull();
    expect(await prisma.guideAdvanceReceipt.findUniqueOrThrow({ where: { id: receiptId } })).toMatchObject({ status: "VERIFIED", allocatedSatang: 0 });
  });

  it("a return that could not be confirmed is not allocated", async () => {
    const adv = await seedAdvance(1000);
    const receiptId = await claimedReturn(300, adv.id);
    const r = await VERIFY(new NextRequest("http://test.local/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bankAccount: "sub-bank" }) }), { params: Promise.resolve({ id: receiptId }) });
    expect(r.status).not.toBe(200); // no bank reference: nothing confirmed
    expect(await prisma.guideAdvanceReceipt.findUniqueOrThrow({ where: { id: receiptId } })).toMatchObject({ status: "CLAIMED", allocatedSatang: 0 });
    expect(await prisma.guideAdvanceEntry.count({ where: { type: "RETURN_ALLOCATION" } })).toBe(0);
  });
});
