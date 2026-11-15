import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
const notified = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("@/lib/booking-import", async (orig) => ({ ...(await orig<typeof import("@/lib/booking-import")>()), notifyGuide: vi.fn(async (_g: string, m: string) => { notified.calls.push(m); }) }));

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { reviewExpense, reviewReceipts, reviewHistory } from "./job-expense-review";
import { POST as expenseRoute } from "@/app/api/jobsheet/expense-review/route";
import { POST as receiptRoute } from "@/app/api/jobsheet/receipt-review/route";

// The operator's review on the job sheet against a real database (owner 2026-11-15): the three
// fixed items (verified amount, reasons, one accounting row per item, protected rows, locked
// sheets, races) and Company ADV ticket receipts (verify / reject / ask, never settling the
// advance), plus who may do it. Every name and number is invented.

const G = "G-970";
const DATE = "2099-06-14";
const key = { guideId: G, date: DATE, slotIdx: 0 };
const ops = { id: "u_op", role: "OPERATOR" };

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.clearAllMocks(); notified.calls = [];
  await resetDatabase();
  await seedGuide(G);
});

async function sheet(over: Record<string, unknown> = {}) {
  return prisma.jobSheet.create({ data: {
    ref: "FOLK-BKK-20990614-01", ...key, tourId: "T-900", status: "Confirmed", bookings: [],
    expenses: [
      { rowId: "r_water", description: "Water (Inc. Guide)", expenseType: "meal", price: 10, pax: 7 },
      { rowId: "r_bus", description: "Bus (Inc. Guide)", expenseType: "transport", price: 15, pax: 6, paidBy: "guide", paidByBy: "u_op", paidByAt: "2099-06-14T12:00:00Z" },
      { rowId: "r_gp", description: "Grand Palace", expenseType: "entrance", price: 500, pax: 6, paidBy: "advance" },
    ],
    guideExpenses: [
      { description: "Water (Inc. Guide)", expenseType: "meal", price: 10, pax: 6 },
      { description: "Bus (Inc. Guide)", expenseType: "transport", price: 15, pax: 6 },
      { description: "Ferry (Inc. Guide)", expenseType: "transport", price: 8, pax: 6 },
      { description: "Grand Palace", expenseType: "entrance", price: 500, pax: 6 }, // a report from before the fixed items
    ],
    ...over,
  } });
}
const rows = async () => (await prisma.jobSheet.findUniqueOrThrow({ where: { guideId_date_slotIdx: key } })) as unknown as { id: string; expenses: Record<string, unknown>[]; guideExpenses: Record<string, unknown>[] };
const item = (list: Record<string, unknown>[], d: string) => list.filter((r) => r.description === d);

