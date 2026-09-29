import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// The guest's phone from the channel to the guide's WhatsApp button — against a real database.
//
//  - every import path stores Booking.phone: create, upsert, the ref match, the
//    no-externalId create and update, and the exact-duplicate removal
//  - a channel that hides the details clears a number held from before
//  - WhatsApp links go only to the assigned guide, for their own share of a split
//    departure, never for a cancelled booking, never for a number that cannot be read
//  - opening the job sheet writes no phone onto it
//
// All data invented — this repo is public.

vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPushTo: vi.fn(async () => {}), sendPushToOps: vi.fn(async () => {}) }));

import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { importParsed, importRawBooking } from "@/lib/booking-import";
import { guestContactsFor } from "@/lib/guest-contacts";
import { guideTourDetails } from "@/lib/guide-schedule";

const DATE = "2099-03-10";
const at0830 = Date.UTC(2099, 2, 10, 8, 30);
const payload = (o: { id: number; ref: string; name?: string; customer?: Record<string, unknown> }) => ({
  bookingId: o.id,
  externalBookingReference: o.ref,
  startDateTime: at0830,
  customer: { firstName: o.name ?? "Anna", lastName: "Example", ...(o.customer ?? {}) },
  seller: { title: "GetYourGuide", phoneNumber: "+6620000000" },
  activityBookings: [{ product: { title: "Riverside Temples" }, productConfirmationCode: `CODE-${o.ref}` }],
});
const phoneOf = async (where: Record<string, unknown>) => (await prisma.booking.findFirstOrThrow({ where, select: { phone: true } })).phone;

beforeAll(() => { requireTestDatabase(); });
beforeEach(async () => {
  await resetDatabase();
  await seedGuide("G-901", { displayName: "Nok Example" });
});

describe("every import path stores the guest's phone", () => {
  it("create (upsert by externalId) stores Bokun's linkable form, never the seller's number", async () => {
    expect(await importRawBooking(payload({ id: 1001, ref: "GYGTEST1", customer: { phoneNumber: "US+1 5550100123", phoneNumberLinkable: "+15550100123" } }))).toBe("created");
    expect(await phoneOf({ externalId: "1001" })).toBe("+15550100123");
  });

  it("upsert update: a new number replaces the old; a payload with none keeps it; hidden details clear it", async () => {
    await importRawBooking(payload({ id: 1002, ref: "GYGTEST2", customer: { phoneNumber: "+39 333 0100 111" } }));
    await importRawBooking(payload({ id: 1002, ref: "GYGTEST2", customer: { phoneNumber: "+39 333 0100 222" } }));
    expect(await phoneOf({ externalId: "1002" })).toBe("+39 333 0100 222");
    await importRawBooking(payload({ id: 1002, ref: "GYGTEST2" }));
    expect(await phoneOf({ externalId: "1002" })).toBe("+39 333 0100 222");
    await importRawBooking(payload({ id: 1002, ref: "GYGTEST2", customer: { phoneNumber: "+39 333 0100 222", contactDetailsHidden: true } }));
    expect(await phoneOf({ externalId: "1002" })).toBeNull();
  });

  it("the ref match (same OTA booking under a new Bokun id) updates the phone in place", async () => {
    const b = await prisma.booking.create({ data: { source: "GetYourGuide", externalRef: "GYGTEST3", customerName: "Anna Example", date: DATE, slotIdx: 0, status: "PENDING" } });
    expect(await importRawBooking(payload({ id: 1003, ref: "GYGTEST3", customer: { mobilePhone: "+49 151 0100 333" } }))).toBe("updated");
    expect(await phoneOf({ id: b.id })).toBe("+49 151 0100 333");
  });

  it("no externalId: create stores it, and a re-import by code updates it", async () => {
    const base = { confirmationCode: "FOLK-TEST-4", customerName: "Ben Example", date: DATE, slotIdx: 0, pax: 2 };
    expect(await importParsed({ ...base, phone: "0810100444" }, { source: "website", cancelled: false })).toBe("created");
    expect(await phoneOf({ confirmationCode: "FOLK-TEST-4" })).toBe("0810100444");
    expect(await importParsed({ ...base, phone: "+66810100445" }, { source: "website", cancelled: false })).toBe("updated");
    expect(await phoneOf({ confirmationCode: "FOLK-TEST-4" })).toBe("+66810100445");
    expect(await importParsed({ ...base, phoneHidden: true }, { source: "website", cancelled: false })).toBe("updated");
    expect(await phoneOf({ confirmationCode: "FOLK-TEST-4" })).toBeNull();
  });

  it("an exact duplicate is removed, and its number moves to the row that stays when that row has none", async () => {
    const kept = await prisma.booking.create({ data: { source: "GetYourGuide", externalId: "0999", externalRef: "GYGTEST5", confirmationCode: "CODE-GYGTEST5", customerName: "Anna Example", date: DATE, slotIdx: 0, status: "PENDING" } });
    await importRawBooking(payload({ id: 1005, ref: "GYGTEST5", customer: { phoneNumber: "+61 400 010 555" } }));
    const dupe = await prisma.booking.findFirstOrThrow({ where: { externalId: "1005" } });
    expect(dupe.status).toBe("IGNORED");
    expect(await phoneOf({ id: kept.id })).toBe("+61 400 010 555");
  });

  it("an exact duplicate never overwrites a number the kept row already has", async () => {
    const kept = await prisma.booking.create({ data: { source: "GetYourGuide", externalId: "0998", externalRef: "GYGTEST6", confirmationCode: "CODE-GYGTEST6", customerName: "Anna Example", date: DATE, slotIdx: 0, status: "PENDING", phone: "+61 400 010 600" } });
    await importRawBooking(payload({ id: 1006, ref: "GYGTEST6", customer: { phoneNumber: "+61 400 010 666" } }));
    expect(await phoneOf({ id: kept.id })).toBe("+61 400 010 600");
  });
});

