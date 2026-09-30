import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// Round-2 review fixes, kept as regressions. Real database and real reconciliation; the
// outside world (push, LINE, email, calendar) mocked. Rule under test: a booking is on at
// most one job, a job follows its bookings completely or not at all, and people are told
// only what was committed. All data invented — this repo is public.

vi.hoisted(() => { process.env.BOOKING_RECONCILE_FLAG_SINCE = "2000-01-01"; });
vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPushToUser: vi.fn(async () => 0) }));
vi.mock("@/lib/line", async (orig) => ({ ...(await orig<typeof import("@/lib/line")>()), lineEnabled: false, linePush: vi.fn(async () => true), linePushFlex: vi.fn(async () => true) }));
vi.mock("@/lib/email", async (orig) => ({ ...(await orig<typeof import("@/lib/email")>()), sendEmail: vi.fn(async () => true) }));
vi.mock("@/lib/tour-calendar-sync", async (orig) => ({ ...(await orig<typeof import("@/lib/tour-calendar-sync")>()), removeTourEvents: vi.fn(async () => {}), pushTourToCalendars: vi.fn(async () => {}) }));

import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { importParsed } from "@/lib/booking-import";
import { reconcileBookingChange } from "@/lib/booking-reconcile";
import { createCertificate } from "@/lib/certificates/service";
import { DEFAULT_EXPENSES, fillDownExpensePax, type Expense } from "@/lib/jobsheet";
import { toSheetBooking, type SheetBooking } from "@/lib/sheet-bookings";

const DATE = new Date(Date.now() + 5 * 86400_000 + 7 * 3600_000).toISOString().slice(0, 10);
const A = "G-951", B = "G-952", C = "G-953";
let ops: { id: string };
let guideA: { id: string };

type Over = Partial<{ status: string; tourId: string | null; assignedGuideId: string | null; slotIdx: number }>;
const mk = (ref: string, pax: number, over: Over = {}) => prisma.booking.create({ data: {
  source: "GetYourGuide", externalRef: ref, confirmationCode: `CODE-${ref}`, customerName: `Guest ${ref}`,
  date: DATE, slotIdx: over.slotIdx ?? 0, tourId: over.tourId === undefined ? "T-900" : over.tourId, pax,
  status: over.status ?? "OFFERED", assignedGuideId: over.assignedGuideId ?? null,
} });
const assign = (guideId: string, pax: number, tourId = "T-900") => prisma.assignment.create({ data: { guideId, date: DATE, slotIdx: 0, tourId, pax } });
type RowSrc = { externalRef: string | null; confirmationCode: string | null; customerName: string | null; pax: number | null };
async function sheet(guideId: string, rows: (RowSrc | SheetBooking)[], over: Record<string, unknown> = {}) {
  const r = rows.map((x) => ("bookingNo" in x ? x : toSheetBooking(x)));
  return prisma.jobSheet.create({ data: {
    ref: `FOLK-R2-${guideId}`, guideId, date: DATE, slotIdx: 0, tourId: (over.tourId as string) ?? "T-900", status: "Confirmed",
    bookings: r as never, expenses: fillDownExpensePax(DEFAULT_EXPENSES, r.reduce((s, x) => s + (x.bookedPax ?? 0), 0)) as never, ...over,
  } });
}
const sheetOf = (g: string) => prisma.jobSheet.findUniqueOrThrow({ where: { guideId_date_slotIdx: { guideId: g, date: DATE, slotIdx: 0 } } });
const rowsOn = async (g: string) => ((await sheetOf(g)).bookings as unknown as SheetBooking[]);
const refsOn = async (g: string) => (await rowsOn(g)).map((r) => r.bookingNo);
const guestsOn = async (g: string) => (await rowsOn(g)).reduce((s, r) => s + (r.bookedPax ?? 0), 0);
const paxOf = async (g: string) => (await prisma.assignment.findFirstOrThrow({ where: { guideId: g, date: DATE, slotIdx: 0 } })).pax;
const statusOf = async (id: string) => (await prisma.booking.findUniqueOrThrow({ where: { id } })).status;
const issues = (code: string) => prisma.auditLog.findMany({ where: { action: "booking.reconciliation_required", detail: { path: ["code"], equals: code } } });
const guideMsgs = async (userId = guideA.id) => (await prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: "asc" } })).map((n) => n.message);
const opsMsgs = async () => (await prisma.notification.findMany({ where: { userId: ops.id }, orderBy: { createdAt: "asc" } })).map((n) => n.message);
const run = (id: string, over: Partial<Parameters<typeof reconcileBookingChange>[1]> = {}) => reconcileBookingChange(id, { source: "test", ...over });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Resolve once another session is blocked on a row lock — ordering by a condition the
 *  database reports, not by a wall-clock head start. Fails the test if it never happens. */