describe("reviewing the guide's fixed items", () => {
  it("Approve as reported: the review is stored, the accounting row matches, history kept", async () => {
    await sheet();
    expect(await reviewExpense(prisma, { ...key, item: "WATER", decision: { action: "APPROVE" }, actor: ops })).toMatchObject({ ok: true, status: "APPROVED", verified: 60, accountingRow: "updated" });
    const s = await rows();
    expect(item(s.guideExpenses, "Water (Inc. Guide)")[0]).toMatchObject({ reviewStatus: "APPROVED", verifiedAmount: 60, reviewedById: "u_op", reviewedOf: 60 });
    expect(item(s.expenses, "Water (Inc. Guide)")).toEqual([expect.objectContaining({ rowId: "r_water", price: 10, pax: 6 })]);
    expect(await reviewHistory(prisma, s.id)).toEqual([expect.objectContaining({ action: "expense.review", by: "OPERATOR", detail: expect.objectContaining({ item: "WATER", status: "APPROVED" }) })]);
  });

  it("another amount needs a reason; a confirmed accounting row is never rewritten", async () => {
    await sheet();
    expect(await reviewExpense(prisma, { ...key, item: "BUS", decision: { action: "APPROVE", verifiedAmount: 60 }, actor: ops })).toMatchObject({ ok: false, status: 400 });
    const r = await reviewExpense(prisma, { ...key, item: "BUS", decision: { action: "APPROVE", verifiedAmount: 60, reason: "One leg by boat, 4 fares" }, actor: ops });
    expect(r).toMatchObject({ ok: false, status: 409, reasons: [expect.stringMatching(/confirmed at 90/)] });
    expect(item((await rows()).expenses, "Bus (Inc. Guide)")[0]).toMatchObject({ price: 15, pax: 6 });
    // The confirmed row already says 90: approving 90 just records the review.
    expect(await reviewExpense(prisma, { ...key, item: "BUS", decision: { action: "APPROVE" }, actor: ops })).toMatchObject({ ok: true, accountingRow: "unchanged" });
  });

  it("an item with no accounting row gets ONE; a later change updates it, never adds a second", async () => {
    await sheet();
    expect(await reviewExpense(prisma, { ...key, item: "FERRY", decision: { action: "APPROVE" }, actor: ops })).toMatchObject({ ok: true, accountingRow: "added" });
    expect(await reviewExpense(prisma, { ...key, item: "FERRY", decision: { action: "APPROVE", verifiedAmount: 32, reason: "4 crossings, not 6" }, actor: ops })).toMatchObject({ ok: true, status: "ADJUSTED", accountingRow: "updated" });
    const ferry = item((await rows()).expenses, "Ferry (Inc. Guide)");
    expect(ferry).toHaveLength(1);
    expect(ferry[0]).toMatchObject({ price: 8, pax: 4, expenseType: "transport" });
    expect(typeof ferry[0].rowId).toBe("string");
  });

  it("two reviews at once leave one accounting row", async () => {
    await sheet();
    const results = await Promise.all([
      reviewExpense(prisma, { ...key, item: "FERRY", decision: { action: "APPROVE" }, actor: ops }),
      reviewExpense(prisma, { ...key, item: "FERRY", decision: { action: "APPROVE" }, actor: ops }),
    ]);
    expect(results.some((r) => r.ok)).toBe(true);
    expect(item((await rows()).expenses, "Ferry (Inc. Guide)")).toHaveLength(1);
  });

  it("Reject needs a reason and sets the accounting row to 0", async () => {
    await sheet();
    expect(await reviewExpense(prisma, { ...key, item: "WATER", decision: { action: "REJECT" }, actor: ops })).toMatchObject({ ok: false, status: 400 });
    expect(await reviewExpense(prisma, { ...key, item: "WATER", decision: { action: "REJECT", reason: "No water bought on this tour" }, actor: ops })).toMatchObject({ ok: true, status: "REJECTED", verified: 0 });
    expect(item((await rows()).expenses, "Water (Inc. Guide)")[0]).toMatchObject({ pax: 0 });
  });

  it("an approved sheet is locked; an item the guide did not report cannot be reviewed", async () => {
    await sheet({ approvalStatus: "APPROVED" });
    expect(await reviewExpense(prisma, { ...key, item: "WATER", decision: { action: "APPROVE" }, actor: ops })).toMatchObject({ ok: false, status: 409, reasons: [expect.stringMatching(/locked/)] });
    await prisma.jobSheet.update({ where: { guideId_date_slotIdx: key }, data: { approvalStatus: null, guideExpenses: [] } });
    expect(await reviewExpense(prisma, { ...key, item: "WATER", decision: { action: "APPROVE" }, actor: ops })).toMatchObject({ ok: false, status: 404 });
  });

  it("a report from before the fixed items keeps its old lines untouched", async () => {
    await sheet();
    await reviewExpense(prisma, { ...key, item: "WATER", decision: { action: "APPROVE" }, actor: ops });
    expect(item((await rows()).guideExpenses, "Grand Palace")).toEqual([{ description: "Grand Palace", expenseType: "entrance", price: 500, pax: 6 }]);
  });
});

