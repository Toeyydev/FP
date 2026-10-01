import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// The adversarial review's failure cases, kept as regressions (ADV1–ADV14). Real database,
// real reconciliation; push/LINE/email/calendar mocked. Rule under test throughout:
// WHEN IN DOUBT, NOTHING MOVES — a guest never lands on the wrong guide's job, and a job
// either follows its bookings completely or not at all. All data invented (public repo).

vi.hoisted(() => { process.env.BOOKING_RECONCILE_FLAG_SINCE = "2000-01-01"; });
vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPushToUser: vi.fn(async () => 0) }));
vi.mock("@/lib/line", async (orig) => ({ ...(await orig<typeof import("@/lib/line")>()), lineEnabled: false, linePush: vi.fn(async () => true), linePushFlex: vi.fn(async () => true) }));
vi.mock("@/lib/email", async (orig) => ({ ...(await orig<typeof import("@/lib/email")>()), sendEmail: vi.fn(async () => true) }));
vi.mock("@/lib/tour-calendar-sync", async (orig) => ({ ...(await orig<typeof import("@/lib/tour-calendar-sync")>()), removeTourEvents: vi.fn(async () => {}), pushTourToCalendars: vi.fn(async () => {}) }));

import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { importParsed, reconcileCollected, reconcileAssignedBookings, type DirtyBookings } from "@/lib/booking-import";
import { reconcileBookingChange, type Notifier } from "@/lib/booking-reconcile";
import { DEFAULT_EXPENSES, fillDownExpensePax, type Expense } from "@/lib/jobsheet";
import { toSheetBooking, type SheetBooking } from "@/lib/sheet-bookings";
import { productKey, type ParsedBooking } from "@/lib/bookings";

const DATE = new Date(Date.now() + 5 * 86400_000 + 7 * 3600_000).toISOString().slice(0, 10);
const A = "G-921", B = "G-922";
let opsUser: { id: string };
let guideA: { id: string };

type Over = Partial<{ status: string; tourId: string | null; assignedGuideId: string | null; slotIdx: number; date: string; source: string }>;
const mk = (ref: string, pax: number, over: Over = {}) => prisma.booking.create({ data: {
  source: over.source ?? "GetYourGuide", externalRef: ref, confirmationCode: `CODE-${ref}`, customerName: `Guest ${ref}`,
  date: over.date ?? DATE, slotIdx: over.slotIdx ?? 0, tourId: over.tourId === undefined ? "T-900" : over.tourId, pax,
  status: over.status ?? "OFFERED", assignedGuideId: over.assignedGuideId ?? null,
} });
const assign = (guideId: string, pax: number, over: { tourId?: string; slotIdx?: number } = {}) =>
  prisma.assignment.create({ data: { guideId, date: DATE, slotIdx: over.slotIdx ?? 0, tourId: over.tourId ?? "T-900", pax } });
