import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// Jobs → Upcoming assigned jobs, on a real database. All data invented.
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { GET } from "./route";
import { addDays, bkkToday } from "@/lib/upcoming-assigned";

const TODAY = bkkToday();
const IN20 = addDays(TODAY, 20);
const get = async (qs = "") => { const r = await GET(new NextRequest(`https://ops.example.test/api/ops/assigned-jobs${qs}`)); return { status: r.status, body: await r.json() }; };
const as = (role: string) => authMock.auth.mockResolvedValue({ user: { id: `u_${role}`, role } });

beforeAll(requireTestDatabase);
beforeEach(async () => {
  await resetDatabase();
  await seedGuide("G-961", { displayName: "Ploy Example", email: "g961@example.test" });
  await seedGuide("G-962", { displayName: "Nok Example", email: "g962@example.test" });
  // Accepted 20 days ahead: beyond Tomorrow and Next 7 days.
  await prisma.assignment.create({ data: { guideId: "G-961", date: IN20, slotIdx: 0, tourId: "T-900", pax: 2 } });
  // Two guides on one departure.
  for (const g of ["G-961", "G-962"]) await prisma.assignment.create({ data: { guideId: g, date: addDays(TODAY, 12), slotIdx: 2, tourId: "T-900", pax: 6 } });
  // Offered, nobody has answered: not an assignment.
  await prisma.jobOffer.create({ data: { tourId: "T-900", date: addDays(TODAY, 15), slotIdx: 0, pax: 3, status: "OPEN", expiresAt: new Date(Date.now() + 3600_000) } });
});

describe("who may see it", () => {
  it("operators and admins see every guide; a guide and an accountant are refused", async () => {
    for (const role of ["OPERATOR", "ADMIN"]) {
      as(role);
      const { status, body } = await get();
      expect(status).toBe(200);
      expect(new Set(body.departures.flatMap((d: { guides: { guideId: string }[] }) => d.guides.map((g) => g.guideId)))).toEqual(new Set(["G-961", "G-962"]));
    }
    for (const role of ["GUIDE", "ACCOUNTANT"]) { as(role); expect((await get()).status).toBe(403); }
  });
});

describe("the list", () => {
  beforeEach(() => as("OPERATOR"));
  it("a job accepted 20 days ahead is listed by default and found by the guide's name", async () => {
    const all = (await get()).body;
    expect(all.departures.some((d: { date: string }) => d.date === IN20)).toBe(true);
    const byName = (await get("?q=ploy")).body;
    expect(byName.departures.map((d: { date: string }) => d.date)).toEqual([addDays(TODAY, 12), IN20]);
    expect((await get("?q=G-962")).body.departures).toHaveLength(1);
  });
  it("an offer still waiting for an answer is not listed", async () => {
    const { body } = await get();
    expect(body.departures.some((d: { date: string }) => d.date === addDays(TODAY, 15))).toBe(false);
  });
  it("a departure with two guides lists both, each with their own job", async () => {
    const d = (await get()).body.departures.find((x: { date: string }) => x.date === addDays(TODAY, 12));
    expect(d.guides.map((g: { guideId: string; name: string }) => `${g.guideId} ${g.name}`)).toEqual(["G-961 Ploy Example", "G-962 Nok Example"]);
    expect(d.time).toBe("13:30");
  });
  it("a removed assignment is gone", async () => {
    await prisma.assignment.deleteMany({ where: { date: IN20 } });
    expect((await get()).body.departures.some((d: { date: string }) => d.date === IN20)).toBe(false);
  });
  it("nothing is cut at 200: 250 jobs in range all come back, and a far one is found by name", async () => {
    // Ten more guides × 25 days, one departure a day each.
    await prisma.user.createMany({ data: Array.from({ length: 10 }, (_, i) => ({ guideId: `G-8${String(i).padStart(2, "0")}`, email: `g8${i}@example.test`, displayName: `Guide ${i}`, role: "GUIDE", state: "ACTIVE" })) });
    const rows = Array.from({ length: 250 }, (_, i) => ({ guideId: `G-8${String(i % 10).padStart(2, "0")}`, date: addDays(TODAY, 1 + Math.floor(i / 10)), slotIdx: 5, tourId: "T-900", pax: 1 }));
    await prisma.assignment.createMany({ data: rows });
    const far = addDays(TODAY, 200);
    await prisma.assignment.create({ data: { guideId: "G-961", date: far, slotIdx: 0, tourId: "T-900", pax: 2 } });
    const { body } = await get(`?from=${addDays(TODAY, 1)}&to=${addDays(TODAY, 300)}`);
    expect(body.jobs).toBe(250 + 1 + 2 + 1);
    expect((await get(`?from=${addDays(TODAY, 1)}&to=${addDays(TODAY, 300)}&q=Ploy`)).body.departures.some((d: { date: string }) => d.date === far)).toBe(true);
  });
  it("a backwards range is refused with a hint", async () => {
    const { status, body } = await get(`?from=${IN20}&to=${TODAY}`);
    expect(status).toBe(400);
    expect(body.hint).toMatch(/From date/);
  });
});
