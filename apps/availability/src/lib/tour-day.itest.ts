import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// Who ran which tour, day by day, against a real database. All data invented — this repo is public.
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { tourDays } from "@/lib/tour-day";
import { GET } from "@/app/api/tour-day/route";

beforeAll(requireTestDatabase);
beforeEach(async () => {
  await resetDatabase();
  await seedGuide("G-901");
  await prisma.tour.upsert({ where: { id: "T-900" }, update: {}, create: { id: "T-900", name: "Riverside Temples", time: "08:30", durationMin: 180 } });
  await prisma.user.updateMany({ where: { guideId: "G-901" }, data: { displayName: "Nok Example" } });
});

const booking = (over: Record<string, unknown>) =>
  prisma.booking.create({ data: { source: "manual", tourId: "T-900", date: "2099-05-10", slotIdx: 2, pax: 2, customerName: "Guest Example", status: "PENDING", ...over } as never });

describe("who guided, day by day", () => {
  it("names the guide on each departure, with today's guest count", async () => {
    await prisma.assignment.create({ data: { guideId: "G-901", date: "2099-05-10", slotIdx: 2, tourId: "T-900", pax: 1 } });
    await booking({ status: "ASSIGNED" });
    await booking({ status: "ASSIGNED", pax: 3 });
    const days = await tourDays("2099-05");
    expect(days["2099-05-10"]).toEqual([expect.objectContaining({ time: "13:30", guideName: "Nok Example", tourName: "Riverside Temples", pax: 5 })]);
  });

  it("a departure with guests and no guide shows as a gap, not as nothing", async () => {
    await booking({ slotIdx: 0, pax: 1 });
    expect((await tourDays("2099-05"))["2099-05-10"]).toEqual([expect.objectContaining({ time: "08:30", guideId: null, pax: 1 })]);
  });

  it("cancelled guests and other months are left out", async () => {
    await booking({ status: "CANCELLED" });
    await booking({ date: "2099-06-01" });
    expect(await tourDays("2099-05")).toEqual({});
  });

  it("operators and admins only", async () => {
    const ask = () => GET(new NextRequest("http://test.local/api/tour-day?month=2099-05"));
    authMock.auth.mockResolvedValue({ user: { id: "g", role: "GUIDE", guideId: "G-901" } });
    expect((await ask()).status).toBe(403);
    authMock.auth.mockResolvedValue({ user: { id: "o", role: "OPERATOR" } });
    expect((await ask()).status).toBe(200);
  });
});