const rowOf = (b: { externalRef: string | null; confirmationCode: string | null; customerName: string | null; pax: number | null }) => toSheetBooking(b);
async function sheet(guideId: string, bookings: { externalRef: string | null; confirmationCode: string | null; customerName: string | null; pax: number | null }[], over: Record<string, unknown> & { slotIdx?: number; tourId?: string; rows?: SheetBooking[] } = {}) {
  const { slotIdx, tourId, rows, ...rest } = over;
  const r = rows ?? bookings.map(rowOf);
  return prisma.jobSheet.create({ data: {
    ref: `FOLK-TEST-${guideId}-${slotIdx ?? 0}`, guideId, date: DATE, slotIdx: slotIdx ?? 0, tourId: tourId ?? "T-900", status: "Confirmed",
    bookings: r as never, expenses: fillDownExpensePax(DEFAULT_EXPENSES, r.reduce((s, x) => s + (x.bookedPax ?? 0), 0)) as never, ...rest,
  } });
}
const sheetOf = (guideId: string, slotIdx = 0) => prisma.jobSheet.findUniqueOrThrow({ where: { guideId_date_slotIdx: { guideId, date: DATE, slotIdx } } });
const refsOn = async (guideId: string, slotIdx = 0) => ((await sheetOf(guideId, slotIdx)).bookings as unknown as SheetBooking[]).map((r) => r.bookingNo);
const guestsOn = async (guideId: string, slotIdx = 0) => ((await sheetOf(guideId, slotIdx)).bookings as unknown as SheetBooking[]).reduce((s, r) => s + (r.bookedPax ?? 0), 0);
const paxOf = async (guideId: string, slotIdx = 0) => (await prisma.assignment.findFirstOrThrow({ where: { guideId, date: DATE, slotIdx } })).pax;
const statusOf = async (id: string) => (await prisma.booking.findUniqueOrThrow({ where: { id } })).status;
const issues = (code: string) => prisma.auditLog.findMany({ where: { action: "booking.reconciliation_required", detail: { path: ["code"], equals: code } } });
const qty = (exps: Expense[], name: string) => exps.find((e) => e.description.startsWith(name))?.pax ?? null;
const expOf = async (guideId: string) => ((await sheetOf(guideId)).expenses as unknown as Expense[]);
const lateNotices = () => prisma.notification.findMany({ where: { userId: opsUser.id, message: { startsWith: "LATE BOOKING" } } });
const guideNotices = () => prisma.notification.findMany({ where: { userId: guideA.id } });
const run = (id: string, over: Partial<Parameters<typeof reconcileBookingChange>[1]> = {}) => reconcileBookingChange(id, { source: "test", ...over });

beforeAll(() => { requireTestDatabase(); });
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  guideA = await seedGuide(A, { displayName: "Guide A Example" });
  await seedGuide(B, { displayName: "Guide B Example" });
  await prisma.tour.upsert({ where: { id: "T-901" }, update: {}, create: { id: "T-901", name: "Canal Walk Example", time: "08:30", durationMin: 120 } });
  opsUser = await prisma.user.create({ data: { email: "op-adv@example.test", displayName: "Op Example", role: "OPERATOR", state: "ACTIVE" } });
});

describe("ADV1 — an unmapped booking is never pulled onto a job sheet", () => {
  it("sheet has AAA; an UNMAPPED booking shares the slot; AAA 4 → 5: the sheet holds AAA only, UNMAPPED waits for review", async () => {
    await assign(A, 4);
    const aaa = await mk("AAA1", 4);
    await sheet(A, [aaa]);
    const unmapped = await mk("UNMAPPED1", 3, { tourId: null, status: "PENDING" });
    await prisma.booking.update({ where: { id: aaa.id }, data: { pax: 5 } });

    await run(aaa.id);
    expect(await refsOn(A)).toEqual(["AAA1"]);
    expect(await guestsOn(A)).toBe(5);
    expect(await paxOf(A)).toBe(5); // the unmapped guests are not counted into anyone's job
    expect(await statusOf(unmapped.id)).toBe("PENDING");
    const rv = await issues("BOOKING_JOB_MATCH_REVIEW_REQUIRED");
    expect(rv.filter((x) => x.entityId === unmapped.id)).toHaveLength(1);
    // Reused, not repeated.
    await run(aaa.id);
    expect((await issues("BOOKING_JOB_MATCH_REVIEW_REQUIRED")).filter((x) => x.entityId === unmapped.id)).toHaveLength(1);
  });
});

