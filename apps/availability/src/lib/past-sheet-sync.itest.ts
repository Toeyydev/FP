import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { readPastSheetGaps, syncPastSheet } from "./past-sheet-sync";

// A tour that already ran, against a real database: the button adds only what the server
// finds missing, appends without touching a row, marks the departure's waiting bookings as
// guided, and refuses a stale view or an approved sheet. All data invented.
const KEY = { guideId: "G-990", date: "2025-03-09", slotIdx: 2 };
const actor = { actorId: "u_op", actorRole: "OPERATOR" };
const booking = (ref: string, pax: number, status = "PENDING", over: Record<string, unknown> = {}) =>
  prisma.booking.create({ data: { source: "GetYourGuide", externalRef: ref, tourId: "T-900", date: KEY.date, startTime: "13:30", slotIdx: KEY.slotIdx, pax, customerName: `Guest ${ref}`, status, ...over } });

beforeAll(requireTestDatabase);
beforeEach(async () => {
  await resetDatabase();
  await seedGuide("G-990");
  await prisma.assignment.create({ data: { guideId: "G-990", date: KEY.date, slotIdx: KEY.slotIdx, tourId: "T-900", pax: 2 } });
});

async function sheet(over: Record<string, unknown> = {}) {
  return prisma.jobSheet.create({ data: { ...KEY, tourId: "T-900", status: "Confirmed", ref: "FOLK-TEST-PAST-01", expenses: [{ description: "Water", price: 10, pax: 10 }],
    bookings: [{ name: "Guest GYGEXAMPLE01", bookingNo: "GYGEXAMPLE01", bookedPax: 2, actualPax: 2, tickets: "", status: "" }], ...over } });
}

describe("closing a past sheet's gaps", () => {
  it("adds the missing bookings after the existing rows, marks all of them guided, audits refs only", async () => {
    const a = await booking("GYGEXAMPLE01", 2, "OFFERED");
    const b = await booking("GYGEXAMPLE02", 2);
    const c = await booking("9900001", 1);
    const s = await sheet();
    const gaps = await readPastSheetGaps(prisma, KEY);
    expect(gaps?.missing.map((x) => x.ref)).toEqual(["GYGEXAMPLE02", "9900001"]);
    expect(gaps?.unsettled.map((x) => x.ref)).toEqual(["GYGEXAMPLE01"]);

    const r = await syncPastSheet(prisma, { ...KEY, bookingIds: [a.id, b.id, c.id], sheetVersion: s.updatedAt.toISOString(), actor });
    expect(r).toEqual({ ok: true, added: ["GYGEXAMPLE02", "9900001"], settled: ["GYGEXAMPLE02", "9900001", "GYGEXAMPLE01"] });
    const after = await prisma.jobSheet.findUniqueOrThrow({ where: { id: s.id } });
    expect((after.bookings as { bookingNo: string; bookedPax: number }[]).map((x) => `${x.bookingNo}:${x.bookedPax}`)).toEqual(["GYGEXAMPLE01:2", "GYGEXAMPLE02:2", "9900001:1"]);
    expect(after.expenses).toEqual(s.expenses);
    expect((await prisma.booking.findMany({ orderBy: { externalRef: "asc" } })).map((x) => x.status)).toEqual(["ASSIGNED", "ASSIGNED", "ASSIGNED"]);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "jobsheet.past_bookings_synced" } });
    expect(JSON.stringify(log.detail)).not.toMatch(/Guest /);
    expect(await readPastSheetGaps(prisma, KEY)).toEqual({ missing: [], unsettled: [] });
  });

  it("a view that is out of date is refused, and nothing changes", async () => {
    const b = await booking("GYGEXAMPLE02", 2);
    const s = await sheet();
    await new Promise((r) => setTimeout(r, 20)); // a later save, not the same millisecond
    await prisma.jobSheet.update({ where: { id: s.id }, data: { operatorNote: "edited meanwhile" } });
    const r = await syncPastSheet(prisma, { ...KEY, bookingIds: [b.id], sheetVersion: s.updatedAt.toISOString(), actor });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("PENDING");
  });

  it("only what the server itself finds: another tour's booking is refused", async () => {
    const other = await booking("GYGEXAMPLE09", 2, "PENDING", { tourId: null });
    await booking("GYGEXAMPLE08", 2, "PENDING", { tourId: "T-901" });
    const s = await sheet();
    const r = await syncPastSheet(prisma, { ...KEY, bookingIds: [other.id], sheetVersion: s.updatedAt.toISOString(), actor });
    expect(r).toMatchObject({ ok: false, status: 409 });
  });

  it("an approved sheet takes no new guests — but its waiting bookings may still be marked guided", async () => {
    const a = await booking("GYGEXAMPLE01", 2, "OFFERED");
    const b = await booking("GYGEXAMPLE02", 2);
    const s = await sheet({ approvalStatus: "APPROVED" });
    expect(await syncPastSheet(prisma, { ...KEY, bookingIds: [b.id], sheetVersion: s.updatedAt.toISOString(), actor })).toMatchObject({ ok: false, status: 409 });
    expect(await syncPastSheet(prisma, { ...KEY, bookingIds: [a.id], sheetVersion: s.updatedAt.toISOString(), actor })).toMatchObject({ ok: true, added: [], settled: ["GYGEXAMPLE01"] });
  });

  it("a tour that has not run yet is not this button's job", async () => {
    const future = { ...KEY, date: "2099-03-09" };
    expect(await readPastSheetGaps(prisma, future)).toBeNull();
  });
});