async function untilSomeoneWaitsForALock(timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const [{ n }] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%FOR UPDATE%'`;
    if (Number(n) > 0) return;
    await sleep(10);
  }
  throw new Error("no session ended up waiting for the row lock");
}

beforeAll(() => { requireTestDatabase(); });
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  guideA = await seedGuide(A, { displayName: "Guide A Example" });
  await seedGuide(B, { displayName: "Guide B Example" });
  await seedGuide(C, { displayName: "Guide C Example" });
  await prisma.tour.upsert({ where: { id: "T-901" }, update: {}, create: { id: "T-901", name: "Canal Walk Example", time: "08:30", durationMin: 120 } });
  ops = await prisma.user.create({ data: { email: "op-r2@example.test", displayName: "Op Example", role: "OPERATOR", state: "ACTIVE" } });
});

describe("1 — probe V: a release never survives the old job being frozen", () => {
  it("SWAP moves T-900 → T-901 while A's job is frozen by an ambiguous booking: SWAP stays on A, B does not get it", async () => {
    await assign(A, 6); await assign(C, 0); await assign(B, 3, "T-901");
    const aaa = await mk("AAA1", 4), swap = await mk("SWAP1", 2), ccc = await mk("CCC1", 3, { tourId: "T-901" });
    await sheet(A, [aaa, swap]); await sheet(B, [ccc], { tourId: "T-901" });
    await mk("AMBIG1", 2); // T-900, untagged, on no sheet, two guides on T-900 → A (and C) frozen
    await prisma.booking.update({ where: { id: swap.id }, data: { tourId: "T-901" } });

    const r = await run(swap.id);
    expect(r.kind).toBe("review-required");
    expect(await refsOn(A)).toEqual(["AAA1", "SWAP1"]);
    expect(await refsOn(B)).toEqual(["CCC1"]);
    // Each booking identity is on at most one job sheet.
    const everywhere = [...(await refsOn(A)), ...(await refsOn(B))];
    expect(everywhere.filter((x) => x === "SWAP1")).toHaveLength(1);
    // Nothing recounted: each assignment still matches its own sheet.
    expect(await paxOf(A)).toBe(await guestsOn(A));
    expect(await paxOf(B)).toBe(await guestsOn(B));
    expect(await statusOf(swap.id)).toBe("OFFERED"); // still A's, operationally
    const rv = await issues("BOOKING_JOB_MATCH_REVIEW_REQUIRED");
    expect(rv.some((x) => x.entityId === swap.id)).toBe(true);
    // Settled by the plan itself — the last-resort whole-departure stop was never needed.
    expect((await issues("BOOKING_RECONCILIATION_REVIEW_REQUIRED")).filter((x) => x.entityType === "Departure")).toHaveLength(0);
  });
});

describe("2 — two live records with one booking reference", () => {
  it("neither is summed, placed or added; the job is left as it was; review raised", async () => {
    await assign(A, 4);
    const first = await mk("SAME2", 4);
    await sheet(A, [first]);
    const second = await prisma.booking.create({ data: { source: "GetYourGuide", externalRef: "SAME2", confirmationCode: "CODE-SAME2-v2", customerName: "Guest renamed", date: DATE, slotIdx: 0, tourId: "T-900", pax: 5, status: "PENDING" } });
    const r = await run(second.id);
    expect(r).toMatchObject({ kind: "review-required", code: "DUPLICATE_BOOKING_REFERENCE_REVIEW_REQUIRED" });
    expect(await refsOn(A)).toEqual(["SAME2"]);
    expect(await guestsOn(A)).toBe(4);
    expect(await paxOf(A)).toBe(4);
    expect(await statusOf(second.id)).toBe("PENDING");
    expect((await issues("DUPLICATE_BOOKING_REFERENCE_REVIEW_REQUIRED")).length).toBeGreaterThanOrEqual(1);

    // Once one of them is cancelled there is one record again, and the row follows it — once.
    await prisma.booking.update({ where: { id: first.id }, data: { status: "CANCELLED" } });
    await run(first.id);
    expect(await refsOn(A)).toEqual(["SAME2"]);
    expect(await guestsOn(A)).toBe(5);
    expect(await paxOf(A)).toBe(5);
  });

  it("a booking already listed twice on one sheet is not resized into a double count", async () => {
    await assign(A, 8);
    const b = await mk("TWICE2", 4);
    await sheet(A, [b, b]);
    await prisma.booking.update({ where: { id: b.id }, data: { pax: 5 } });
    const r = await run(b.id);
    expect(r).toMatchObject({ kind: "review-required", code: "DUPLICATE_BOOKING_REFERENCE_REVIEW_REQUIRED" });
    expect((await rowsOn(A)).map((x) => x.bookedPax)).toEqual([4, 4]);
  });
});

