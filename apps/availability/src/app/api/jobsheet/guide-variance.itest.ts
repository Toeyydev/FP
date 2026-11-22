import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// Water / Bus / Ferry: the guide's report fills the job's rows; the office corrects Price or Qty
// only with a reason; a later report never overwrites — or half-overwrites — that correction;
// nothing recalculates the verified Qty (owner, 22 Nov 2026). Real database, real routes; only
// the session and outbound channels are stubbed. All data invented — this repo is public.
vi.hoisted(() => { process.env.BOOKING_RECONCILE_FLAG_SINCE = "2000-01-01"; });
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPushToUser: vi.fn(async () => 0) }));
vi.mock("@/lib/line", async (orig) => ({ ...(await orig<typeof import("@/lib/line")>()), lineEnabled: false, linePush: vi.fn(async () => true) }));
vi.mock("@/lib/email", async (orig) => ({ ...(await orig<typeof import("@/lib/email")>()), sendEmail: vi.fn(async () => true) }));
vi.mock("@/lib/jobsheet-drive", async (orig) => ({ ...(await orig<typeof import("@/lib/jobsheet-drive")>()), saveJobSheetToDrive: vi.fn(async () => null) }));
vi.mock("@/lib/tour-calendar-sync", async (orig) => ({ ...(await orig<typeof import("@/lib/tour-calendar-sync")>()), removeTourEvents: vi.fn(async () => {}), pushTourToCalendars: vi.fn(async () => {}) }));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { PUT } from "./route";
import { POST as approve } from "./approve/route";
import { submitGuideExpenses } from "@/lib/guide-expenses";
import { reconcileDeparture } from "@/lib/booking-reconcile";

const G = "G-951";
const DATE = new Date(Date.now() + 3 * 86400_000 + 7 * 3600_000).toISOString().slice(0, 10);
const KEY = { guideId_date_slotIdx: { guideId: G, date: DATE, slotIdx: 0 } };
const W = "Water (Inc. Guide)", B = "Bus (Inc. Guide)", F = "Ferry (Inc. Guide)";
type Row = Record<string, unknown> & { description: string; price: number; pax: number; rowId?: string; guideReported?: { price: number; qty: number }; guideVarianceReason?: string };

const asOperator = (id = "u_ops") => authMock.auth.mockResolvedValue({ user: { id, role: "OPERATOR" } });
const report = (items: [string, number, number][]) => submitGuideExpenses({ guideId: G, date: DATE, slotIdx: 0, actorId: "u_guide", actorRole: "GUIDE",
  expenses: items.map(([description, price, pax]) => ({ description, price, pax })) as never });
const rowsNow = async () => ((await prisma.jobSheet.findUniqueOrThrow({ where: KEY })).expenses as unknown as Row[]);
const byDesc = (rows: Row[], d: string) => rows.find((r) => r.description === d)!;
const pq = (rows: Row[], d: string) => { const r = byDesc(rows, d); return `${r.price}x${r.pax}`; };
const save = async (expenses: Row[]) => {
  const res = await PUT(new Request("https://ops.example.test/api/jobsheet", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [], guideFee: { price: 1200, time: 1, whtPct: 3 }, expenses }),
  }) as unknown as Parameters<typeof PUT>[0]);
  return { status: res.status, body: await res.json() };
};
/** The rows as the browser has them, with one row edited. */
const edit = async (d: string, over: Partial<Row>) => (await rowsNow()).map((r) => (r.description === d ? { ...r, ...over } : r));
const variance = () => prisma.auditLog.findMany({ where: { action: "jobsheet.guide_variance" }, orderBy: { createdAt: "asc" } });

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  await seedGuide(G);
  await prisma.tour.upsert({ where: { id: "T-900" }, update: {}, create: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180 } });
  await prisma.assignment.create({ data: { guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", pax: 6 } });
  await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-GV-01", guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", guideFee: { price: 1200, time: 1, whtPct: 3 },
    bookings: [{ name: "Guest A", bookingNo: "GV-A", bookedPax: 6, actualPax: null, tickets: "", status: "" }],
    expenses: [
      { rowId: "r_aaaaaaaaaaaa", description: W, expenseType: "meal", price: 10, pax: 7 },
      { rowId: "r_bbbbbbbbbbbb", description: B, expenseType: "transport", price: 15, pax: 7 },
      { rowId: "r_cccccccccccc", description: F, expenseType: "transport", price: 8, pax: 7 },
    ] } });
  asOperator();
});

describe("the guide's report fills the rows", () => {
  it("each item keeps its own Price and Qty — Ferry 5 and Water 7 — with the guide's snapshot", async () => {
    await report([[W, 10, 7], [B, 13, 4], [F, 6, 5]]);
    const rows = await rowsNow();
    expect([pq(rows, W), pq(rows, B), pq(rows, F)]).toEqual(["10x7", "13x4", "6x5"]);
    expect(byDesc(rows, F).guideReported).toMatchObject({ price: 6, qty: 5 });
    expect(byDesc(rows, W).guideReported).toMatchObject({ price: 10, qty: 7 });
  });
});