describe("ADV2 — a cancellation on a shared departure never copies another guide's guests", () => {
  it("A: AAA, B: BBB, CCC untagged; cancel AAA → A gets neither BBB nor CCC, B keeps BBB once, CCC waits", async () => {
    await assign(A, 4); await assign(B, 3);
    const aaa = await mk("AAA2", 4), bbb = await mk("BBB2", 3), ccc = await mk("CCC2", 2);
    await sheet(A, [aaa]); await sheet(B, [bbb]);
    await importParsed({ externalRef: "AAA2", confirmationCode: "CODE-AAA2", customerName: "Guest AAA2", date: DATE, slotIdx: 0, pax: 4 }, { source: "GetYourGuide", cancelled: true, via: "webhook" });

    expect(await statusOf(aaa.id)).toBe("CANCELLED");
    expect(await refsOn(A)).not.toContain("BBB2");
    expect(await refsOn(A)).not.toContain("CCC2");
    expect((await refsOn(B)).filter((r) => r === "BBB2")).toHaveLength(1);
    expect(await refsOn(B)).not.toContain("CCC2");
    expect(await statusOf(ccc.id)).toBe("OFFERED"); // untouched
    expect((await issues("BOOKING_JOB_MATCH_REVIEW_REQUIRED")).some((x) => x.entityId === ccc.id)).toBe(true);
    // CCC could be either guide's, so neither job is recounted.
    expect(await paxOf(A)).toBe(4);
    expect(await paxOf(B)).toBe(3);
    // B was never told about A's guest.
    const bUser = await prisma.user.findFirstOrThrow({ where: { guideId: B } });
    expect(await prisma.notification.count({ where: { userId: bUser.id } })).toBe(0);
    void bbb;
  });

  it("the same departure with every guest placed: the cancelled row leaves A's sheet, B is untouched", async () => {
    await assign(A, 4); await assign(B, 3);
    const aaa = await mk("AAA3", 4), keep = await mk("KEEP3", 2), bbb = await mk("BBB3", 3);
    await sheet(A, [aaa, keep]); await sheet(B, [bbb]);
    const bBefore = JSON.stringify(await sheetOf(B));
    await prisma.booking.update({ where: { id: aaa.id }, data: { status: "CANCELLED" } });
    await run(aaa.id);
    expect(await refsOn(A)).toEqual(["KEEP3"]);
    expect(await paxOf(A)).toBe(2);
    expect(JSON.stringify(await sheetOf(B))).toBe(bBefore);
    expect(await paxOf(B)).toBe(3);
  });
});

describe("ADV3 / 1 Jan 2027 shape — the whole departure is reconciled to its final state in one step", () => {
  it("active 4 + stale cancelled 2 on the sheet (6), late pending 4 → 8 directly, one notice", async () => {
    await assign(A, 4);
    const old2 = await mk("OLD2", 2, { status: "CANCELLED" });
    const live4 = await mk("LIVE4", 4);
    await sheet(A, [old2, live4]);
    const late = await mk("LATE4", 4, { status: "PENDING" });

    const r = await run(late.id);
    expect(r).toMatchObject({ kind: "reconciled", guideId: A });
    expect(await refsOn(A)).toEqual(["LIVE4", "LATE4"]);
    expect(await guestsOn(A)).toBe(8);
    expect(await paxOf(A)).toBe(8);
    expect(await statusOf(late.id)).toBe("OFFERED");
    expect(qty(await expOf(A), "Water")).toBe(9); // 8 guests + 1 guide
    expect(qty(await expOf(A), "Grand Palace")).toBe(8);
    const changes = await prisma.auditLog.findMany({ where: { action: "jobsheet.expected_pax_changed" } });
    expect(changes.map((c) => [(c.detail as { oldExpectedPax: number }).oldExpectedPax, (c.detail as { newExpectedPax: number }).newExpectedPax])).toEqual([[6, 8]]);
    const notices = await lateNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain("Expected guests: 6 → 8");
    expect(notices[0].message).not.toMatch(/→ 10\b/);
    expect((await guideNotices()).filter((n) => n.message.includes("6 → 8"))).toHaveLength(1);

    // Again: nothing more.
    await run(late.id); await run(old2.id); await run(live4.id);
    expect(await lateNotices()).toHaveLength(1);
    expect(await guideNotices()).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { action: "jobsheet.expected_pax_changed" } })).toBe(1);
  });
});