describe("3 — a booking that leaves a job with nowhere to go returns to the inbox", () => {
  it("tour changed to one nobody runs: off A's sheet, back to PENDING, review raised", async () => {
    await assign(A, 6);
    const aaa = await mk("AAA3", 4), m = await mk("MOVE3", 2);
    await sheet(A, [aaa, m]);
    await prisma.booking.update({ where: { id: m.id }, data: { tourId: "T-901" } });
    await run(m.id);
    expect(await refsOn(A)).toEqual(["AAA3"]);
    expect(await paxOf(A)).toBe(4);
    expect(await statusOf(m.id)).toBe("PENDING");
    expect((await issues("BOOKING_JOB_MATCH_REVIEW_REQUIRED")).some((x) => x.entityId === m.id)).toBe(true);
  });

  it("…but when the old row cannot be released (ticket details on it), it stays on A, still A's", async () => {
    await assign(A, 6);
    const aaa = await mk("AAA3b", 4), m = await mk("MOVE3b", 2);
    await sheet(A, [toSheetBooking(aaa), { ...toSheetBooking(m), tickets: "2 GP" }]);
    await prisma.booking.update({ where: { id: m.id }, data: { tourId: "T-901" } });
    const r = await run(m.id);
    expect(r.kind).toBe("review-required");
    expect(await refsOn(A)).toEqual(["AAA3b", "MOVE3b"]);
    expect(await statusOf(m.id)).toBe("OFFERED");
  });
});

describe("4 — ticket details on a guest row are human evidence", () => {
  it("a cancelled booking's row with ticket details stays and is flagged; one without is removed", async () => {
    await assign(A, 8);
    const aaa = await mk("AAA4", 4), tk = await mk("TICK4", 2), plain = await mk("PLAIN4", 2);
    await sheet(A, [toSheetBooking(aaa), { ...toSheetBooking(tk), tickets: "GP x2" }, toSheetBooking(plain)]);
    await prisma.booking.updateMany({ where: { id: { in: [tk.id, plain.id] } }, data: { status: "CANCELLED" } });
    await run(tk.id);
    const rows = await rowsOn(A);
    expect(rows.map((r) => r.bookingNo)).toEqual(["AAA4", "TICK4"]);
    expect(rows.find((r) => r.bookingNo === "TICK4")!.tickets).toBe("GP x2");
    expect((await issues("BOOKING_RECONCILIATION_REVIEW_REQUIRED")).some((x) => JSON.stringify(x.detail).includes("TICK4"))).toBe(true);
    // The assignment follows the sheet it can see, the kept row included.
    expect(await paxOf(A)).toBe(await guestsOn(A));
  });
});

describe("6 — the guide's last message is the committed count, even after a stale event", () => {
  it("6 → 8, stale 8 → 6, autosync 6 → 8: three notices, the last one says 8; a replay says nothing", async () => {
    await assign(A, 6);
    const aaa = await mk("AAA6", 4), bbb = await mk("BBB6", 2);
    await sheet(A, [aaa, bbb]);
    const payload = (pax: number) => ({ externalRef: "BBB6", confirmationCode: "CODE-BBB6", customerName: "Guest BBB6", date: DATE, slotIdx: 0, pax });
    await importParsed(payload(4), { source: "GetYourGuide", cancelled: false, via: "webhook" });
    await importParsed(payload(2), { source: "GetYourGuide", cancelled: false, via: "webhook" }); // a stale, delayed event
    await importParsed(payload(4), { source: "GetYourGuide", cancelled: false, via: "autosync" }); // the correction
    const msgs = (await guideMsgs()).filter((m) => m.includes("Expected guests"));
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toContain("6 → 8");
    expect(msgs[1]).toContain("8 → 6");
    expect(msgs[2]).toContain("6 → 8");
    expect((await opsMsgs()).filter((m) => m.includes("Expected guests"))).toHaveLength(3);
    // The same state again: nobody is told anything.
    await importParsed(payload(4), { source: "GetYourGuide", cancelled: false, via: "autosync" });
    await run(bbb.id);
    expect((await guideMsgs()).filter((m) => m.includes("Expected guests"))).toHaveLength(3);
    expect(await guestsOn(A)).toBe(8);
  });
});