describe("the office corrects Price or Qty — with a reason, enforced by the server", () => {
  beforeEach(async () => { await report([[W, 10, 7], [B, 15, 6], [F, 8, 5]]); });

  it("15 × 6 → 30 × 3 with no reason is refused (same ฿90 total) and nothing is written", async () => {
    const r = await save(await edit(B, { price: 30, pax: 3 }));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("guide-variance");
    expect(r.body.detail).toMatch(/Bus.*price and qty/);
    expect(pq(await rowsNow(), B)).toBe("15x6");
  });

  it("the same with a reason is saved, and the audit has the guide's and the office's Price and Qty, what changed, the reason, who and when", async () => {
    const r = await save(await edit(B, { price: 30, pax: 3, guideVarianceReason: "One leg by boat" }));
    expect(r.status).toBe(200);
    const row = byDesc(await rowsNow(), B);
    expect(row).toMatchObject({ price: 30, pax: 3, guideVarianceReason: "One leg by boat", guideReported: { price: 15, qty: 6 } });
    const [a] = await variance();
    expect(a.actorId).toBe("u_ops");
    expect(a.createdAt).toBeInstanceOf(Date);
    expect((a.detail as { changes: unknown[] }).changes).toEqual([{ item: B, rowId: "r_bbbbbbbbbbbb", guide: { price: 15, qty: 6 }, before: { price: 15, qty: 6 }, after: { price: 30, qty: 3 }, changed: ["price", "qty"], reason: "One leg by boat" }]);
  });

  it("Price only, and Qty only, each need a reason", async () => {
    expect((await save(await edit(W, { price: 12 }))).body.detail).toMatch(/Water.*price differs/);
    expect((await save(await edit(F, { pax: 4 }))).body.detail).toMatch(/Ferry.*qty differs/);
    expect((await save(await edit(F, { pax: 4, guideVarianceReason: "Two guests left before the ferry" }))).status).toBe(200);
    expect(((await variance())[0].detail as { changes: { changed: string[] }[] }).changes[0].changed).toEqual(["qty"]);
  });

  it("a reason of only spaces is refused", async () => {
    expect((await save(await edit(F, { pax: 4, guideVarianceReason: "    " }))).status).toBe(400);
  });

  it("put back to the guide's figures: no reason needed, and the old reason goes", async () => {
    await save(await edit(F, { pax: 4, guideVarianceReason: "Two left" }));
    const r = await save(await edit(F, { pax: 5, guideVarianceReason: "" }));
    expect(r.status).toBe(200);
    expect(byDesc(await rowsNow(), F)).not.toHaveProperty("guideVarianceReason");
  });

  it("a request cannot forge or drop the guide's snapshot", async () => {
    const forged = (await rowsNow()).map((r) => (r.description === B ? { ...r, guideReported: { price: 30, qty: 3, at: "x" }, price: 30, pax: 3 } : r));
    expect((await save(forged)).status).toBe(400); // still compared with the real report
    expect(byDesc(await rowsNow(), B).guideReported).toMatchObject({ price: 15, qty: 6 });
  });

  it("saving with nothing changed asks for nothing and keeps every snapshot", async () => {
    const before = await rowsNow();
    expect((await save(before)).status).toBe(200);
    expect((await rowsNow()).map((r) => r.guideReported)).toEqual(before.map((r) => r.guideReported));
  });
});

describe("a later guide report", () => {
  beforeEach(async () => { await report([[W, 10, 7], [B, 15, 6], [F, 8, 5]]); });

  it("updates the rows the office has not touched", async () => {
    await report([[W, 10, 6], [B, 15, 6], [F, 8, 4]]);
    const rows = await rowsNow();
    expect([pq(rows, W), pq(rows, F)]).toEqual(["10x6", "8x4"]);
  });

  it("never overwrites a row whose Qty the office changed — nor mixes in the guide's new Price", async () => {
    await save(await edit(B, { pax: 4, guideVarianceReason: "Two walked" }));
    await report([[W, 10, 7], [B, 20, 6], [F, 8, 5]]);
    expect(byDesc(await rowsNow(), B)).toMatchObject({ price: 15, pax: 4, guideVarianceReason: "Two walked", guideReported: { price: 20, qty: 6 } });
  });

  it("never overwrites a row whose Price the office changed — nor mixes in the guide's new Qty", async () => {
    await save(await edit(F, { price: 10, guideVarianceReason: "Fare went up" }));
    await report([[W, 10, 7], [B, 15, 6], [F, 8, 3]]);
    expect(pq(await rowsNow(), F)).toBe("10x5");
  });

  it("the same report twice is idempotent — no row moves, no change recorded", async () => {
    const before = await rowsNow();
    await report([[W, 10, 7], [B, 15, 6], [F, 8, 5]]);
    expect(await rowsNow()).toEqual(before);
    const last = (await prisma.auditLog.findMany({ where: { action: "jobsheet.guide_expenses" }, orderBy: { createdAt: "desc" }, take: 1 }))[0];
    expect((last.detail as { rowsChanged: unknown[] }).rowsChanged).toEqual([]);
  });

  it("two reports at once: the rows end as ONE of them, never a mix, and the snapshot matches the rows", async () => {
    await Promise.all([report([[W, 10, 6], [B, 15, 5], [F, 8, 4]]), report([[W, 11, 7], [B, 16, 6], [F, 9, 5]])]);
    const rows = await rowsNow();
    const got = [pq(rows, W), pq(rows, B), pq(rows, F)].join(" ");
    expect(["10x6 15x5 8x4", "11x7 16x6 9x5"]).toContain(got);
    for (const d of [W, B, F]) expect(byDesc(rows, d).guideReported).toMatchObject({ price: byDesc(rows, d).price, qty: byDesc(rows, d).pax });
  });

  it("a report racing an office save never undoes the office's correction", async () => {
    const edited = await edit(B, { pax: 4, guideVarianceReason: "Two walked" });
    const [s] = await Promise.all([save(edited), report([[W, 10, 7], [B, 15, 5], [F, 8, 5]])]);
    const row = byDesc(await rowsNow(), B);
    if (s.status === 200) expect(row).toMatchObject({ price: 15, pax: 4 }); // the save won, then the report kept it
    else expect(s.body.error).toBe("stale");                               // the report won first; the office is told to reload
  });
});