describe("ADV4 — a blocked job is not partly changed", () => {
  it("PEAK document on the sheet + a late booking: not placed, expected pax unchanged, sheet unchanged", async () => {
    await assign(A, 4);
    const aaa = await mk("AAA4", 4);
    await sheet(A, [aaa], { peakDocumentNo: "EXP-TEST-0001" });
    const before = JSON.stringify(await sheetOf(A));
    const late = await mk("LATE42", 2, { status: "PENDING" });
    const r = await run(late.id);
    expect(r.kind).toBe("blocked");
    expect(await statusOf(late.id)).toBe("PENDING");
    expect(await paxOf(A)).toBe(4);
    expect(JSON.stringify(await sheetOf(A))).toBe(before);
    const blocked = await issues("BOOKING_RECONCILIATION_BLOCKED");
    expect(blocked).toHaveLength(1);
    expect(JSON.stringify(blocked[0].detail)).toContain("EXP-TEST-0001");
  });

  it("a paid job with no sheet: the expected pax is not recounted either", async () => {
    await assign(A, 4);
    await mk("AAA5", 4);
    await prisma.tourPayment.create({ data: { guideId: A, date: DATE, slotIdx: 0, tourId: "T-900", status: "PAID", paidAt: new Date() } });
    const late = await mk("LATE52", 2, { status: "PENDING" });
    expect((await run(late.id)).kind).toBe("blocked");
    expect(await statusOf(late.id)).toBe("PENDING");
    expect(await paxOf(A)).toBe(4);
  });
});

describe("ADV5 — an approved sheet is never changed behind the approval", () => {
  it("approved sheet + a late booking: nothing changes, the job is flagged for review", async () => {
    await assign(A, 4);
    const aaa = await mk("AAA6", 4);
    await sheet(A, [aaa], { approvalStatus: "APPROVED", approvedAt: new Date() });
    const before = JSON.stringify(await sheetOf(A));
    const late = await mk("LATE62", 2, { status: "PENDING" });
    const r = await run(late.id);
    expect(r).toMatchObject({ kind: "review-required", code: "BOOKING_RECONCILIATION_REVIEW_REQUIRED" });
    expect(JSON.stringify(await sheetOf(A))).toBe(before);
    expect((await sheetOf(A)).approvalStatus).toBe("APPROVED");
    expect(await statusOf(late.id)).toBe("PENDING");
    expect(await paxOf(A)).toBe(4);
    expect(await issues("BOOKING_RECONCILIATION_REVIEW_REQUIRED")).toHaveLength(1);
  });
});

describe("ADV6 — a booking moved to another slot leaves its old job and joins the new one", () => {
  beforeEach(async () => {
    await prisma.productMap.deleteMany({});
    await prisma.productMap.create({ data: { productKey: productKey("Riverside Temples"), productName: "Riverside Temples", tourId: "T-900" } });
  });
  const moveTo = (slotIdx: number) => importParsed({ externalRef: "MOVE6", confirmationCode: "CODE-MOVE6", customerName: "Guest MOVE6", date: DATE, slotIdx, pax: 2, productName: "Riverside Temples" } as ParsedBooking, { source: "GetYourGuide", cancelled: false, via: "webhook" });

  it("08:30 → the next slot: off A's 08:30 sheet, onto B's sheet at the new slot, both counts follow", async () => {
    await assign(A, 6); await assign(B, 3, { slotIdx: 1 });
    const aaa = await mk("AAA7", 4), mover = await mk("MOVE6", 2), bbb = await mk("BBB7", 3, { slotIdx: 1 });
    await sheet(A, [aaa, mover]); await sheet(B, [bbb], { slotIdx: 1 });
    await moveTo(1);
    expect(await refsOn(A)).toEqual(["AAA7"]);
    expect(await paxOf(A)).toBe(4);
    expect(await refsOn(B, 1)).toEqual(["BBB7", "MOVE6"]);
    expect(await paxOf(B, 1)).toBe(5);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: "jobsheet.booking_removed" } })).detail).toMatchObject({ row: "MOVE6", why: expect.stringContaining("moved to") });
  });

  it("the old sheet is approved: the booking stays there and is NOT added to the new job — both flagged", async () => {
    await assign(A, 6); await assign(B, 3, { slotIdx: 1 });
    const aaa = await mk("AAA8", 4), mover = await mk("MOVE6", 2), bbb = await mk("BBB8", 3, { slotIdx: 1 });
    await sheet(A, [aaa, mover], { approvalStatus: "APPROVED" }); await sheet(B, [bbb], { slotIdx: 1 });
    await moveTo(1);
    expect(await refsOn(A)).toEqual(["AAA8", "MOVE6"]);
    expect(await refsOn(B, 1)).toEqual(["BBB8"]); // never listed twice
    expect(await paxOf(B, 1)).toBe(3);
    expect((await issues("BOOKING_MOVED_REVIEW_REQUIRED")).length).toBeGreaterThanOrEqual(1);
  });
});

