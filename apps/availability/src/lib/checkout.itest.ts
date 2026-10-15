import { describe, it, expect, beforeAll, beforeEach } from "vitest";

// Check-out (END) — its own step with the guide's location, after the tour has started and
// before the report; never a way around the report. Real database. All data invented.
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { recordCheckin } from "@/lib/guide-lifecycle";

const G = "G-974";
const DATE = "2099-05-10";
const NOW = Date.parse("2099-05-10T05:00:00Z"); // 12:00 Bangkok, the tour started 08:30
const press = (type: "ARRIVE" | "START" | "END" | "COMPLETE", gps = { lat: 13.75, lng: 100.49, accuracyM: 12 }) =>
  recordCheckin({ guideId: G, date: DATE, slotIdx: 0, type, ...gps, actorId: null }, NOW);

beforeAll(requireTestDatabase);
beforeEach(async () => {
  await resetDatabase();
  await seedGuide(G);
  await prisma.tour.update({ where: { id: "T-900" }, data: { meetingLat: 13.7500, meetingLng: 100.4900, meetingRadiusM: 150 } });
  await prisma.assignment.create({ data: { guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", pax: 2 } });
});

describe("check-out", () => {
  it("is refused before the tour has started", async () => {
    await press("ARRIVE");
    expect(await press("END")).toMatchObject({ ok: false, status: 409, error: "not-started" });
  });
  it("after the start: stored with the time and where the guide was", async () => {
    await press("ARRIVE"); await press("START");
    expect(await press("END", { lat: 13.7700, lng: 100.4900, accuracyM: 20 })).toMatchObject({ ok: true, type: "END" });
    const end = await prisma.checkin.findFirstOrThrow({ where: { type: "END" } });
    expect(end).toMatchObject({ lat: 13.77, lng: 100.49, accuracyM: 20, withinGeofence: false, recordedByRole: null });
    expect(end.distanceM).toBeGreaterThan(2000);
  });
  it("once only — and it does not finish the job: the report is still needed", async () => {
    await press("ARRIVE"); await press("START"); await press("END");
    expect(await press("END")).toMatchObject({ ok: false, error: "already-ended" });
    expect(await press("COMPLETE")).toMatchObject({ ok: false, error: "use-the-report" });
  });
});
