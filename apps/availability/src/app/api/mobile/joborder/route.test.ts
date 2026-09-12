import { vi, describe, it, expect, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  jobSheet: { findUnique: vi.fn() },
  assignment: { findUnique: vi.fn() },
  tour: { findUnique: vi.fn() },
  booking: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

import { GET } from "./route";
import { mintMobileAccessToken } from "@/lib/mobile-auth";

const guide = { id: "u_1", email: "mali@example.test", displayName: "Mali", role: "GUIDE", state: "ACTIVE", guideId: "G-001" };

const get = (query: string, token?: string) => GET(new Request(`https://ops.folkpaths.com/api/mobile/joborder?${query}`, {
  headers: token ? { authorization: `Bearer ${token}` } : {},
}));

let token = "";
beforeEach(async () => {
  vi.clearAllMocks();
  // The token check finds the account by id; the order finds the guide by guideId.
  prismaMock.user.findUnique.mockImplementation(async ({ where }: { where: { id?: string; guideId?: string } }) =>
    where.id === "u_1" ? { ...guide, state: "ACTIVE" } : { fullName: "Mali Srisuk", displayName: "Mali", licenseNo: "11/12345" });
  prismaMock.jobSheet.findUnique.mockResolvedValue({ ref: "FOLK-BKK-20260920-1", tourId: "t1", guideFee: { price: 1200 }, bookings: [{ name: "A Guest", bookingNo: "GYG-1", bookedPax: 2, actualPax: null, tickets: "", status: "" }] });
  prismaMock.assignment.findUnique.mockResolvedValue({ tourId: "t1", pax: 2 });
  prismaMock.tour.findUnique.mockResolvedValue({ id: "t1", name: "Wat Pho & Wat Arun", time: "13:30" });
  prismaMock.booking.findMany.mockResolvedValue([]);
  ({ token } = await mintMobileAccessToken(guide));
});

describe("GET /api/mobile/joborder", () => {
  it("answers 401 without a bearer token", async () => {
    expect((await get("date=2026-09-20&slotIdx=2")).status).toBe(401);
  });

  it("answers with the order for the assigned departure", async () => {
    const res = await get("date=2026-09-20&slotIdx=2", token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ref: "FOLK-BKK-20260920-1", date: "2026-09-20", slotIdx: 2, time: "13:30",
      guide: { guideId: "G-001", name: "Mali Srisuk", licenseNo: "11/12345" },
      tour: { name: "Wat Pho & Wat Arun" }, rate: 1200, pax: 2,
    });
    expect(body.operator.license).toBeTruthy();
    expect(body.bookings).toHaveLength(1);
  });

  it("takes the guide from the token, never from the query", async () => {
    await get("date=2026-09-20&slotIdx=2&guideId=G-999", token);
    const asked = prismaMock.assignment.findUnique.mock.calls.map(([a]) => a.where.guideId_date_slotIdx.guideId);
    expect(asked).toEqual(["G-001"]);
  });

  it("refuses a departure this guide was never given", async () => {
    prismaMock.assignment.findUnique.mockResolvedValue(null);
    const res = await get("date=2026-09-20&slotIdx=2", token);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not-assigned");
  });

  it("refuses a date or slot it cannot read", async () => {
    for (const q of ["date=20-09-2026&slotIdx=2", "date=2026-09-20", "date=2026-09-20&slotIdx=-1", "date=2026-09-20&slotIdx=x"]) {
      expect((await get(q, token)).status).toBe(400);
    }
  });
});
