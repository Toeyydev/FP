import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// Creating the job sheets missing from upcoming jobs — admin only, exactly the previewed list.
// Real database. All data invented — this repo is public.
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);

import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { POST } from "@/app/api/admin/job-sheets-backfill/route";

const day = (n: number) => new Date(Date.now() + 7 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);
const G = "G-977";
let admin: { id: string }, op: { id: string };
const call = async (body: object) => { const r = await POST(new Request("http://test.local/api/admin/job-sheets-backfill", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) as never); return { status: r.status, body: await r.json() }; };

beforeAll(requireTestDatabase);
beforeEach(async () => {
  await resetDatabase();
  await seedGuide(G, { email: "g977@example.test" });
  admin = await prisma.user.create({ data: { email: "admin-bf@example.test", displayName: "Admin Example", role: "ADMIN", state: "ACTIVE" } });
  op = await prisma.user.create({ data: { email: "op-bf@example.test", displayName: "Op Example", role: "OPERATOR", state: "ACTIVE" } });
  authMock.auth.mockResolvedValue({ user: { id: admin.id, role: "ADMIN" } });
  for (const n of [-2, 3, 5]) await prisma.assignment.create({ data: { guideId: G, date: day(n), slotIdx: 0, tourId: "T-900", pax: 2 } });
  await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-BF-05", guideId: G, date: day(5), slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [], expenses: [], guideFee: {} } });
});

describe("creating the missing job sheets of upcoming jobs", () => {
  it("previews only upcoming jobs with no sheet, then creates exactly those, numbered", async () => {
    const p = await call({ action: "preview" });
    expect(p.status).toBe(200);
    expect(p.body.jobs.map((j: { date: string }) => j.date)).toEqual([day(3)]); // past (−2) and one with a sheet (+5) left alone
    const r = await call({ action: "apply", hash: p.body.hash });
    expect(r.status).toBe(200);
    expect(r.body.created).toEqual([expect.objectContaining({ date: day(3), ref: expect.stringMatching(/^FOLK-BKK-\d{8}-\d{2}$/) })]);
    expect(await prisma.jobSheet.count()).toBe(2);
    expect(await prisma.auditLog.findFirst({ where: { action: "jobsheet.backfill_created" } })).toMatchObject({ actorId: admin.id });
  });
  it("refuses if the list changed since the preview", async () => {
    const p = await call({ action: "preview" });
    await prisma.assignment.create({ data: { guideId: G, date: day(6), slotIdx: 0, tourId: "T-900", pax: 2 } });
    expect((await call({ action: "apply", hash: p.body.hash })).status).toBe(409);
    expect(await prisma.jobSheet.count()).toBe(1);
  });
  it("an operator cannot, nor a session claiming ADMIN for someone who is not", async () => {
    authMock.auth.mockResolvedValue({ user: { id: op.id, role: "OPERATOR" } });
    expect((await call({ action: "preview" })).status).toBe(403);
    authMock.auth.mockResolvedValue({ user: { id: op.id, role: "ADMIN" } });
    expect((await call({ action: "preview" })).status).toBe(403);
  });
});