describe("who gets a WhatsApp link", () => {
  async function departure() {
    await seedGuide("G-902", { displayName: "Somchai Sample" });
    await prisma.tour.upsert({ where: { id: "T-901" }, update: {}, create: { id: "T-901", name: "Night Market", time: "08:30", durationMin: 120 } });
    for (const g of ["G-901", "G-902"]) await prisma.assignment.create({ data: { guideId: g, date: DATE, slotIdx: 0, tourId: "T-900", pax: 4 } });
    const mk = (ref: string, over: Record<string, unknown>) => prisma.booking.create({ data: { source: "GetYourGuide", externalRef: ref, customerName: `Guest ${ref}`, date: DATE, slotIdx: 0, tourId: "T-900", pax: 2, status: "ASSIGNED", ...over } });
    await mk("GYGMINE", { assignedGuideId: "G-901", phone: "081-010-0777" });
    await mk("GYGOTHER", { assignedGuideId: "G-902", phone: "+49 151 0100 888" });
    await mk("GYGGONE", { assignedGuideId: "G-901", phone: "+39 333 0100 999", status: "CANCELLED" });
    await mk("GYGBARE", { assignedGuideId: "G-901", phone: "5550100" });
    await mk("GYGNONE", { assignedGuideId: "G-901", phone: null });
    await mk("GYGTOUR", { assignedGuideId: "G-901", phone: "+44 7700 900111", tourId: "T-901" });
  }

  it("the assigned guide gets only their own live guests with a readable number", async () => {
    await departure();
    const c = await guestContactsFor(prisma, { isOps: false, guideId: "G-901" }, { guideId: "G-901", date: DATE, slotIdx: 0 });
    expect(c).toEqual({ GYGMINE: { whatsapp: "https://wa.me/66810100777", display: "+66810100777" } });
  });

  it("the other guide of a split departure gets their own guest and never the first guide's", async () => {
    await departure();
    expect(Object.keys(await guestContactsFor(prisma, { isOps: false, guideId: "G-902" }, { guideId: "G-902", date: DATE, slotIdx: 0 }))).toEqual(["GYGOTHER"]);
    // Asking for somebody else's job returns nothing at all.
    expect(await guestContactsFor(prisma, { isOps: false, guideId: "G-902" }, { guideId: "G-901", date: DATE, slotIdx: 0 })).toEqual({});
  });

  it("a guide no longer assigned gets nothing; an operator still sees the job's guests", async () => {
    await departure();
    await prisma.assignment.delete({ where: { guideId_date_slotIdx: { guideId: "G-901", date: DATE, slotIdx: 0 } } });
    await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-20990310-01", guideId: "G-901", date: DATE, slotIdx: 0, tourId: "T-900", expenses: [] as never } });
    expect(await guestContactsFor(prisma, { isOps: false, guideId: "G-901" }, { guideId: "G-901", date: DATE, slotIdx: 0 })).toEqual({});
    expect(Object.keys(await guestContactsFor(prisma, { isOps: true, guideId: null }, { guideId: "G-901", date: DATE, slotIdx: 0 }))).toEqual(["GYGMINE"]);
  });

  it("a departure with one guide and no tags gives every live guest of that tour", async () => {
    await prisma.assignment.create({ data: { guideId: "G-901", date: DATE, slotIdx: 0, tourId: "T-900", pax: 4 } });
    await prisma.booking.createMany({ data: [
      { source: "Viator.com", externalRef: "VIA1", customerName: "Guest One", date: DATE, slotIdx: 0, tourId: "T-900", status: "ASSIGNED", phone: "GB+44 7700 900222" },
      { source: "GetYourGuide", externalRef: "GYG2", customerName: "Guest Two", date: DATE, slotIdx: 0, tourId: "T-900", status: "PENDING", phone: "+972 52 010 0333" },
    ] });
    expect(await guestContactsFor(prisma, { isOps: false, guideId: "G-901" }, { guideId: "G-901", date: DATE, slotIdx: 0 })).toEqual({
      VIA1: { whatsapp: "https://wa.me/447700900222", display: "+447700900222" },
      GYG2: { whatsapp: "https://wa.me/972520100333", display: "+972520100333" },
    });
  });

  it("the guide job screen lists a split departure but gives phones only for the guide's own share", async () => {
    await departure();
    const d = (await guideTourDetails("G-901", DATE, 0))!;
    const byRef = Object.fromEntries(d.bookings.map((b) => [b.externalRef, b.phone]));
    expect(byRef.GYGMINE).toBe("081-010-0777");
    expect(byRef.GYGOTHER).toBeNull();
  });

  it("looking up contacts writes nothing — no phone lands on the job sheet", async () => {
    await departure();
    const sheet = await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-20990310-02", guideId: "G-901", date: DATE, slotIdx: 0, tourId: "T-900", expenses: [] as never,
      bookings: [{ name: "Guest GYGMINE", bookingNo: "GYGMINE", bookedPax: 2, actualPax: null, tickets: "", status: "" }] as never } });
    await guestContactsFor(prisma, { isOps: false, guideId: "G-901" }, { guideId: "G-901", date: DATE, slotIdx: 0 });
    const after = await prisma.jobSheet.findUniqueOrThrow({ where: { id: sheet.id } });
    expect(after.updatedAt.getTime()).toBe(sheet.updatedAt.getTime());
    expect(JSON.stringify(after.bookings)).not.toMatch(/0100|wa\.me|phone/);
  });
});