describe("7/9 — accounting history recorded during the reconciliation stops it", () => {
  for (const kind of ["payment", "advance"] as const) {
    it(`a ${kind} recorded between the first check and the write: the job is not changed at all`, async () => {
      await assign(A, 6);
      const aaa = await mk(`AAA7${kind}`, 4), bbb = await mk(`BBB7${kind}`, 2);
      await sheet(A, [aaa, bbb]);
      const before = JSON.stringify((await sheetOf(A)).bookings);
      const late = await mk(`LATE7${kind}`, 2, { status: "PENDING" });
      const r = await run(late.id, { beforeWrite: async (attempt) => {
        if (attempt !== 1) return;
        // Neither row has a link to the job sheet, so the sheet lock does not hold it back.
        if (kind === "payment") await prisma.tourPayment.create({ data: { guideId: A, date: DATE, slotIdx: 0, tourId: "T-900", status: "PAID", paidAt: new Date() } });
        else await prisma.guideAdvance.create({ data: { advanceNo: "FOLK-ADV-209901-001", guideId: A, date: DATE, slotIdx: 0, jobNo: "FOLK-R2", amount: 500, amountSatang: 50000, paidAt: new Date(), advanceDate: DATE, accountingPeriod: DATE.slice(0, 7), createdById: ops.id } });
      } });
      expect(r.kind).toBe("blocked");
      expect(JSON.stringify((await sheetOf(A)).bookings)).toBe(before);
      expect(await statusOf(late.id)).toBe("PENDING");
      expect(await paxOf(A)).toBe(6);
      expect(await issues("BOOKING_RECONCILIATION_BLOCKED")).toHaveLength(1);
    });
  }
});

