import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// The palace-only tour runs only at 14:00 (owner, 2026-10-25). A booking filed under it at
// 13:30 is the combined tour that departs then — and while it is filed wrong, the inbox must
// not badge it as handled by the 13:30 guide, who runs another tour (GYG, 27 Oct 2026).
// Real database, the real route; push/LINE/email/calendar mocked. All data invented.
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPushToUser: vi.fn(async () => 0) }));
vi.mock("@/lib/line", async (orig) => ({ ...(await orig<typeof import("@/lib/line")>()), lineEnabled: false }));
vi.mock("@/lib/email", async (orig) => ({ ...(await orig<typeof import("@/lib/email")>()), sendEmail: vi.fn(async () => true) }));
vi.mock("@/lib/tour-calendar-sync", async (orig) => ({ ...(await orig<typeof import("@/lib/tour-calendar-sync")>()), removeTourEvents: vi.fn(async () => {}), pushTourToCalendars: vi.fn(async () => {}) }));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { GET, POST } from "@/app/api/bookings/route";
import { SLOT_TIMES } from "@/lib/slots";
import { importParsed } from "@/lib/booking-import";
import { productKey } from "@/lib/bookings";

const DATE = new Date(Date.now() + 5 * 86400_000 + 7 * 3600_000).toISOString().slice(0, 10);
const S1330 = SLOT_TIMES.indexOf("13:30"), S1400 = SLOT_TIMES.indexOf("14:00");
const G = "G-986";

const post = async (body: Record<string, unknown>) => {
  const r = await POST(new NextRequest("http://test.local/api/bookings", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
  return { status: r.status, body: await r.json() };
};
const inbox = async () => (await (await GET(new NextRequest("http://test.local/api/bookings"))).json()).bookings as { externalRef: string; guideId: string | null; otherTourGuide: { guideId: string; tourId: string } | null }[];
const mk = (ref: string, slotIdx: number, tourId: string) => prisma.booking.create({ data: {
  source: "GetYourGuide", externalRef: ref, confirmationCode: `CODE-${ref}`, customerName: `Guest ${ref}`, date: DATE, slotIdx, tourId, pax: 1, status: "PENDING",
} as never });

beforeAll(requireTestDatabase);
beforeEach(async () => {
  vi.clearAllMocks();
  await resetDatabase();
  await seedGuide(G, { displayName: "Mike Example" });
  for (const [id, name, time] of [["T-001", "Grand Palace, Wat Pho & Wat Arun (example, morning)", "08:30"], ["T-002", "Grand Palace, Wat Pho & Wat Arun (example)", "13:30"], ["T-005", "Wat Phrakaew & Grand Palace (example)", "14:00"]]) {
    await prisma.tour.create({ data: { id, name, time, durationMin: 240 } });
  }
  const op = await prisma.user.create({ data: { email: "op@example.test", displayName: "Op Example", role: "OPERATOR", state: "ACTIVE" } });
  authMock.auth.mockResolvedValue({ user: { id: op.id, role: "OPERATOR" } });
});

describe("a booking moved off 14:00", () => {
  it("to 13:30 takes the combined tour that departs then", async () => {
    const b = await mk("GYG-SLOT-1", S1400, "T-005");
    const r = await post({ action: "update", id: b.id, slotIdx: S1330 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ slotIdx: S1330, tourId: "T-002", datePinned: true });
  });
  it("keeps the tour the operator chose in the same edit", async () => {
    const b = await mk("GYG-SLOT-2", S1400, "T-005");
    await post({ action: "update", id: b.id, slotIdx: S1330, tourId: "T-005" });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).tourId).toBe("T-005");
  });
});

describe("the inbox names the guide of the booking's own tour", () => {
  it("a guide on another tour at 13:30 is not this booking's guide", async () => {
    await prisma.assignment.create({ data: { guideId: G, date: DATE, slotIdx: S1330, tourId: "T-002", pax: 3 } });
    await mk("GYG-WRONG", S1330, "T-005"); // filed wrong before this fix
    const row = (await inbox()).find((b) => b.externalRef === "GYG-WRONG")!;
    expect(row.guideId).toBeNull();
    expect(row.otherTourGuide).toMatchObject({ guideId: G, tourId: "T-002" });
  });
  it("the guide of the same tour is", async () => {
    await prisma.assignment.create({ data: { guideId: G, date: DATE, slotIdx: S1330, tourId: "T-002", pax: 3 } });
    await mk("GYG-RIGHT", S1330, "T-002");
    expect((await inbox()).find((b) => b.externalRef === "GYG-RIGHT")).toMatchObject({ guideId: G, otherTourGuide: null });
  });
});

describe("a combined-tour booking arriving at 13:30 under a name mapped to the morning tour", () => {
  const NAME = "Example : Half-Day Guided : Palace, Temples & River";
  const arrive = (ref: string) => importParsed({ externalRef: ref, confirmationCode: `CODE-${ref}`, customerName: `Guest ${ref}`, date: DATE, slotIdx: S1330, startTime: "13:30", pax: 2, productName: NAME }, { source: "GetYourGuide", cancelled: false, via: "webhook" });
  beforeEach(async () => {
    await prisma.productMap.deleteMany({});
    await prisma.productMap.create({ data: { productKey: productKey(NAME), productName: NAME, tourId: "T-001" } });
  });
  it("is filed under the 13:30 tour", async () => {
    await arrive("GYG-COMB-1330");
    expect((await prisma.booking.findFirstOrThrow({ where: { externalRef: "GYG-COMB-1330" } })).tourId).toBe("T-002");
  });
  it("one already filed under the morning tour is put right by the next sync", async () => {
    await mk("GYG-COMB-OLD", S1330, "T-001");
    await prisma.booking.updateMany({ where: { externalRef: "GYG-COMB-OLD" }, data: { productName: NAME } });
    await arrive("GYG-COMB-OLD");
    expect((await prisma.booking.findFirstOrThrow({ where: { externalRef: "GYG-COMB-OLD" } })).tourId).toBe("T-002");
  });
});
