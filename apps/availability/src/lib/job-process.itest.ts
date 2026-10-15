import { describe, it, expect, beforeAll, beforeEach } from "vitest";

// One job at each stage of the process, in a real database: the loader must put each on the
// step it has really reached, in the lane of whoever has to act. All data invented.
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { loadJobProcess } from "@/lib/job-process-server";

const NOW = new Date("2025-03-10T05:00:00Z"); // 12:00 Bangkok, 10 Mar 2025
const G = "G-960";
const FEE = { price: 1000, time: 1, whtPct: 3 };
let n = 0;
const booking = (date: string, slotIdx: number, pax = 2, over: Record<string, unknown> = {}) =>
  prisma.booking.create({ data: { source: "Example OTA", externalRef: `JP-${++n}`, confirmationCode: `JP-${n}`, customerName: `Guest ${n}`, date, slotIdx, tourId: "T-900", pax, status: "PENDING", ...over } as never });
const assign = (date: string, slotIdx = 0, guideId = G) => prisma.assignment.create({ data: { guideId, date, slotIdx, tourId: "T-900", pax: 2 } });
const sheet = (date: string, over: Record<string, unknown> = {}, slotIdx = 0) =>
  prisma.jobSheet.create({ data: { ref: `FOLK-TEST-JP-${date.slice(8)}`, guideId: G, date, slotIdx, tourId: "T-900", status: "Confirmed", bookings: [], guideFee: FEE, expenses: [], ...over } as never });
const stageOf = async (date: string, slotIdx = 0) => (await loadJobProcess(prisma, { from: "2025-02-20", to: "2025-03-20" }, NOW)).find((j) => j.date === date && j.slotIdx === slotIdx);

beforeAll(requireTestDatabase);
beforeEach(async () => { await resetDatabase(); await seedGuide(G); n = 0; });

describe("the stage each job has reached", () => {
  it("nobody holds the departure: booking received → offer sent → offer came back", async () => {
    await booking("2025-03-12", 0, 3);
    expect(await stageOf("2025-03-12")).toMatchObject({ stage: "BOOKING_RECEIVED", lane: "ADMIN", guideId: null, pax: 3, bookings: 1, href: "/jobs" });
    const offer = await prisma.jobOffer.create({ data: { tourId: "T-900", date: "2025-03-12", slotIdx: 0, status: "OPEN", expiresAt: new Date("2025-03-10T06:00:00Z"), responses: { create: [{ guideId: G, response: "OFFERED" }] } } });
    expect(await stageOf("2025-03-12")).toMatchObject({ stage: "OFFER_SENT", lane: "GUIDE" });
    await prisma.jobOfferResponse.updateMany({ where: { offerId: offer.id }, data: { response: "DENIED" } });
    expect(await stageOf("2025-03-12")).toMatchObject({ stage: "OFFER_RETURNED", lane: "ADMIN" });
    // …and an offer nobody answered in time is back with the admin too.
    await prisma.jobOfferResponse.updateMany({ where: { offerId: offer.id }, data: { response: "OFFERED" } });
    await prisma.jobOffer.update({ where: { id: offer.id }, data: { expiresAt: new Date("2025-03-10T04:00:00Z") } });
    expect(await stageOf("2025-03-12")).toMatchObject({ stage: "OFFER_RETURNED" });
  });

  it("the guide's part: assigned → on tour → owing the report", async () => {
    await assign("2025-03-11");                      // tomorrow
    await assign("2025-03-10", 2);                   // today 13:30, not started
    await assign("2025-03-10", 0);                   // today 08:30, checked in
    await prisma.checkin.create({ data: { guideId: G, date: "2025-03-10", slotIdx: 0, tourId: "T-900", type: "ARRIVE" } });
    await assign("2025-03-08");                      // two days ago, nothing filed
    expect(await stageOf("2025-03-11")).toMatchObject({ stage: "ASSIGNED", lane: "GUIDE", waitingDays: null });
    expect(await stageOf("2025-03-10", 2)).toMatchObject({ stage: "ASSIGNED" });
    expect(await stageOf("2025-03-10", 0)).toMatchObject({ stage: "CHECKED_IN", lane: "GUIDE" });
    expect(await stageOf("2025-03-08")).toMatchObject({ stage: "AWAITING_REPORT", lane: "GUIDE", waitingDays: 2 });
  });

  it("the admin's part: to review → to pay → paid, not in PEAK → closed", async () => {
    for (const d of ["2025-03-01", "2025-03-02", "2025-03-03", "2025-03-04"]) await assign(d);
    await prisma.tourReport.create({ data: { guideId: G, date: "2025-03-01", slotIdx: 0, tourId: "T-900" } });
    await sheet("2025-03-02", { approvalStatus: "APPROVED" });
    await sheet("2025-03-03", { approvalStatus: "APPROVED" });
    await prisma.tourPayment.create({ data: { guideId: G, date: "2025-03-03", slotIdx: 0, tourId: "T-900", status: "PAID", paidAt: NOW } });
    await sheet("2025-03-04", { approvalStatus: "APPROVED" });
    await prisma.tourPayment.create({ data: { guideId: G, date: "2025-03-04", slotIdx: 0, tourId: "T-900", status: "PAID", paidAt: NOW, peakRef: "EXP-TEST-0001" } });
    expect(await stageOf("2025-03-01")).toMatchObject({ stage: "AWAITING_REVIEW", lane: "ADMIN", href: `/job-sheet?guideId=${G}&date=2025-03-01&slotIdx=0` });
    expect(await stageOf("2025-03-02")).toMatchObject({ stage: "AWAITING_TRANSFER", lane: "ADMIN", href: "/payments", jobNo: "FOLK-TEST-JP-02" });
    expect(await stageOf("2025-03-03")).toMatchObject({ stage: "AWAITING_PEAK", lane: "ADMIN" });
    expect(await stageOf("2025-03-04")).toMatchObject({ stage: "CLOSED", lane: "DONE", waitingDays: null });
  });

  it("a guide's own view holds only their jobs, and no unassigned departures", async () => {
    await seedGuide("G-961", { email: "g961@example.test" });
    await assign("2025-03-11"); await assign("2025-03-11", 2, "G-961"); await booking("2025-03-12", 0);
    const mine = await loadJobProcess(prisma, { from: "2025-03-01", to: "2025-03-20", guideId: G }, NOW);
    expect(mine.map((j) => [j.guideId, j.date])).toEqual([[G, "2025-03-11"]]);
  });
});
