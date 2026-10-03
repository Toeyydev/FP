import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { createCertificate, CertificateRefused } from "./service";

// The advance-paid certificate against a real database: it lives beside the guide-paid one
// on the same job sheet (one live certificate per sheet PER KIND), lists the advances its
// rows were paid from, and a food cost is certified only on a food tour. All data invented.
const KEY = { guideId: "G-990", date: "2025-03-09", slotIdx: 0 };
const actor = { id: "u_admin", name: "Admin Example", role: "ADMIN" };
const op = { paidBySource: "operator", paidByAt: "2025-03-09T12:00:00Z", paidByBy: "u_op" };

beforeAll(requireTestDatabase);
beforeEach(async () => { await resetDatabase(); await seedGuide("G-990"); });

async function sheet(tourName: string, extra: object[] = []) {
  await prisma.tour.upsert({ where: { id: "T-950" }, update: { name: tourName }, create: { id: "T-950", name: tourName, time: "13:30", durationMin: 180 } });
  const adv = await prisma.guideAdvance.create({ data: { guideId: "G-990", date: KEY.date, slotIdx: 0, amount: 1000, paidAt: new Date(), txRef: "TRXX0001", advanceNo: "FOLK-ADV-202503-901", advanceDate: KEY.date, amountSatang: 100000, accountingPeriod: "2025-03" } });
  return prisma.jobSheet.create({ data: { ...KEY, tourId: "T-950", status: "Confirmed", ref: "FOLK-TEST-CERT-02", bookings: [],
    expenses: [
      { description: "Temple ticket", price: 500, pax: 2, expenseType: "entrance", paidBy: "advance", advanceId: adv.id, ...op },
      { description: "Water (Inc. Guide)", price: 10, pax: 3, expenseType: "meal", paidBy: "guide", ...op },
      ...extra,
    ] } });
}

describe("a certificate for costs paid from a company advance", () => {
  it("is issued beside the guide-paid one, names its advance, and a second live one of its kind is refused", async () => {
    await sheet("Riverside Temples");
    const guide = await createCertificate(KEY, actor, {}, "ADMIN_RECORDED");
    const adv = await createCertificate(KEY, actor, {}, "ADMIN_RECORDED", "COMPANY_ADVANCE");
    expect(guide.kind).toBe("GUIDE_PAID");
    expect(adv.kind).toBe("COMPANY_ADVANCE");
    expect((adv.coveredRows as { description: string }[]).map((r) => r.description)).toEqual(["Temple ticket"]);
    expect((adv.payload as { advances?: string[]; kind?: string })).toMatchObject({ kind: "COMPANY_ADVANCE", advances: ["FOLK-ADV-202503-901"] });
    expect((guide.payload as { kind?: string }).kind).toBeUndefined();
    await expect(createCertificate(KEY, actor, {}, "ADMIN_RECORDED", "COMPANY_ADVANCE")).rejects.toBeInstanceOf(CertificateRefused);
  });

  it("a food cost is covered on an 'Eat like a local' tour and not on another tour", async () => {
    const lunch = { description: "Food Cost", price: 650, pax: 1, expenseType: "meal", paidBy: "guide", ...op };
    await sheet("Eat Like a Local — Example", [lunch]);
    const onFoodTour = await createCertificate(KEY, actor, {}, "ADMIN_RECORDED");
    expect((onFoodTour.coveredRows as { description: string }[]).map((r) => r.description)).toEqual(["Water (Inc. Guide)", "Food Cost"]);
    await resetDatabase(); await seedGuide("G-990");
    await sheet("Riverside Temples", [lunch]);
    const elsewhere = await createCertificate(KEY, actor, {}, "ADMIN_RECORDED");
    expect((elsewhere.coveredRows as { description: string }[]).map((r) => r.description)).toEqual(["Water (Inc. Guide)"]);
  });
});
