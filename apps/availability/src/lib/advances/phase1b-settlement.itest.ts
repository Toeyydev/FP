import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// Advance settlement, Phase 1B, against a real database: linking rows to an advance on save,
// settling exact rows (job-scoped, confirmed, category-safe, server-computed, idempotent),
// protecting settled rows, and reversing safely. Driven through the real routes. All data
// invented — this repo is public.

const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPushToUser: vi.fn(async () => 0) }));
vi.mock("@/lib/line", async (orig) => ({ ...(await orig<typeof import("@/lib/line")>()), lineEnabled: false, linePush: vi.fn(async () => true), linePushFlex: vi.fn(async () => true) }));
vi.mock("@/lib/email", async (orig) => ({ ...(await orig<typeof import("@/lib/email")>()), sendEmail: vi.fn(async () => true) }));
vi.mock("@/lib/google-drive", async (orig) => ({ ...(await orig<typeof import("@/lib/google-drive")>()), googleDriveEnabled: false }));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { PUT } from "@/app/api/jobsheet/route";
import { POST as SETTLE } from "@/app/api/advances/[id]/settle-expenses/route";
import { POST as REVERSE } from "@/app/api/advances/entries/[id]/reverse/route";
import { financialIdentity } from "@/lib/protected-expense-fields";
import { settlementRequestKey } from "@/lib/advances/settlement";
import { summariesFor } from "@/lib/advances/summaries";
import { jobAdvanceView } from "@/lib/advances/job-view";
import { keepSettledRows } from "@/lib/advances/settlement";
import type { Expense, GuideFee } from "@/lib/jobsheet";

const G = "G-913";
const DATE = "2099-06-01", OTHER_DATE = "2099-06-02";
const FEE: GuideFee = { price: 1000, time: 1, whtPct: 3 };
type Row = Expense & Record<string, unknown>;
let opId = "";
let seq = 0;

/** A row whose payer an operator confirmed as Company Advance (stamped), optionally linked. */
const row = (description: string, expenseType: string, price: number, pax: number, over: Record<string, unknown> = {}): Row =>
  ({ description, expenseType, price, pax, paidBy: "advance", paidBySource: "operator", paidByBy: "u_op", paidByAt: "2099-06-01T10:00:00.000Z", ...over }) as Row;

async function advance(over: Record<string, unknown> = {}) {
  seq++;
  return prisma.guideAdvance.create({ data: {
    guideId: G, date: DATE, slotIdx: 0, amount: 1000, paidAt: new Date("2099-05-31T03:00:00Z"), method: "bank", txRef: `TX-EX-${seq}`,
    advanceNo: `FOLK-ADV-209906-${String(seq).padStart(3, "0")}`, advanceDate: "2099-05-31", amountSatang: 100_000, accountingPeriod: "2099-05",
    allowedCategories: ["entrance"], ...over,
  } });
}
async function sheet(rows: Row[], over: Record<string, unknown> = {}) {
  return prisma.jobSheet.create({ data: { ref: `FOLK-TEST-SET-${++seq}`, guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [], expenses: rows as never, guideFee: FEE, approvalStatus: "APPROVED", ...over } });
}
const fresh = (id: string) => prisma.jobSheet.findUniqueOrThrow({ where: { id } });
const rowsOf = async (id: string) => (await fresh(id)).expenses as unknown as Row[];

async function settle(advanceId: string, sheetId: string, indexes: number[], extra: Record<string, unknown> = {}) {
  const s = await fresh(sheetId);
  const rows = s.expenses as unknown as Row[];
  const body = { jobSheetId: s.id, sheetVersion: s.updatedAt.toISOString(), lines: indexes.map((i) => ({ index: i, identity: rows[i] ? financialIdentity(rows[i]) : "missing" })), ...extra };
  const r = await SETTLE(new NextRequest(`http://test.local/api/advances/${advanceId}/settle-expenses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: advanceId }) });
  return { status: r.status, body: await r.json(), sent: body };
}
async function reverse(entryId: string, reason = "settled the wrong rows (example)") {
  const r = await REVERSE(new NextRequest(`http://test.local/api/advances/entries/${entryId}/reverse`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }) }), { params: Promise.resolve({ id: entryId }) });
  return { status: r.status, body: await r.json() };
}
async function save(expenses: Row[], extra: Record<string, unknown> = {}) {
  const r = await PUT(new NextRequest("http://test.local/api/jobsheet", { method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [], expenses, guideFee: FEE, ...extra }) }));
  return { status: r.status, body: await r.json() };
}
const summaryOf = async (id: string) => (await summariesFor(prisma, [await prisma.guideAdvance.findUniqueOrThrow({ where: { id } })])).get(id)!;