describe("ADV7 — a booking moved to another tour at the same time", () => {
  it("T-900 → T-901: off A's T-900 sheet, onto B's T-901 sheet", async () => {
    await assign(A, 6); await assign(B, 3, { tourId: "T-901" });
    const aaa = await mk("AAA9", 4), swap = await mk("SWAP9", 2), ccc = await mk("CCC9", 3, { tourId: "T-901" });
    await sheet(A, [aaa, swap]); await sheet(B, [ccc], { tourId: "T-901" });
    await prisma.booking.update({ where: { id: swap.id }, data: { tourId: "T-901" } });
    await run(swap.id);
    expect(await refsOn(A)).toEqual(["AAA9"]);
    expect(await refsOn(B)).toEqual(["CCC9", "SWAP9"]);
    expect(await paxOf(A)).toBe(4);
    expect(await paxOf(B)).toBe(5);
  });

  it("the guide already recorded attendance on the row: nothing moves, review required", async () => {
    await assign(A, 6); await assign(B, 3, { tourId: "T-901" });
    const aaa = await mk("AAA10", 4), swap = await mk("SWAP10", 2), ccc = await mk("CCC10", 3, { tourId: "T-901" });
    await sheet(A, [], { rows: [rowOf(aaa), { ...rowOf(swap), actualPax: 2 }] }); await sheet(B, [ccc], { tourId: "T-901" });
    await prisma.booking.update({ where: { id: swap.id }, data: { tourId: "T-901" } });
    const r = await run(swap.id);
    expect(r.kind).toBe("review-required");
    expect(await refsOn(A)).toEqual(["AAA10", "SWAP10"]);
    expect(await refsOn(B)).toEqual(["CCC10"]);
    expect(await paxOf(B)).toBe(3);
  });
});

describe("ADV8 — an older event arriving late never reverts a newer state", () => {
  it("cancelled, then a stale 'live, 5 pax' payload: ignored and audited; the job keeps the cancellation", async () => {
    await assign(A, 6);
    const aaa = await mk("AAA11", 4), bbb = await mk("BBB11", 2);
    await sheet(A, [aaa, bbb]);
    const payload = (pax: number) => ({ externalRef: "BBB11", confirmationCode: "CODE-BBB11", customerName: "Guest BBB11", date: DATE, slotIdx: 0, pax });
    await importParsed(payload(2), { source: "GetYourGuide", cancelled: true, via: "webhook" });
    expect(await refsOn(A)).toEqual(["AAA11"]);
    const r = await importParsed(payload(5), { source: "GetYourGuide", cancelled: false, via: "webhook" });
    expect(r).toBe("skipped");
    const after = await prisma.booking.findUniqueOrThrow({ where: { id: bbb.id } });
    expect(after.status).toBe("CANCELLED");
    expect(after.pax).toBe(2);
    expect(await prisma.auditLog.count({ where: { action: "booking.stale_update_ignored", entityId: bbb.id } })).toBe(1);
    expect(await refsOn(A)).toEqual(["AAA11"]);
    expect(await paxOf(A)).toBe(4);
  });
});

