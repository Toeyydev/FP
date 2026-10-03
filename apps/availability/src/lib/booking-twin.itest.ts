import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A booking arrives twice — once from the webhook, once from the search sync — with different
// product names. When the channel renames a product, only one copy may be mapped to a tour.
// The duplicate check keeps the first copy and hides the second; when the first has no tour,
// the booking used to vanish from every board although its hidden twin knew the tour.
// Every name, reference and date below is invented — this repo is public.

vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPushToUser: vi.fn(async () => 0) }));
vi.mock("@/lib/line", async (orig) => ({ ...(await orig<typeof import("@/lib/line")>()), lineEnabled: false, linePush: vi.fn(async () => true), linePushFlex: vi.fn(async () => true) }));
vi.mock("@/lib/email", async (orig) => ({ ...(await orig<typeof import("@/lib/email")>()), sendEmail: vi.fn(async () => true) }));

import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { importParsed } from "@/lib/booking-import";
import { productKey, type ParsedBooking } from "@/lib/bookings";

const DATE = new Date(Date.now() + 9 * 86400_000 + 7 * 3600_000).toISOString().slice(0, 10);
const REF = "GYGEXAMPLETWIN1";
const RENAMED = "Bangkok : Renamed Half-Day Example Tour";   // the channel's new title — not mapped
const CHANNEL = "ExampleChannel";                            // what the search copy carries — mapped
const parsed = (code: string, productName: string, over: Partial<ParsedBooking> = {}): ParsedBooking =>
  ({ externalRef: REF, confirmationCode: code, customerName: "Guest Twin Example", date: DATE, slotIdx: 2, pax: 4, productName, ...over });
const live = () => prisma.booking.findMany({ where: { externalRef: REF, status: { notIn: ["IGNORED", "CANCELLED"] } } });
const all = () => prisma.booking.findMany({ where: { externalRef: REF }, orderBy: { createdAt: "asc" } });

beforeAll(requireTestDatabase);
beforeEach(async () => {
  await resetDatabase();
  await seedGuide("G-951");
  await prisma.productMap.deleteMany({});
  await prisma.productMap.create({ data: { productKey: productKey(CHANNEL), productName: CHANNEL, tourId: "T-900" } });
});

describe("a duplicate that knows the booking's tour hands it to the copy that stays", () => {
  it("webhook copy first with no tour, search copy second with one: one live booking, on the tour", async () => {
    await importParsed(parsed("FOLK-TEXAMPLE1", RENAMED), { source: "GetYourGuide", cancelled: false, via: "webhook" });
    expect((await live())[0].tourId).toBeNull();
    await importParsed(parsed("GET-EXAMPLE1", CHANNEL), { source: "GetYourGuide", cancelled: false, via: "autosync" });

    const rows = await all();
    expect(rows.map((r) => [r.confirmationCode, r.status, r.tourId])).toEqual([["FOLK-TEXAMPLE1", "PENDING", "T-900"], ["GET-EXAMPLE1", "IGNORED", "T-900"]]);
    expect(await live()).toHaveLength(1);
  });

  it("the copy that stays keeps a tour it already has — the duplicate's never overwrites it", async () => {
    await prisma.productMap.create({ data: { productKey: productKey(RENAMED), productName: RENAMED, tourId: "T-900" } });
    await prisma.tour.create({ data: { id: "T-901", name: "Other Example Tour", time: "13:30", durationMin: 180 } });
    await prisma.productMap.update({ where: { productKey: productKey(CHANNEL) }, data: { tourId: "T-901" } });
    await importParsed(parsed("FOLK-TEXAMPLE2", RENAMED), { source: "GetYourGuide", cancelled: false, via: "webhook" });
    await importParsed(parsed("GET-EXAMPLE2", CHANNEL), { source: "GetYourGuide", cancelled: false, via: "autosync" });
    const kept = (await live())[0];
    expect([kept.confirmationCode, kept.tourId]).toEqual(["FOLK-TEXAMPLE2", "T-900"]);
  });

  it("neither copy mapped: nothing is invented, the booking stays without a tour for an operator to map", async () => {
    await importParsed(parsed("FOLK-TEXAMPLE3", RENAMED), { source: "GetYourGuide", cancelled: false, via: "webhook" });
    await importParsed(parsed("GET-EXAMPLE3", "Another Unmapped Title"), { source: "GetYourGuide", cancelled: false, via: "autosync" });
    expect((await live()).map((r) => r.tourId)).toEqual([null]);
  });

  it("a different booking under the same name on the slot is not a duplicate, and gets nothing from it", async () => {
    await importParsed(parsed("FOLK-TEXAMPLE4", RENAMED), { source: "GetYourGuide", cancelled: false, via: "webhook" });
    await importParsed(parsed("GET-EXAMPLE4", CHANNEL, { externalRef: "GYGEXAMPLEOTHER" }), { source: "GetYourGuide", cancelled: false, via: "autosync" });
    const first = await prisma.booking.findFirstOrThrow({ where: { confirmationCode: "FOLK-TEXAMPLE4" } });
    expect(first.tourId).toBeNull();
    expect(await prisma.booking.count({ where: { status: { notIn: ["IGNORED", "CANCELLED"] } } })).toBe(2);
  });

  it("an unmapped product name alerts operators once — not again for its next booking, and not for a mapped one", async () => {
    const op = await prisma.user.create({ data: { email: "op-twin@example.test", displayName: "Op Example", role: "OPERATOR", state: "ACTIVE" } });
    const alerts = () => prisma.notification.findMany({ where: { userId: op.id, message: { contains: "is not mapped to a tour" } } });
    await importParsed(parsed("FOLK-TEXAMPLE5", RENAMED), { source: "GetYourGuide", cancelled: false, via: "webhook" });
    expect((await alerts()).map((n) => n.message)).toEqual([`New product name "${RENAMED}" is not mapped to a tour — its bookings are on no board. Map it on Product map.`]);
    await importParsed(parsed("FOLK-TEXAMPLE6", RENAMED, { externalRef: "GYGEXAMPLETWIN6", customerName: "Another Guest Example" }), { source: "GetYourGuide", cancelled: false, via: "webhook" });
    expect(await alerts()).toHaveLength(1);
    await importParsed(parsed("GET-EXAMPLE7", CHANNEL, { externalRef: "GYGEXAMPLETWIN7", customerName: "Third Guest Example" }), { source: "GetYourGuide", cancelled: false, via: "autosync" });
    expect(await alerts()).toHaveLength(1);
  });
});
