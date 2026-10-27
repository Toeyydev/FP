import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// The channel renamed the China Town food tour (Oct 2026), and every booking under the new
// name sat on no board until the name was mapped. One food-tour product sells 16:30, 17:30
// and 18:30 — three tours here — so a mapped name files each booking under its own time,
// and mapping it puts a waiting same-day booking on the guide's job straight away.
// Real database, the real route and importer; push/LINE/email/calendar mocked. All data invented.
vi.hoisted(() => { process.env.BOOKING_RECONCILE_FLAG_SINCE = "2000-01-01"; });
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPushToUser: vi.fn(async () => 0) }));
vi.mock("@/lib/line", async (orig) => ({ ...(await orig<typeof import("@/lib/line")>()), lineEnabled: false, linePush: vi.fn(async () => true), linePushFlex: vi.fn(async () => true) }));
vi.mock("@/lib/email", async (orig) => ({ ...(await orig<typeof import("@/lib/email")>()), sendEmail: vi.fn(async () => true) }));
vi.mock("@/lib/tour-calendar-sync", async (orig) => ({ ...(await orig<typeof import("@/lib/tour-calendar-sync")>()), removeTourEvents: vi.fn(async () => {}), pushTourToCalendars: vi.fn(async () => {}) }));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { POST } from "@/app/api/product-map/route";
import { importParsed } from "@/lib/booking-import";
import { productKey } from "@/lib/bookings";
import { SLOT_TIMES } from "@/lib/slots";
import type { SheetBooking } from "@/lib/sheet-bookings";

const DATE = new Date(Date.now() + 5 * 86400_000 + 7 * 3600_000).toISOString().slice(0, 10);
const S1630 = SLOT_TIMES.indexOf("16:30"), S1730 = SLOT_TIMES.indexOf("17:30"), S1830 = SLOT_TIMES.indexOf("18:30");
const NEW_NAME = "9999999X1 - Example Night Food Walk 10 tastings +";
const G = "G-984";

const map = async (productName: string, tourId: string) => {
  const r = await POST(new NextRequest("http://test.local/api/product-map", { method: "POST", body: JSON.stringify({ productName, tourId }), headers: { "content-type": "application/json" } }));
  return { status: r.status, body: await r.json() };
};
const unmapped = (ref: string, slotIdx: number) => prisma.booking.create({ data: {
  source: "GetYourGuide", externalRef: ref, confirmationCode: `CODE-${ref}`, customerName: `Guest ${ref}`, date: DATE, slotIdx, tourId: null, productName: NEW_NAME, pax: 2, status: "PENDING",
} as never });
const tourOf = async (id: string) => (await prisma.booking.findUniqueOrThrow({ where: { id } })).tourId;

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  await seedGuide(G, { displayName: "Fon Example" });
  for (const [id, time] of [["T-007", "16:30"], ["T-008", "17:30"], ["T-009", "18:30"]]) {
    await prisma.tour.upsert({ where: { id }, create: { id, name: `Example Food Walk (${time})`, time, durationMin: 210 }, update: {} });
  }
  await prisma.productMap.deleteMany({});
  const op = await prisma.user.create({ data: { email: "op@example.test", displayName: "Op Example", role: "OPERATOR", state: "ACTIVE" } });
  authMock.auth.mockResolvedValue({ user: { id: op.id, role: "OPERATOR" } });
});

describe("mapping a renamed food-tour product", () => {
  it("files each waiting booking under the food tour of its own time", async () => {
    const early = await unmapped("GYG-FOOD-1630", S1630);
    const late = await unmapped("GYG-FOOD-1830", S1830);
    const r = await map(NEW_NAME, "T-009");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.backfilled).toBe(2);
    expect(await tourOf(early.id)).toBe("T-007");
    expect(await tourOf(late.id)).toBe("T-009");
  });

  it("puts a waiting same-day booking on the guide's job at once", async () => {
    await prisma.assignment.create({ data: { guideId: G, date: DATE, slotIdx: S1830, tourId: "T-009", pax: 2 } });
    await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-FOOD-01", guideId: G, date: DATE, slotIdx: S1830, tourId: "T-009", status: "Confirmed", bookings: [] as never, expenses: [] as never } });
    await unmapped("GYG-FOOD-LATE", S1830);
    expect((await map(NEW_NAME, "T-009")).status).toBe(200);
    const sheet = await prisma.jobSheet.findUniqueOrThrow({ where: { guideId_date_slotIdx: { guideId: G, date: DATE, slotIdx: S1830 } } });
    expect((sheet.bookings as unknown as SheetBooking[]).map((b) => b.name)).toContain("Guest GYG-FOOD-LATE");
  });
});

describe("a booking arriving under a mapped food-tour name", () => {
  it("takes the food tour of its own time, not the one the name is mapped to", async () => {
    await prisma.productMap.create({ data: { productKey: productKey(NEW_NAME), productName: NEW_NAME, tourId: "T-009" } });
    await importParsed({ externalRef: "GYG-FOOD-1730", confirmationCode: "CODE-GYG-FOOD-1730", customerName: "Guest Example", date: DATE, slotIdx: S1730, startTime: "17:30", pax: 2, productName: NEW_NAME }, { source: "GetYourGuide", cancelled: false, via: "webhook" });
    expect((await prisma.booking.findFirstOrThrow({ where: { externalRef: "GYG-FOOD-1730" } })).tourId).toBe("T-008");
  });
});