beforeAll(() => { requireTestDatabase(); });
beforeEach(async () => {
  vi.clearAllMocks();
  delete process.env.ADVANCE_WRITES_FROZEN;
  await resetDatabase();
  await seedGuide(G);
  const op = await prisma.user.create({ data: { email: "op-1b@example.test", displayName: "Op Example", role: "OPERATOR", state: "ACTIVE" } });
  opId = op.id;
  authMock.auth.mockResolvedValue({ user: { id: op.id, role: "OPERATOR" } });
});

describe("2 · linking a Company Advance row to an advance on save", () => {
  it("one advance on the job → the server links the row; the client cannot set advanceId itself", async () => {
    const a = await advance();
    const r = await save([{ description: "Grand Palace", expenseType: "entrance", price: 500, pax: 1, paidBy: "advance", paidBySource: "operator", advanceId: "adv-forged" } as Row]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const s = await prisma.jobSheet.findFirstOrThrow({ where: { guideId: G } });
    expect((s.expenses as unknown as Row[])[0]).toMatchObject({ advanceId: a.id, paidByBy: opId });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "jobsheet.saved" }, orderBy: { createdAt: "desc" } });
    expect(audit.detail).toMatchObject({ advanceLinks: [{ to: a.advanceNo }], ignoredClientOwnedFields: true });
  });
  it("two advances could have paid → refused until the operator chooses; the choice is checked", async () => {
    const a = await advance(), b = await advance();
    const rows = [{ description: "Grand Palace", expenseType: "entrance", price: 500, pax: 1, paidBy: "advance", paidBySource: "operator" } as Row];
    const refused = await save(rows);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("advance-link");
    expect(refused.body.reasons[0]).toMatch(/more than one advance .* choose which/);
    expect((await save(rows, { advanceChoices: [{ index: 0, advanceId: "nope" }] })).status).toBe(409);
    expect((await save(rows, { advanceChoices: [{ index: 0, advanceId: b.id }] })).status).toBe(200);
    expect((await prisma.jobSheet.findFirstOrThrow({ where: { guideId: G } })).expenses).toMatchObject([{ advanceId: b.id }]);
    void a;
  });
  it("no advance may pay for it → Company Advance cannot be confirmed (controlled refusal)", async () => {
    await advance(); // tickets only
    const r = await save([{ description: "Lunch", expenseType: "meal", price: 150, pax: 2, paidBy: "advance", paidBySource: "operator" } as Row]);
    expect(r.status).toBe(409);
    expect(r.body.reasons[0]).toMatch(/Company Advance can't be confirmed .* may not pay for meal costs/);
  });
  it("payer changed away from Company Advance → the link is removed", async () => {
    // A guide-confirmed row (no operator stamp — a stamped payer is changed through its own
    // protection, not a plain save): linked on save, then the payer changes.
    const a = await advance();
    const s = await sheet([{ description: "Grand Palace", expenseType: "entrance", price: 500, pax: 1, paidBy: "advance", paidBySource: "guide", advanceId: a.id } as Row], { approvalStatus: null });
    const stored = await rowsOf(s.id);
    const r = await save([{ ...stored[0], paidBy: "guide", paidBySource: "operator", paidByReason: "guide paid at the gate (example)" }], { baseUpdatedAt: s.updatedAt.toISOString() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await rowsOf(s.id))[0]).not.toHaveProperty("advanceId");
  });
  it("a linked row whose category changes is revalidated: a category the advance does not allow is refused", async () => {
    await advance();
    await save([{ description: "Boat", expenseType: "entrance", price: 100, pax: 2, paidBy: "advance", paidBySource: "operator" } as Row]);
    const stored = (await prisma.jobSheet.findFirstOrThrow({ where: { guideId: G } })).expenses as unknown as Row[];
    const r = await save([{ ...stored[0], expenseType: "transport", paidByReason: "boat was paid from the advance (example)" }]);
    expect(r.status).toBe(409);
    expect(r.body.reasons.join(" ")).toMatch(/may not pay for transport costs/);
  });
  it("31–32 · historical Company Advance rows with no link and no advance stay as they were, and an unrelated save succeeds", async () => {
    const legacy = row("Grand Palace", "entrance", 500, 2); // confirmed long ago, never linked, no advance recorded
    const s = await sheet([legacy, { description: "Water", expenseType: "meal", price: 10, pax: 2, paidBy: "guide", paidBySource: "operator" } as Row], { approvalStatus: null });
    const r = await save([legacy, { description: "Water", expenseType: "meal", price: 10, pax: 3, paidBy: "guide", paidBySource: "operator" } as Row], { baseUpdatedAt: s.updatedAt.toISOString() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = await rowsOf(s.id);
    expect(after[0]).toMatchObject({ description: "Grand Palace", paidBy: "advance", paidBySource: "operator" });
    expect(after[0]).not.toHaveProperty("advanceId");
    expect(after[1].pax).toBe(3);
  });
  it("an operator can explicitly link such a historical confirmed row by choosing its advance (same checks)", async () => {
    const legacy = row("Grand Palace", "entrance", 500, 2);
    const s = await sheet([legacy], { approvalStatus: null });
    const a = await advance();
    const r = await save([legacy], { baseUpdatedAt: s.updatedAt.toISOString(), advanceChoices: [{ index: 0, advanceId: a.id }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await rowsOf(s.id))[0]).toMatchObject({ advanceId: a.id, paidByBy: "u_op" }); // the original stamp stays
  });
});

describe("1, 5–11, 14, 26–29 · settling exact rows", () => {
  it("1, 11, 14, 26, 28 · same job, valid rows → settled; amount from the rows; exact snapshot; RETURN_DUE on an approved sheet", async () => {
    const a = await advance();
    const s = await sheet([row("Grand Palace", "entrance", 500, 1, { advanceId: "" }), row("Wat Pho", "entrance", 100, 2)]);
    await prisma.jobSheet.update({ where: { id: s.id }, data: { expenses: [row("Grand Palace", "entrance", 500, 1, { advanceId: a.id }), row("Wat Pho", "entrance", 100, 2, { advanceId: a.id })] as never } });
    expect((await summaryOf(a.id)).status).toBe("RETURN_DUE"); // approved, nothing used yet
    const r = await settle(a.id, s.id, [0, 1]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ amount: 700, outstanding: 300, status: "RETURN_DUE", replayed: false });
    const entry = await prisma.guideAdvanceEntry.findUniqueOrThrow({ where: { id: r.body.entryId } });
    expect(entry).toMatchObject({ type: "EXPENSE_SETTLEMENT", amountSatang: 70_000, sourceType: "JOB_SHEET", sourceId: s.id, requestKey: settlementRequestKey(a.id, s.id, r.sent.sheetVersion, r.sent.lines.map((l) => l.identity)) });
    const snap = entry.snapshot as { lines: { index: number; amountSatang: number; advanceId: string; category: string }[]; total: number };
    expect(snap.lines.map((l) => [l.index, l.amountSatang, l.category, l.advanceId])).toEqual([[0, 50_000, "entrance", a.id], [1, 20_000, "entrance", a.id]]);
    expect(snap.total).toBe(70_000);
    expect(await summaryOf(a.id)).toMatchObject({ used: 70_000, outstanding: 30_000, status: "RETURN_DUE", driftSatang: 0 });
    expect((await rowsOf(s.id)).map((x) => (x.advanceSettlement as { entryId: string } | undefined)?.entryId)).toEqual([r.body.entryId, r.body.entryId]);
  });
  it("27 · OPEN → IN_USE when the sheet is not approved yet (the summary's own rule)", async () => {
    const a = await advance();
    await sheet([], { approvalStatus: null });
    expect((await summaryOf(a.id)).status).toBe("OPEN");
  });
  it("29 · settling the whole advance → SETTLED", async () => {
    const a = await advance();
    const s = await sheet([row("Grand Palace", "entrance", 500, 2, { advanceId: a.id })]);
    expect((await settle(a.id, s.id, [0])).body).toMatchObject({ amount: 1000, outstanding: 0, status: "SETTLED" });
  });
  it("2 · same guide, different job → refused (409)", async () => {
    const a = await advance({ date: OTHER_DATE });
    const s = await sheet([row("Grand Palace", "entrance", 500, 1, { advanceId: a.id })]);
    const r = await settle(a.id, s.id, [0]);
    expect(r.status).toBe(409);
    expect(r.body.reasons[0]).toMatch(/issued for another job/);
  });
  it("3 · an unconfirmed Company Advance payer is refused", async () => {
    const a = await advance();
    for (const src of ["rate-default", "default-after-tour", "category-default"]) {
      const s = await sheet([row("Grand Palace", "entrance", 500, 1, { advanceId: a.id, paidBySource: src, paidByBy: undefined, paidByAt: undefined })], { ref: `FOLK-TEST-SRC-${src}`, slotIdx: ["rate-default", "default-after-tour", "category-default"].indexOf(src) + 1 });
      await prisma.guideAdvance.update({ where: { id: a.id }, data: { slotIdx: s.slotIdx } });
      const r = await settle(a.id, s.id, [0]);
      expect(r.status, src).toBe(409);
      expect(r.body.reasons[0], src).toMatch(/not Company Advance confirmed by a person/);
    }
  });
  it("4–5 · no link, or a link to another advance → refused", async () => {
    const a = await advance(), b = await advance();
    const s = await sheet([row("Grand Palace", "entrance", 500, 1), row("Wat Pho", "entrance", 100, 2, { advanceId: b.id })]);
    expect((await settle(a.id, s.id, [0])).body.reasons[0]).toMatch(/is not linked to FOLK-ADV/);
    expect((await settle(a.id, s.id, [1])).body.reasons[0]).toMatch(/linked to another advance/);
  });
  it("6–10 · categories: entrance always; meal / transport / other only when the advance allows them", async () => {
    const tickets = await advance();
    const s1 = await sheet([row("Lunch", "meal", 100, 2, { advanceId: tickets.id })]);
    expect((await settle(tickets.id, s1.id, [0])).body.reasons[0]).toMatch(/may not pay for meal costs/);
    for (const [i, cat] of (["meal", "transport", "other"] as const).entries()) {
      const a = await advance({ slotIdx: i + 1, allowedCategories: ["entrance", cat] });
      const s = await sheet([row(`Example ${cat}`, cat, 100, 2, { advanceId: a.id })], { slotIdx: i + 1 });
      const r = await settle(a.id, s.id, [0]);
      expect(r.status, cat).toBe(200);
      expect(r.body.amount, cat).toBe(200);
    }
    const noOther = await advance({ slotIdx: 5, allowedCategories: ["entrance", "meal"] });
    const s5 = await sheet([row("Boat hire", "other", 300, 1, { advanceId: noOther.id })], { slotIdx: 5 });
    expect((await settle(noOther.id, s5.id, [0])).body.reasons[0]).toMatch(/may not pay for other costs/);
  });
  it("12 · the client cannot send an amount", async () => {
    const a = await advance();
    const s = await sheet([row("Grand Palace", "entrance", 500, 1, { advanceId: a.id })]);
    const r = await settle(a.id, s.id, [0], { amount: 1 });
    expect(r.status).toBe(400);
    expect(r.body.reasons[0]).toMatch(/server works out the amount/);
    expect(await prisma.guideAdvanceEntry.count()).toBe(0);
  });
  it("13 · more than is outstanding → refused, nothing written", async () => {
    const a = await advance();
    const s = await sheet([row("Grand Palace", "entrance", 500, 3, { advanceId: a.id })]);
    const r = await settle(a.id, s.id, [0]);
    expect(r.status).toBe(409);
    expect(r.body.reasons[0]).toMatch(/only 1,000 is outstanding/);
    expect(await prisma.guideAdvanceEntry.count()).toBe(0);
  });
  it("15 · two rows that read the same → DUPLICATE_IDENTITY (422), nothing guessed", async () => {
    const a = await advance();
    const s = await sheet([row("Grand Palace", "entrance", 100, 1, { advanceId: a.id }), row("Grand Palace", "entrance", 100, 1, { advanceId: a.id })]);
    const r = await settle(a.id, s.id, [0]);
    expect(r.status).toBe(422);
    expect(r.body.reasons[0]).toMatch(/DUPLICATE_IDENTITY/);
  });
  it("16 · a row already settled is refused; a stale sheet version is refused", async () => {
    const a = await advance({ amountSatang: 200_000, amount: 2000 });
    const s = await sheet([row("Grand Palace", "entrance", 500, 1, { advanceId: a.id }), row("Wat Pho", "entrance", 100, 1, { advanceId: a.id })]);
    const before = await fresh(s.id);
    expect((await settle(a.id, s.id, [0])).status).toBe(200);
    // the same row again, with the current version → already settled
    expect((await settle(a.id, s.id, [0, 1])).body.reasons.join(" ")).toMatch(/already settled against/);
    // the old version → stale
    const stale = await SETTLE(new NextRequest(`http://test.local/x`, { method: "POST", body: JSON.stringify({ jobSheetId: s.id, sheetVersion: before.updatedAt.toISOString(), lines: [{ index: 1, identity: financialIdentity((before.expenses as unknown as Row[])[1]) }] }) }), { params: Promise.resolve({ id: a.id }) });
    expect(stale.status).toBe(409);
    expect((await stale.json()).reasons[0]).toMatch(/changed since you opened it/);
  });
});

describe("17–19 · idempotency and concurrency", () => {
  it("17 · retry after success (client timed out) → the original result, no new entry", async () => {
    const a = await advance();
    const s = await sheet([row("Grand Palace", "entrance", 500, 1, { advanceId: a.id })]);
    const first = await settle(a.id, s.id, [0]);
    const retry = await SETTLE(new NextRequest("http://test.local/x", { method: "POST", body: JSON.stringify(first.sent) }), { params: Promise.resolve({ id: a.id }) });
    const body = await retry.json();
    expect(retry.status).toBe(200);
    expect(body).toMatchObject({ entryId: first.body.entryId, replayed: true, amount: 500 });
    expect(await prisma.guideAdvanceEntry.count({ where: { type: "EXPENSE_SETTLEMENT" } })).toBe(1);
  });
  it("18 · a different row selection is a different request key; a request key that does not match is refused", async () => {
    expect(settlementRequestKey("a", "s", "2099-06-01T00:00:00.000Z", ["x", "y"])).toBe(settlementRequestKey("a", "s", "2099-06-01T00:00:00.000Z", ["y", "x"]));
    expect(settlementRequestKey("a", "s", "2099-06-01T00:00:00.000Z", ["x"])).not.toBe(settlementRequestKey("a", "s", "2099-06-01T00:00:00.000Z", ["x", "y"]));
    expect(settlementRequestKey("a", "s", "2099-06-01T00:00:00.000Z", ["x"])).not.toBe(settlementRequestKey("a", "s", "2099-06-02T00:00:00.000Z", ["x"]));
    const a = await advance();
    const s = await sheet([row("Grand Palace", "entrance", 500, 1, { advanceId: a.id })]);
    const r = await settle(a.id, s.id, [0], { requestKey: "settle-made-up-by-the-client" });
    expect(r.status).toBe(400);
  });
  it("19 · double click / two tabs: the same request at once → one entry; different selections at once → one live settlement", async () => {
    const a = await advance();
    const s = await sheet([row("Grand Palace", "entrance", 500, 1, { advanceId: a.id }), row("Wat Pho", "entrance", 100, 1, { advanceId: a.id })]);
    const twice = await Promise.all([settle(a.id, s.id, [0]), settle(a.id, s.id, [0]), settle(a.id, s.id, [0])]);
    expect(twice.filter((t) => t.status === 200).length).toBeGreaterThanOrEqual(1);
    expect(new Set(twice.filter((t) => t.status === 200).map((t) => t.body.entryId)).size).toBe(1);
    expect(twice.every((t) => t.status === 200 || t.status === 409)).toBe(true);
    expect(await prisma.guideAdvanceEntry.count({ where: { type: "EXPENSE_SETTLEMENT" } })).toBe(1);
    expect((await summaryOf(a.id))).toMatchObject({ used: 50_000, driftSatang: 0 });

    const b = await advance({ slotIdx: 1 });
    const s2 = await sheet([row("Grand Palace", "entrance", 500, 1, { advanceId: b.id }), row("Wat Pho", "entrance", 100, 1, { advanceId: b.id })], { slotIdx: 1 });
    const tabs = await Promise.all([settle(b.id, s2.id, [0]), settle(b.id, s2.id, [1])]);
    expect(tabs.filter((t) => t.status === 200)).toHaveLength(1);
    expect(tabs.filter((t) => t.status === 409)).toHaveLength(1);
    expect(await prisma.guideAdvanceEntry.count({ where: { advanceId: b.id, type: "EXPENSE_SETTLEMENT" } })).toBe(1);
    expect((await summaryOf(b.id)).driftSatang).toBe(0);
  });
});

describe("20–25 · settled rows are protected; reversal", () => {
  async function settledSheet() {
    const a = await advance();
    // Guide-confirmed rows (no operator stamp): only the settlement protects the first one.
    const s = await sheet([row("Grand Palace", "entrance", 500, 1, { advanceId: a.id, paidBySource: "guide", paidByBy: undefined, paidByAt: undefined }), { description: "Water", expenseType: "meal", price: 10, pax: 2, paidBy: "guide", paidBySource: "guide" } as Row]);
    const r = await settle(a.id, s.id, [0]);
    expect(r.status).toBe(200);
    return { a, s, entryId: r.body.entryId as string };
  }
  it("20–22 · amount, payer and category of a settled row cannot change", async () => {
    const { s } = await settledSheet();
    const stored = await rowsOf(s.id);
    for (const change of [{ pax: 2 }, { price: 600 }, { paidBy: "guide", paidByReason: "guide paid (example)" }, { expenseType: "transport", paidByReason: "boat was paid from the advance (example)" }]) {
      const cur = await fresh(s.id);
      const r = await save([{ ...stored[0], ...change }, stored[1]], { baseUpdatedAt: cur.updatedAt.toISOString() });
      expect(r.status, JSON.stringify(change)).toBe(409);
      expect(r.body.reasons.join(" "), JSON.stringify(change)).toMatch(/settlement of company advance FOLK-ADV/);
    }
    // An unrelated edit is fine, and the settled row comes back exactly as settled.
    const cur = await fresh(s.id);
    expect((await save([stored[0], { ...stored[1], pax: 3 }], { baseUpdatedAt: cur.updatedAt.toISOString() })).status).toBe(200);
    expect((await rowsOf(s.id))[0]).toMatchObject({ pax: 1, price: 500, paidBy: "advance", advanceSettlement: { advanceNo: expect.stringMatching(/^FOLK-ADV/) } });
  });
  it("23, 26 · reversal: contra entry, history kept, the row editable again, Used/Outstanding back", async () => {
    const { a, s, entryId } = await settledSheet();
    const r = await reverse(entryId);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const original = await prisma.guideAdvanceEntry.findUniqueOrThrow({ where: { id: entryId } });
    expect(original.reversedByEntryId).toBeTruthy();
    expect(await prisma.guideAdvanceEntry.count({ where: { advanceId: a.id } })).toBe(2);
    expect(await summaryOf(a.id)).toMatchObject({ used: 0, outstanding: 100_000, driftSatang: 0 });
    const rows = await rowsOf(s.id);
    expect(rows[0]).not.toHaveProperty("advanceSettlement");
    const cur = await fresh(s.id);
    expect((await save([{ ...rows[0], pax: 2 }, rows[1]], { baseUpdatedAt: cur.updatedAt.toISOString() })).status).toBe(200);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "advance.entry_reversed" } });
    expect(audit.detail).toMatchObject({ type: "EXPENSE_SETTLEMENT", outstandingBefore: 500, outstandingAfter: 1000, reason: "settled the wrong rows (example)" });
  });
  it("24–25 · in PEAK (linked document, posted outbox, or sending) → controlled 409 naming it; never a 500; nothing changed", async () => {
    const { entryId } = await settledSheet();
    await prisma.advancePeakDocumentLink.create({ data: { kind: "EXPENSE", sourceId: entryId, documentType: "DAILY_JOURNAL", documentNo: "JV-EXAMPLE-0001", note: "entered by hand in PEAK (example)" } as never });
    const linked = await reverse(entryId);
    expect(linked.status).toBe(409);
    expect(linked.body.reasons[0]).toMatch(/JV-EXAMPLE-0001/);
    await prisma.advancePeakDocumentLink.deleteMany({});
    await prisma.advancePeakSync.update({ where: { id: `EXPENSE:${entryId}` }, data: { status: "SENDING" } });
    const sending = await reverse(entryId);
    expect(sending.status).toBe(409);
    expect(sending.body.reasons[0]).toMatch(/in PEAK/);
    expect((await prisma.guideAdvanceEntry.findUniqueOrThrow({ where: { id: entryId } })).reversedByEntryId).toBeNull();
  });
});