describe("Company ADV ticket receipts", () => {
  async function withFiles(n = 1) {
    const s = await sheet();
    for (let i = 0; i < n; i++) await prisma.expenseAttachment.create({ data: { jobSheetId: s.id, expenseRowId: "r_gp", originalName: `gp-${i}.jpg`, mimeType: "image/jpeg", sizeBytes: 10, sha256: `h${i}`, status: "UPLOADED" } });
    const adv = await prisma.guideAdvance.create({ data: { guideId: G, date: DATE, slotIdx: 0, amount: 3000, paidAt: new Date(), method: "bank", txRef: "TX-ADV-970", advanceNo: "FOLK-ADV-209906-001", advanceDate: DATE, amountSatang: 300000, accountingPeriod: "2099-06" } });
    return { s, adv };
  }

  it("Verify marks the row's files, and never settles or posts the advance", async () => {
    const { adv } = await withFiles(2);
    const before = { entries: await prisma.guideAdvanceEntry.count(), sync: await prisma.advancePeakSync.findMany({ orderBy: { id: "asc" } }) };
    expect(await reviewReceipts(prisma, { ...key, rowId: "r_gp", action: "VERIFY", actor: ops })).toEqual({ ok: true, files: 2 });
    expect((await prisma.expenseAttachment.findMany()).map((f) => f.reviewStatus)).toEqual(["VERIFIED", "VERIFIED"]);
    expect(await prisma.guideAdvance.findUniqueOrThrow({ where: { id: adv.id } })).toMatchObject({ settledSatang: 0 });
    expect(await prisma.guideAdvanceEntry.count()).toBe(before.entries);
    expect(await prisma.advancePeakSync.findMany({ orderBy: { id: "asc" } })).toEqual(before.sync);
  });

  it("Ask for a new one needs a note, tells the guide, and the note is what they see", async () => {
    await withFiles();
    expect(await reviewReceipts(prisma, { ...key, rowId: "r_gp", action: "REQUEST_NEW", actor: ops }, async () => {})).toMatchObject({ ok: false, status: 400 });
    const sent: string[] = [];
    expect(await reviewReceipts(prisma, { ...key, rowId: "r_gp", action: "REQUEST_NEW", note: "Photo is cut off", actor: ops }, async (_g, m) => { sent.push(m); })).toMatchObject({ ok: true });
    expect(await prisma.expenseAttachment.findFirst()).toMatchObject({ reviewStatus: "REPLACEMENT_REQUESTED", reviewNote: "Photo is cut off" });
    expect(sent[0]).toMatch(/Grand Palace receipt.*Photo is cut off/);
  });

  it("an internal note changes no file and is kept in the history only", async () => {
    const { s } = await withFiles();
    await reviewReceipts(prisma, { ...key, rowId: "r_gp", action: "NOTE", note: "Closed early, check with guide", actor: ops });
    expect(await prisma.expenseAttachment.findFirst()).toMatchObject({ reviewStatus: "NOT_REVIEWED", reviewNote: null });
    expect((await reviewHistory(prisma, s.id)).at(-1)).toMatchObject({ action: "receipt.review", detail: expect.objectContaining({ action: "NOTE", internal: true }) });
  });

  it("only Company ADV rows, and Verify needs a file", async () => {
    await sheet();
    expect(await reviewReceipts(prisma, { ...key, rowId: "r_water", action: "VERIFY", actor: ops })).toMatchObject({ ok: false, status: 409 });
    expect(await reviewReceipts(prisma, { ...key, rowId: "r_gp", action: "VERIFY", actor: ops })).toMatchObject({ ok: false, status: 409, reasons: [expect.stringMatching(/no receipt/)] });
  });
});

describe("who may review (routes)", () => {
  const req = (body: unknown) => new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }) as unknown as NextRequest;
  it("a GUIDE (or an ACCOUNTANT) is refused both reviews; an OPERATOR is allowed", async () => {
    await sheet();
    for (const role of ["GUIDE", "ACCOUNTANT"]) {
      authMock.auth.mockResolvedValue({ user: { id: `u_${role}`, role, guideId: role === "GUIDE" ? G : undefined } });
      expect((await expenseRoute(req({ ...key, item: "WATER", action: "APPROVE" }))).status).toBe(403);
      expect((await receiptRoute(req({ ...key, rowId: "r_gp", action: "NOTE", note: "self-review" }))).status).toBe(403);
    }
    expect(item((await rows()).guideExpenses, "Water (Inc. Guide)")[0].reviewStatus).toBeUndefined();
    authMock.auth.mockResolvedValue({ user: { id: "u_op", role: "OPERATOR" } });
    expect((await expenseRoute(req({ ...key, item: "WATER", action: "APPROVE" }))).status).toBe(200);
  });
});
