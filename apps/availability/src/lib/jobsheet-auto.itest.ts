import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// The job sheet exists from the moment the guide has the job (owner, 2026-10-15): with its
// FOLK-BKK number, this guide's guests and the standard lines — and not yet "filled in by an
// operator". Real database; push/LINE/email/calendar stubbed. All data invented.
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPushToUser: vi.fn(async () => 0) }));
vi.mock("@/lib/line", async (orig) => ({ ...(await orig<typeof import("@/lib/line")>()), lineEnabled: false }));
vi.mock("@/lib/email", async (orig) => ({ ...(await orig<typeof import("@/lib/email")>()), sendEmail: vi.fn(async () => true) }));
vi.mock("@/lib/calendar", async (orig) => ({ ...(await orig<typeof import("@/lib/calendar")>()), sendTourCalendarInvite: vi.fn(async () => {}) }));
vi.mock("@/lib/tour-calendar-sync", async (orig) => ({ ...(await orig<typeof import("@/lib/tour-calendar-sync")>()), removeTourEvents: vi.fn(async () => {}), pushTourToCalendars: vi.fn(async () => {}) }));

import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { acceptOffer, createOffer } from "@/lib/offers";
import { ensureJobSheetForAssignment } from "@/lib/jobsheet-auto";
import { POST as ASSIGN } from "@/app/api/assignments/route";

const DATE = new Date(Date.now() + 7 * 3600_000 + 4 * 86400_000).toISOString().slice(0, 10);
const G = "G-976";
const sheetOf = () => prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId: G, date: DATE, slotIdx: 0 } } });
const booking = (ref: string, pax: number) => prisma.booking.create({ data: { source: "Example OTA", externalRef: ref, confirmationCode: ref, customerName: `Guest ${ref}`, date: DATE, slotIdx: 0, tourId: "T-900", pax, status: "PENDING" } });

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  await seedGuide(G, { email: "g976@example.test" });
  const op = await prisma.user.create({ data: { email: "op-ja@example.test", displayName: "Op Example", role: "OPERATOR", state: "ACTIVE" } });
  authMock.auth.mockResolvedValue({ user: { id: op.id, role: "OPERATOR" } });
});

describe("the job sheet is made when the guide gets the job", () => {
  it("accepting an offer: a numbered sheet with the guests, the standard lines and fee — not yet filled in by an operator", async () => {
    await booking("JA-1", 2); await booking("JA-2", 3);
    const o = await createOffer({ tourId: "T-900", date: DATE, slotIdx: 0, onlyGuideId: G });
    expect((await acceptOffer(o.offerId!, G)).ok).toBe(true);
    const s = await sheetOf();
    expect(s?.ref).toMatch(new RegExp(`^FOLK-BKK-${DATE.replace(/-/g, "")}-\\d{2}$`));
    expect((s!.bookings as { bookingNo: string; bookedPax: number }[]).map((b) => [b.bookingNo, b.bookedPax])).toEqual([["JA-1", 2], ["JA-2", 3]]);
    expect((s!.expenses as unknown[]).length).toBeGreaterThan(0);
    expect(s!.guideFee).toMatchObject({ price: expect.any(Number) });
    expect({ approved: s!.approvalStatus, certified: s!.certifiedAt }).toEqual({ approved: null, certified: null });
    expect(await prisma.auditLog.count({ where: { action: "jobsheet.created_at_assignment" } })).toBe(1);
  });

  it("a direct assignment makes it too", async () => {
    await booking("JA-3", 4);
    const r = await ASSIGN(new Request("http://test.local/api/assignments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", direct: true }) }) as never);
    expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
    expect((await sheetOf())?.ref).toBeTruthy();
  });

  it("an existing sheet is left as it is — only given a number if it had none — and a second call makes nothing new", async () => {
    await prisma.assignment.create({ data: { guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", pax: 2 } });
    await prisma.jobSheet.create({ data: { guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [{ name: "Kept by hand", bookingNo: "" }], expenses: [], guideFee: {} } });
    const first = await ensureJobSheetForAssignment(G, DATE, 0, "test");
    expect(first.created).toBe(false);
    expect(first.ref).toBeTruthy();
    const s = await sheetOf();
    expect((s!.bookings as { name: string }[])[0].name).toBe("Kept by hand");
    expect((await ensureJobSheetForAssignment(G, DATE, 0, "test")).ref).toBe(first.ref);
    expect(await prisma.jobSheet.count()).toBe(1);
  });

  it("no assignment, no sheet", async () => {
    expect(await ensureJobSheetForAssignment(G, DATE, 0, "test")).toEqual({ created: false, ref: null });
    expect(await prisma.jobSheet.count()).toBe(0);
  });
});