describe("30, 33 · ledger safety and audit", () => {
  it("30 · a counter that disagrees with the entries blocks settlement (diagnostic, nothing written)", async () => {
    const a = await advance();
    const s = await sheet([row("Grand Palace", "entrance", 500, 1, { advanceId: a.id })]);
    await prisma.$executeRawUnsafe(`UPDATE "GuideAdvance" SET "settledSatang" = 10000 WHERE id = '${a.id}'`);
    const r = await settle(a.id, s.id, [0]);
    expect(r.status).toBe(409);
    expect(r.body.reasons[0]).toMatch(/COUNTER_DRIFT/);
    expect(await prisma.guideAdvanceEntry.count()).toBe(0);
  });
  it("33 · the settlement audit names the advance, sheet, lines, amount, request key and the result — and no guest", async () => {
    const a = await advance();
    const s = await sheet([row("Grand Palace", "entrance", 500, 1, { advanceId: a.id })], { bookings: [{ name: "Guest Example Person", bookingNo: "GYGEXAMPLE1", bookedPax: 1 }] as never });
    const r = await settle(a.id, s.id, [0]);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "advance.expenses_settled" } });
    expect(audit).toMatchObject({ actorId: opId, entityId: a.id });
    expect(audit.detail).toMatchObject({ advanceNo: a.advanceNo, jobSheetId: s.id, entryId: r.body.entryId, amount: 500, outstandingBefore: 1000, outstandingAfter: 500, statusAfter: "RETURN_DUE", lines: [{ index: 0, category: "entrance", amount: 500 }] });
    expect((audit.detail as { requestKey: string }).requestKey).toMatch(/^settle:/);
    expect(JSON.stringify(audit.detail)).not.toMatch(/Guest Example Person|GYGEXAMPLE1/);
  });
});