describe("ADV9 — two booking changes at once", () => {
  it("two late bookings reconciled concurrently: both placed once, the count is right, one notice", async () => {
    await assign(A, 6);
    const aaa = await mk("AAA12", 4), bbb = await mk("BBB12", 2);
    await sheet(A, [aaa, bbb]);
    const l1 = await mk("LATE121", 2, { status: "PENDING" }), l2 = await mk("LATE122", 3, { status: "PENDING" });
    await Promise.all([run(l1.id), run(l2.id)]);
    const refs = await refsOn(A);
    expect([...refs].sort()).toEqual(["AAA12", "BBB12", "LATE121", "LATE122"]);
    expect(await guestsOn(A)).toBe(11);
    expect(await paxOf(A)).toBe(11);
    expect(await statusOf(l1.id)).toBe("OFFERED");
    expect(await statusOf(l2.id)).toBe("OFFERED");
    const n = await lateNotices();
    expect(n).toHaveLength(1);
    expect(n[0].message).toContain("6 → 11");
  });
});

describe("ADV10 — an operator saving the sheet while it is reconciled", () => {
  it("a save made before the reconciliation is read and kept; one made during it waits, then is refused as stale", async () => {
    await assign(A, 6);
    const aaa = await mk("AAA13", 4), bbb = await mk("BBB13", 2);
    const s = await sheet(A, [aaa, bbb]);
    // Saved before: an operator's typed water count and note.
    const typed = (await expOf(A)).map((e) => (e.description.startsWith("Water") ? { ...e, pax: 12 } : e));
    await prisma.jobSheet.update({ where: { id: s.id }, data: { operatorNote: "bring flags", expenses: typed as never } });
    const v1 = (await sheetOf(A)).updatedAt;
    const late = await mk("LATE13", 2, { status: "PENDING" });
    // Saved during: the job-sheet save's own fenced write (updatedAt in the WHERE), issued
    // while the reconciliation holds the sheet. It must wait, and then not overwrite.
    let during: Promise<{ count: number }> | null = null;
    const r = await run(late.id, { beforeWrite: async (attempt) => {
      if (attempt !== 1) return;
      // .then() makes it run NOW: a Prisma query is lazy and would otherwise not start until awaited.
      during = prisma.jobSheet.updateMany({ where: { id: s.id, updatedAt: v1 }, data: { operatorNote: "a later edit" } }).then((x) => x);
      await new Promise((res) => setTimeout(res, 150));
    } });
    expect(r.kind).toBe("reconciled");
    expect((await during!).count).toBe(0); // refused: the operator reloads — nothing silently lost
    const after = await sheetOf(A);
    expect(after.operatorNote).toBe("bring flags");
    expect(await refsOn(A)).toEqual(["AAA13", "BBB13", "LATE13"]);
    expect(qty(await expOf(A), "Water")).toBe(12); // the operator's number, kept
    expect(qty(await expOf(A), "Ferry")).toBe(9);
    expect(await paxOf(A)).toBe(8);
  });

  it("the departure changes under it twice: nothing at all is written, and a conflict is raised for review", async () => {
    await seedGuide("G-923"); await seedGuide("G-924");
    await assign(A, 6);
    const aaa = await mk("AAA14", 4), bbb = await mk("BBB14", 2);
    await sheet(A, [aaa, bbb]);
    const late = await mk("LATE14", 2, { status: "PENDING" });
    const extra = ["G-923", "G-924"];
    const r = await run(late.id, { beforeWrite: async (attempt) => { await assign(extra[attempt - 1], 0, { tourId: "T-901" }); } });
    expect(r.kind).toBe("conflict");
    expect(await statusOf(late.id)).toBe("PENDING");
    expect(await paxOf(A)).toBe(6);
    expect(await refsOn(A)).toEqual(["AAA14", "BBB14"]);
    expect(await prisma.auditLog.count({ where: { action: { in: ["jobsheet.booking_added", "assignment.booking_sync", "booking.reconciled"] } } })).toBe(0);
    expect(await issues("BOOKING_RECONCILIATION_CONFLICT")).toHaveLength(1);
    expect(await lateNotices()).toHaveLength(0);
  });
});

