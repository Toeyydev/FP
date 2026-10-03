import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase } from "@/test/db";
import { ARCHIVED_NOTE, applyRestore, previewRestore } from "@/lib/archived-restore";

// Restoring archived bookings against a real database, Bókun faked. All data invented.

const ACTOR = { actorId: "u_admin", actorRole: "ADMIN" };
const TODAY = "2099-09-01";
type Item = Record<string, unknown>;
const fakeSearch = (items: Item[]) => async (o: { from: string; to: string; page?: number }) => ({
  ok: true, status: 200,
  items: (o.page ?? 1) > 1 ? [] : items.filter((it) => {
    const d = new Date(Number(it.startDate) + 7 * 3600_000).toISOString().slice(0, 10);
    return d >= o.from && d <= o.to;
  }),
});
const item = (code: string, ext: string, day: string, status = "CONFIRMED"): Item => ({ productConfirmationCode: code, confirmationCode: `GET-${code}`, externalBookingReference: ext, status, startDate: Date.parse(`${day}T00:00:00Z`) });

beforeAll(requireTestDatabase);
beforeEach(async () => {
  await resetDatabase();
  await prisma.auditLog.create({ data: { action: "bookings.archive_stale", entityType: "Booking", detail: { count: 3, upTo: "2099-06-15" } } });
});

async function booking(code: string, over: Record<string, unknown> = {}) {
  return prisma.booking.create({ data: { source: "GetYourGuide", externalId: code, confirmationCode: code, externalRef: `GYG${code}`, date: "2099-04-10", slotIdx: 0, tourId: "T-900", pax: 2, status: "IGNORED", ...over } });
}

describe("restore", () => {
  it("previews without changing anything, then restores exactly that list to PENDING with an audit naming each booking", async () => {
    const a = await booking("FOLK-T1");
    const b = await booking("FOLK-T2", { notes: `${ARCHIVED_NOTE} 2099-06-15` });
    const c = await booking("FOLK-T3");
    const search = fakeSearch([item("FOLK-T1", "GYGFOLK-T1", "2099-04-10"), item("FOLK-T2", "GYGFOLK-T2", "2099-04-10", "ARRIVED"), item("FOLK-T3", "GYGFOLK-T3", "2099-04-10", "CANCELLED")]);
    const p = await previewRestore(prisma, "2099-04-01", "2099-04-30", { search, today: TODAY });
    expect(p.ok && p.summary.restore).toMatchObject({ count: 2, pax: 4, departures: 1 });
    expect(await prisma.booking.count({ where: { status: "IGNORED" } })).toBe(3);

    const r = await applyRestore(prisma, { from: "2099-04-01", to: "2099-04-30", hash: p.ok ? p.plan.hash : "", actor: ACTOR }, { search, today: TODAY });
    expect(r).toEqual({ ok: true, restored: 2 });
    const after = await prisma.booking.findMany({ orderBy: { confirmationCode: "asc" }, select: { id: true, status: true, notes: true } });
    expect(after).toEqual([{ id: a.id, status: "PENDING", notes: null }, { id: b.id, status: "PENDING", notes: null }, { id: c.id, status: "IGNORED", notes: null }]);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "bookings.archive_restored" } });
    expect((log.detail as { bookings: { id: string }[] }).bookings.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("refuses when the list changed since the preview", async () => {
    await booking("FOLK-T1");
    const search = fakeSearch([item("FOLK-T1", "GYGFOLK-T1", "2099-04-10")]);
    const p = await previewRestore(prisma, "2099-04-01", "2099-04-30", { search, today: TODAY });
    await booking("FOLK-T2");
    const changed = fakeSearch([item("FOLK-T1", "GYGFOLK-T1", "2099-04-10"), item("FOLK-T2", "GYGFOLK-T2", "2099-04-10")]);
    const r = await applyRestore(prisma, { from: "2099-04-01", to: "2099-04-30", hash: p.ok ? p.plan.hash : "", actor: ACTOR }, { search: changed, today: TODAY });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(await prisma.booking.count({ where: { status: "PENDING" } })).toBe(0);
  });

  it("Bókun unreadable: nothing changes", async () => {
    await booking("FOLK-T1");
    const down = async () => ({ ok: false, status: 0, items: [], error: "bokun-timeout" });
    expect((await previewRestore(prisma, "2099-04-01", "2099-04-30", { search: down, today: TODAY })).ok).toBe(false);
    expect(await applyRestore(prisma, { from: "2099-04-01", to: "2099-04-30", hash: "0".repeat(32), actor: ACTOR }, { search: down, today: TODAY })).toMatchObject({ ok: false, status: 502 });
    expect(await prisma.booking.count({ where: { status: "IGNORED" } })).toBe(1);
  });
});