describe("8 — reconciliation vs certificate creation", () => {
  const e = (description: string, price: number, pax: number) => ({ description, price, pax, expenseType: "transport", paidBy: "guide", paidBySource: "operator" }) as Expense;
  const certSheet = async (bookings: RowSrc[]) => prisma.jobSheet.create({ data: {
    ref: "FOLK-R2-CERT", guideId: A, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed",
    bookings: bookings.map(toSheetBooking) as never, expenses: [e("Ferry (Inc. Guide)", 20, 7)] as never,
  } });
  const ADMIN = { id: "u-admin-r2", name: "Admin Example", role: "ADMIN" as const };

  it("a certificate requested while the reconciliation holds the sheet is issued on the sheet AFTER it", async () => {
    await assign(A, 6);
    const aaa = await mk("AAA8", 4), bbb = await mk("BBB8", 2);
    await certSheet([aaa, bbb]);
    const late = await mk("LATE8", 2, { status: "PENDING" });
    let cert: Promise<{ sourceSheetUpdatedAt: Date | null }> | null = null;
    const r = await run(late.id, { beforeWrite: async (attempt) => {
      if (attempt !== 1) return;
      cert = createCertificate({ guideId: A, date: DATE, slotIdx: 0 }, ADMIN, {}, "ADMIN_RECORDED");
      await untilSomeoneWaitsForALock(); // the certificate is now queued behind this reconciliation's sheet lock
    } });
    expect(r.kind).toBe("reconciled");
    const made = await cert!;
    const final = await sheetOf(A);
    expect(await refsOn(A)).toEqual(["AAA8", "BBB8", "LATE8"]);
    // Issued against the sheet as it stands after the booking update — not a stale copy.
    expect(made.sourceSheetUpdatedAt?.getTime()).toBe(final.updatedAt.getTime());
  });

  it("a certificate that takes the sheet first: the reconciliation waits, sees it, and changes nothing", async () => {
    await assign(A, 6);
    const aaa = await mk("AAA8b", 4), bbb = await mk("BBB8b", 2);
    const s = await certSheet([aaa, bbb]);
    const before = JSON.stringify((await sheetOf(A)).bookings);
    const late = await mk("LATE8b", 2, { status: "PENDING" });
    // The same lock createCertificate takes, held until the reconciliation is provably
    // waiting behind it; only then is the certificate written and the lock released.
    let locked!: () => void, release!: () => void;
    const lockTaken = new Promise<void>((r) => { locked = r; });
    const mayFinish = new Promise<void>((r) => { release = r; });
    const issuing = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "JobSheet" WHERE id = ${s.id} FOR UPDATE`;
      locked();
      await mayFinish;
      await tx.expenseCertificate.create({ data: { certificateNo: "CERT-R2-1", jobSheetId: s.id, activeJobSheetId: s.id, guideId: A, jobRef: s.ref, tourDate: DATE, slotIdx: 0, status: "READY_TO_ATTEST", payload: {} as never, payloadHash: "d".repeat(64), coveredRows: [] as never, totalSatang: 0, source: "ADMIN_RECORDED", sourceSheetUpdatedAt: s.updatedAt } });
    }, { timeout: 20_000 });
    await lockTaken; // the certificate holds the sheet
    const reconciling = run(late.id);
    await untilSomeoneWaitsForALock(); // the reconciliation is queued behind it
    release();
    await issuing;
    const r = await reconciling;
    expect(r.kind).toBe("blocked");
    expect(JSON.stringify((await sheetOf(A)).bookings)).toBe(before);
    expect(await statusOf(late.id)).toBe("PENDING");
  });
});

describe("10 — an approved holder never releases", () => {
  it("SWAP's tour moves to B's, but A's sheet is approved: SWAP stays on A, B does not get it, review", async () => {
    await assign(A, 6); await assign(B, 3, "T-901");
    const aaa = await mk("AAA10", 4), swap = await mk("SWAP10", 2), ccc = await mk("CCC10", 3, { tourId: "T-901" });
    await sheet(A, [aaa, swap], { approvalStatus: "APPROVED" }); await sheet(B, [ccc], { tourId: "T-901" });
    await prisma.booking.update({ where: { id: swap.id }, data: { tourId: "T-901" } });
    const r = await run(swap.id);
    expect(r.kind).toBe("review-required");
    expect(await refsOn(A)).toEqual(["AAA10", "SWAP10"]);
    expect(await refsOn(B)).toEqual(["CCC10"]);
    expect(await paxOf(B)).toBe(3);
    expect((await issues("BOOKING_JOB_MATCH_REVIEW_REQUIRED")).some((x) => x.entityId === swap.id)).toBe(true);
    expect((await issues("BOOKING_RECONCILIATION_REVIEW_REQUIRED")).filter((x) => x.entityType === "Departure")).toHaveLength(0);
  });
});

describe("11 — no sheet yet: concurrent reconciliations never lose an update", () => {
  it("two pax changes reconciled at once end at the canonical total", async () => {
    await assign(A, 4);
    const x = await mk("X11", 2), y = await mk("Y11", 2);
    await prisma.booking.update({ where: { id: x.id }, data: { pax: 3 } });
    let second: Promise<unknown> | null = null;
    const firstAttempts: number[] = [];
    await run(x.id, { beforeWrite: async (attempt) => {
      firstAttempts.push(attempt);
      if (attempt !== 1) return;
      await prisma.booking.update({ where: { id: y.id }, data: { pax: 4 } });
      second = run(y.id); // runs while the first holds the departure
      await sleep(200);
    } });
    await second;
    expect(await paxOf(A)).toBe(7);
    // The departure lock makes the second WAIT: the first is never undercut and never has to
    // retry. Without the lock the second would write first and force the first to start over.
    expect(firstAttempts).toEqual([1]);
  });
});

describe("12 — a second guide added while a booking is being placed", () => {
  it("the sole-guide assumption is checked before writing: not placed, reviewed", async () => {
    await assign(A, 2);
    const aaa = await mk("AAA12", 2);
    await sheet(A, [aaa]);
    const n = await mk("N12", 2, { status: "PENDING" });
    const r = await run(n.id, { beforeWrite: async (attempt) => { if (attempt === 1) await assign(B, 0); } });
    expect(r.kind).toBe("review-required");
    expect(await statusOf(n.id)).toBe("PENDING");
    expect(await refsOn(A)).toEqual(["AAA12"]);
    expect(await paxOf(A)).toBe(2);
  });
});

describe("12b — a new job sheet appears while the departure is being reconciled", () => {
  it("the first attempt writes nothing, the retry works on the complete state, and nothing is duplicated", async () => {
    await assign(A, 4); await assign(B, 3, "T-901");
    const aaa = await mk("AAA12b", 4), ccc = await mk("CCC12b", 3, { tourId: "T-901" });
    // A person recorded ticket details on A's guest row: evidence that must survive.
    await sheet(A, [{ ...toSheetBooking(aaa), tickets: "GP x4" }]);
    const late = await mk("LATE12b", 2, { status: "PENDING" });

    // B's first job sheet is saved (by an operator) after the reconciliation has read the
    // departure and before it writes. A row lock cannot stop a row that did not exist yet.
    const attempts: number[] = [];
    const r = await run(late.id, { beforeWrite: async (attempt) => {
      attempts.push(attempt);
      if (attempt === 1) await sheet(B, [ccc], { tourId: "T-901" });
    } });

    expect(r.kind).toBe("reconciled");
    expect(attempts).toEqual([1, 2]); // detected, rolled back, recomputed once
    // A has the late booking exactly once; B's new sheet is left exactly as it was saved.
    expect(await refsOn(A)).toEqual(["AAA12b", "LATE12b"]);
    expect(await refsOn(B)).toEqual(["CCC12b"]);
    const everywhere = [...(await refsOn(A)), ...(await refsOn(B))];
    for (const ref of ["AAA12b", "CCC12b", "LATE12b"]) expect(everywhere.filter((x) => x === ref)).toHaveLength(1);
    // Counts follow each job's own sheet.
    expect(await guestsOn(A)).toBe(6);
    expect(await paxOf(A)).toBe(6);
    expect(await paxOf(B)).toBe(3);
    // The evidence on A's row is untouched.
    expect((await rowsOn(A)).find((x) => x.bookingNo === "AAA12b")!.tickets).toBe("GP x4");
    // Attempt 1 left nothing behind: one placement, one row added, one count change, one notice.
    expect(await statusOf(late.id)).toBe("OFFERED");
    expect(await prisma.auditLog.count({ where: { action: "booking.reconciled" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "jobsheet.booking_added" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "assignment.booking_sync" } })).toBe(1);
    expect((await guideMsgs()).filter((m) => m.includes("Expected guests"))).toHaveLength(1);
    expect((await opsMsgs()).filter((m) => m.startsWith("LATE BOOKING"))).toHaveLength(1);
  });
});

describe("13 — a cancellation on a job that cannot change announces no count", () => {
  it("approved sheet, a guest cancels: the guide hears it was cancelled, with no new count", async () => {
    await assign(A, 6);
    const aaa = await mk("AAA13", 4), bbb = await mk("BBB13", 2);
    await sheet(A, [aaa, bbb], { approvalStatus: "APPROVED" });
    const before = JSON.stringify((await sheetOf(A)).bookings);
    await importParsed({ externalRef: "BBB13", confirmationCode: "CODE-BBB13", customerName: "Guest BBB13", date: DATE, slotIdx: 0, pax: 2 }, { source: "GetYourGuide", cancelled: true, via: "webhook" });
    expect(JSON.stringify((await sheetOf(A)).bookings)).toBe(before);
    expect(await paxOf(A)).toBe(6);
    const msgs = await guideMsgs();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain("was cancelled");
    expect(msgs[0]).not.toMatch(/Expected guests|You now have|\d+ guests?/);
    // Once is enough.
    await run((await prisma.booking.findFirstOrThrow({ where: { externalRef: "BBB13" } })).id);
    expect(await guideMsgs()).toHaveLength(1);
  });

  it("a job that can change hears the committed count after the cancellation, once", async () => {
    await assign(A, 6);
    const aaa = await mk("AAA13b", 4), bbb = await mk("BBB13b", 2);
    await sheet(A, [aaa, bbb]);
    await importParsed({ externalRef: "BBB13b", confirmationCode: "CODE-BBB13b", customerName: "Guest BBB13b", date: DATE, slotIdx: 0, pax: 2 }, { source: "GetYourGuide", cancelled: true, via: "webhook" });
    const msgs = await guideMsgs();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain("Expected guests: 6 → 4");
    expect(await paxOf(A)).toBe(4);
  });
});