describe("ADV11 — several guides on one tour and no guest split", () => {
  it("a new booking is not placed on either, and neither job is recounted", async () => {
    await assign(A, 4); await assign(B, 2);
    await mk("X15", 4); await mk("Y15", 2);
    const z = await mk("Z15", 3, { status: "PENDING" });
    const r = await run(z.id);
    expect(r).toMatchObject({ kind: "review-required", code: "BOOKING_JOB_MATCH_REVIEW_REQUIRED" });
    expect(await statusOf(z.id)).toBe("PENDING");
    expect(await paxOf(A)).toBe(4);
    expect(await paxOf(B)).toBe(2);
  });
});

describe("ADV12 — a booking another guide's job already holds", () => {
  it("BBB is on B's sheet but tagged to A: neither job changes, review required", async () => {
    await assign(A, 4); await assign(B, 3);
    const aaa = await mk("AAA16", 4), bbb = await mk("BBB16", 3, { assignedGuideId: A });
    await sheet(A, [aaa]); await sheet(B, [bbb]);
    const r = await run(bbb.id);
    expect(r.kind).toBe("review-required");
    expect(await refsOn(A)).toEqual(["AAA16"]);
    expect(await refsOn(B)).toEqual(["BBB16"]);
    expect(await paxOf(A)).toBe(4);
    expect(await paxOf(B)).toBe(3);
  });

  it("a booking on two guides' sheets: neither is touched", async () => {
    await assign(A, 4); await assign(B, 3);
    const dup = await mk("DUP17", 2);
    await sheet(A, [dup]); await sheet(B, [dup]);
    await prisma.booking.update({ where: { id: dup.id }, data: { pax: 3 } });
    expect((await run(dup.id)).kind).toBe("review-required");
    expect(await guestsOn(A)).toBe(2);
    expect(await guestsOn(B)).toBe(2);
  });
});

describe("ADV13 — a person's confirmation on an expense row is never overwritten", () => {
  it("operator-chosen payer on Water, a payer stamp on Bus: both kept, others follow, review raised", async () => {
    await assign(A, 6);
    const aaa = await mk("AAA18", 4), bbb = await mk("BBB18", 2);
    const s = await sheet(A, [aaa, bbb]);
    const exps = (s.expenses as unknown as Expense[]).map((e) =>
      e.description.startsWith("Water") ? { ...e, paidBy: "company", paidBySource: "operator" as const }
      : e.description.startsWith("Bus") ? { ...e, paidBy: "guide", paidByBy: "op-user", paidByAt: "2030-01-01T00:00:00.000Z" }
      : e);
    await prisma.jobSheet.update({ where: { id: s.id }, data: { expenses: exps as never } });
    const late = await mk("LATE18", 2, { status: "PENDING" });
    await run(late.id);
    const after = await expOf(A);
    expect(qty(after, "Water")).toBe(7); // kept
    expect(qty(after, "Bus")).toBe(7); // kept
    expect(qty(after, "Ferry")).toBe(9); // system fill-down → follows
    expect(after.find((e) => e.description.startsWith("Water"))).toMatchObject({ paidBy: "company", paidBySource: "operator" });
    const review = await issues("EXPENSE_COUNT_REVIEW");
    expect(review).toHaveLength(1);
    expect(JSON.stringify(review[0].detail)).toContain("confirmed by a person");
  });
});