describe("nothing recalculates the verified Qty", () => {
  beforeEach(async () => { await report([[W, 10, 7], [B, 15, 6], [F, 8, 5]]); });

  it("Save, Approval and a booking change leave Water 7, Bus 6, Ferry 5", async () => {
    // The office confirms who paid (the guide) and saves — Qty untouched.
    expect((await save((await rowsNow()).map((r) => ({ ...r, paidBy: "guide", paidBySource: "operator" })))).status).toBe(200);
    const { updatedAt } = await prisma.jobSheet.findUniqueOrThrow({ where: KEY });
    const ap = await approve(new NextRequest("http://test.local/api/jobsheet/approve", { method: "POST", body: JSON.stringify({ guideId: G, date: DATE, slotIdx: 0, approve: true, reviewedUpdatedAt: updatedAt.toISOString() }), headers: { "content-type": "application/json" } }));
    expect(ap.status, JSON.stringify(await ap.clone().json())).toBe(200);
    expect((await prisma.jobSheet.findUniqueOrThrow({ where: KEY })).approvalStatus).toBe("APPROVED");
    const approvedRows = await rowsNow();
    expect([pq(approvedRows, W), pq(approvedRows, B), pq(approvedRows, F)]).toEqual(["10x7", "15x6", "8x5"]);
    await prisma.jobSheet.update({ where: KEY, data: { approvalStatus: null } });
    await prisma.booking.create({ data: { source: "GetYourGuide", externalRef: "GV-NEW", confirmationCode: "CODE-GV-NEW", customerName: "Guest New", date: DATE, slotIdx: 0, tourId: "T-900", pax: 3, status: "OFFERED", assignedGuideId: G } });
    await reconcileDeparture({ date: DATE, slotIdx: 0 }, { source: "test", notifier: { ops: async () => {}, guide: async () => {} } });
    const rows = await rowsNow();
    expect([pq(rows, W), pq(rows, B), pq(rows, F)]).toEqual(["10x7", "15x6", "8x5"]);
  });
});

describe("rows saved before row ids existed", () => {
  it("get an id with the guide's snapshot, and a change still needs a reason after Save", async () => {
    const plain = (await rowsNow()).map((r) => { const { rowId: _i, ...x } = r; void _i; return x; });
    await prisma.jobSheet.update({ where: KEY, data: { expenses: plain as object[] } });
    await report([[W, 10, 7], [B, 15, 6], [F, 8, 5]]);
    const rows = await rowsNow();
    expect(rows.every((r) => /^r_[0-9a-f]{12}$/.test(String(r.rowId)))).toBe(true);
    const r = await save(rows.map((x) => (x.description === B ? { ...x, price: 30, pax: 3 } : x)));
    expect(r.status).toBe(400);
    // …and a browser copy that lost the ids cannot shed the snapshot either.
    const r2 = await save(rows.map((x) => { const { rowId: _i, ...y } = x; void _i; return y.description === B ? { ...y, price: 30, pax: 3 } : y; }) as Row[]);
    expect(r2.status).toBe(400);
    expect(byDesc(await rowsNow(), B)).toMatchObject({ price: 15, pax: 6, guideReported: { price: 15, qty: 6 } });
  });
});

describe("older sheets", () => {
  it("rows with no guide snapshot open and save as before — no reason asked, nothing inferred", async () => {
    const rows = await rowsNow(); // seeded, never reported
    const r = await save(rows.map((x) => (x.description === F ? { ...x, pax: 3 } : x)));
    expect(r.status).toBe(200);
    expect(byDesc(await rowsNow(), F)).not.toHaveProperty("guideReported");
    expect(await variance()).toEqual([]);
  });
});
