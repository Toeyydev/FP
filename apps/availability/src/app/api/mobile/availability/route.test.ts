import { vi, describe, it, expect, beforeEach } from "vitest";

// The route runs the real rules (lib/guide-availability); only the database is a
// stand-in. The profile-completeness helper is real too, so a half-filled account
// is refused here exactly as it is on the web.
const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  availability: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
  blockedDate: { findUnique: vi.fn() },
  assignment: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

import { GET, PUT } from "./route";
import { mintMobileAccessToken } from "@/lib/mobile-auth";
import { SLOT_COUNT } from "@/lib/slots";
import { PROFILE_STATUS_SELECT } from "@/lib/profile";

const guide = { id: "u_1", email: "mali@example.com", displayName: "Mali", role: "GUIDE", state: "ACTIVE", guideId: "G-001" };
// The real guideProfileStatus decides what "complete" means, so build the fixture
// from the same list it checks — then a new required field cannot quietly turn
// these tests red for the wrong reason.
const completeProfile = Object.fromEntries(Object.keys(PROFILE_STATUS_SELECT).map((k) => [k, "filled in"]));

const free = () => Array(SLOT_COUNT).fill(false) as boolean[];
const get = (q: string, token?: string) => GET(new Request(`https://ops.folkpaths.com/api/mobile/availability${q}`, {
  headers: token ? { authorization: `Bearer ${token}` } : {},
}));
const put = (body: unknown, token?: string) => PUT(new Request("https://ops.folkpaths.com/api/mobile/availability", {
  method: "PUT", body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
}));

let token = "";
beforeEach(async () => {
  vi.clearAllMocks();
  prismaMock.user.findUnique.mockImplementation(async ({ where }: { where: { id?: string; guideId?: string } }) =>
    where.id === "u_1" || where.guideId === "G-001" ? { ...guide, ...completeProfile } : null);
  prismaMock.availability.findMany.mockResolvedValue([]);
  prismaMock.availability.findUnique.mockResolvedValue(null);
  prismaMock.blockedDate.findUnique.mockResolvedValue(null);
  prismaMock.assignment.findMany.mockResolvedValue([]);
  ({ token } = await mintMobileAccessToken(guide));
});

describe("GET /api/mobile/availability", () => {
  it("answers 401 without a bearer token", async () => {
    expect((await get("?month=2026-09")).status).toBe(401);
    expect(prismaMock.availability.findMany).not.toHaveBeenCalled();
  });

  it("rejects a malformed month", async () => {
    for (const q of ["", "?month=2026-9", "?month=2026", "?month=sept"]) {
      expect((await get(q, token)).status, q).toBe(400);
    }
  });

  it("answers with the guide's own days, keyed by day of month", async () => {
    const busyAfternoon = free(); busyAfternoon[2] = true;
    prismaMock.availability.findMany.mockResolvedValue([
      { date: "2026-09-12", slots: busyAfternoon },
      { date: "2026-09-20", slots: free() },
    ]);
    const res = await get("?month=2026-09", token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ month: "2026-09", days: { 12: busyAfternoon, 20: free() } });
    // Never another guide's.
    expect(prismaMock.availability.findMany.mock.calls[0][0].where).toEqual({ guideId: "G-001", date: { startsWith: "2026-09" } });
  });
});

describe("PUT /api/mobile/availability", () => {
  const body = () => ({ date: "2026-09-20", slots: free() });

  it("answers 401 without a bearer token, and saves nothing", async () => {
    expect((await put(body())).status).toBe(401);
    expect(prismaMock.availability.upsert).not.toHaveBeenCalled();
  });

  it("rejects a malformed body, including a slot array of the wrong length", async () => {
    for (const b of [{}, { date: "2026-9-20", slots: free() }, { date: "2026-09-20", slots: [] }, { date: "2026-09-20", slots: Array(SLOT_COUNT + 1).fill(false) }]) {
      expect((await put(b, token)).status, JSON.stringify(b).slice(0, 40)).toBe(400);
    }
    expect(prismaMock.availability.upsert).not.toHaveBeenCalled();
  });

  it("saves the day for the token's own guide", async () => {
    const slots = free(); slots[0] = true; slots[1] = true;
    expect((await put({ date: "2026-09-20", slots }, token)).status).toBe(200);
    expect(prismaMock.availability.upsert.mock.calls[0][0]).toMatchObject({
      where: { guideId_date: { guideId: "G-001", date: "2026-09-20" } },
      create: { guideId: "G-001", date: "2026-09-20", slots },
      update: { slots },
    });
  });

  it("takes the guide from the token, whatever the body names", async () => {
    await put({ ...body(), guideId: "G-999" }, token);
    expect(prismaMock.availability.upsert.mock.calls[0][0].where.guideId_date.guideId).toBe("G-001");
  });

  it("refuses until the guide has finished their account details", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ ...guide, fullName: null, phone: null, licenseNo: null });
    const res = await put(body(), token);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("profile-incomplete");
    expect(prismaMock.availability.upsert).not.toHaveBeenCalled();
  });

  it("refuses a day the company has closed", async () => {
    prismaMock.blockedDate.findUnique.mockResolvedValue({ date: "2026-09-20", reason: "Company holiday" });
    const res = await put(body(), token);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("date-blocked");
    expect(prismaMock.availability.upsert).not.toHaveBeenCalled();
  });

  it("refuses to change a slot that already carries a job, and names which", async () => {
    prismaMock.assignment.findMany.mockResolvedValue([{ slotIdx: 2 }, { slotIdx: 4 }]);
    prismaMock.availability.findUnique.mockResolvedValue({ slots: free() });
    const slots = free(); slots[2] = true; // trying to block the slot the job is on
    const res = await put({ date: "2026-09-20", slots }, token);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "slot-assigned", slots: [2] });
    expect(prismaMock.availability.upsert).not.toHaveBeenCalled();
  });

  it("still saves when the assigned slots are left exactly as they were", async () => {
    prismaMock.assignment.findMany.mockResolvedValue([{ slotIdx: 2 }]);
    prismaMock.availability.findUnique.mockResolvedValue({ slots: free() });
    const slots = free(); slots[5] = true; // a different slot
    expect((await put({ date: "2026-09-20", slots }, token)).status).toBe(200);
    expect(prismaMock.availability.upsert).toHaveBeenCalled();
  });
});