describe("ADV14 — a notice that fails to send never undoes correct data", () => {
  it("both notifiers throw: the job is updated, the failure is recorded", async () => {
    await assign(A, 6);
    const aaa = await mk("AAA19", 4), bbb = await mk("BBB19", 2);
    await sheet(A, [aaa, bbb]);
    const late = await mk("LATE19", 2, { status: "PENDING" });
    const broken: Notifier = { ops: async () => { throw new Error("push service down"); }, guide: async () => { throw new Error("LINE down"); } };
    const r = await run(late.id, { notifier: broken });
    expect(r.kind).toBe("reconciled");
    expect(await statusOf(late.id)).toBe("OFFERED");
    expect(await guestsOn(A)).toBe(8);
    expect(await paxOf(A)).toBe(8);
    const failed = await prisma.auditLog.findMany({ where: { action: "booking.notification_failed" } });
    expect(failed.map((f) => (f.detail as { channel: string }).channel).sort()).toEqual(["guide", "ops"]);
  });
});

describe("batch paths — the autosync, the manual sync, CSV and the sweep reconcile each departure once", () => {
  beforeEach(async () => {
    await prisma.productMap.deleteMany({});
    await prisma.productMap.create({ data: { productKey: productKey("Riverside Temples"), productName: "Riverside Temples", tourId: "T-900" } });
  });
  const late = (ref: string, pax: number): ParsedBooking => ({ externalRef: ref, confirmationCode: `CODE-${ref}`, customerName: `Guest ${ref}`, date: DATE, slotIdx: 0, pax, productName: "Riverside Temples" });

  it("a batch import collects, then one reconciliation per departure: one transition, one notice", async () => {
    await assign(A, 6);
    const aaa = await mk("AAA20", 4), bbb = await mk("BBB20", 2);
    await sheet(A, [aaa, bbb]);
    const dirty: DirtyBookings = new Map();
    await importParsed(late("LATE201", 2), { source: "GetYourGuide", cancelled: false, via: "autosync", collect: dirty });
    await importParsed(late("LATE202", 3), { source: "GetYourGuide", cancelled: false, via: "autosync", collect: dirty });
    expect(await refsOn(A)).toEqual(["AAA20", "BBB20"]); // nothing until the batch is reconciled
    await reconcileCollected(dirty, "autosync");
    expect(await refsOn(A)).toEqual(["AAA20", "BBB20", "LATE201", "LATE202"]);
    expect(await paxOf(A)).toBe(11);
    expect(await prisma.auditLog.count({ where: { action: "jobsheet.expected_pax_changed" } })).toBe(1);
    const n = await lateNotices();
    expect(n).toHaveLength(1);
    expect(n[0].message).toContain("6 → 11");
  });

  it("the sweep places a pending booking a single guide's job can take, and leaves an ambiguous departure alone", async () => {
    await assign(A, 4);
    const aaa = await mk("AAA21", 4);
    await sheet(A, [aaa]);
    const p = await mk("PEND21", 2, { status: "PENDING" });
    // Slot 1: two guides on one tour, no split — nobody's job may be recounted.
    await assign(A, 4, { slotIdx: 1 }); await assign(B, 2, { slotIdx: 1 });
    const q = await mk("PEND22", 3, { status: "PENDING", slotIdx: 1 });
    await reconcileAssignedBookings(true);
    expect(await statusOf(p.id)).toBe("OFFERED");
    expect(await refsOn(A)).toEqual(["AAA21", "PEND21"]);
    expect(await paxOf(A)).toBe(6);
    expect(await statusOf(q.id)).toBe("PENDING");
    expect(await paxOf(A, 1)).toBe(4);
    expect(await paxOf(B, 1)).toBe(2);
  });

  it("a job dispatched with no booking in FolkOPS keeps the pax the operator gave it", async () => {
    await assign(A, 5); // a private tour: no booking rows at all
    await reconcileAssignedBookings(true);
    expect(await paxOf(A)).toBe(5);
    const other = await mk("OTHER23", 2, { tourId: "T-901" }); // another tour's booking at the same time
    await run(other.id);
    expect(await paxOf(A)).toBe(5);
  });
});