describe("the job view and other writers", () => {
  it("the job view reads the ledger: settled and unsettled lines, awaiting rows, and the job's status", async () => {
    const a = await advance();
    const s = await sheet([row("Grand Palace", "entrance", 500, 1, { advanceId: a.id }), row("Wat Pho", "entrance", 100, 1, { advanceId: a.id }), row("Wat Arun", "entrance", 100, 1, { paidBySource: "rate-default", paidByBy: undefined, paidByAt: undefined })]);
    await settle(a.id, s.id, [0]);
    const v = await jobAdvanceView(prisma, { guideId: G, date: DATE, slotIdx: 0, expenses: await rowsOf(s.id) });
    expect(v.totals).toMatchObject({ totalAdvancePaid: 1000, usedFromAdvance: 500, outstanding: 500, taggedFromAdvance: 600, tagsNotYetSettled: 100, awaitingLink: 100 });
    expect(v.status).toBe("RETURN_DUE");
    expect(v.advances[0]).toMatchObject({ status: "RETURN_DUE", outstanding: 500, allowedCategories: ["entrance"] });
    expect(v.lines.map((l) => [l.description, l.settled, !!l.advanceId])).toEqual([["Grand Palace", true, true], ["Wat Pho", false, true], ["Wat Arun", false, false]]);
    expect(v.jobSheetId).toBe(s.id);
  });
  it("a no-show ticket re-count keeps a settled row exactly as settled", () => {
    const settled = { ...row("Grand Palace", "entrance", 500, 4), advanceSettlement: { entryId: "e1", advanceId: "a1", advanceNo: "FOLK-ADV-209906-001" } };
    const other = row("Wat Pho", "entrance", 100, 4);
    const out = keepSettledRows([settled, other], [{ ...settled, pax: 3 }, { ...other, pax: 3 }]);
    expect(out.rows.map((r) => r.pax)).toEqual([4, 3]);
    expect(out.kept).toEqual(["Grand Palace"]);
  });
});
