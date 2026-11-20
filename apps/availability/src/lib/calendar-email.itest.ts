import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// A guide's calendar email: optional, set by an admin on Guides or by the guide on their
// Profile; blank means their account email. Real database. Invented data only.
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { PATCH as GUIDES_PATCH, GET as GUIDES_GET } from "@/app/api/guides/route";
import { PUT as PROFILE_PUT, GET as PROFILE_GET } from "@/app/api/profile/route";

const req = (url: string, method: string, body?: object) => new NextRequest(`http://test.local${url}`, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
let guide: { id: string }, other: { id: string }, admin: { id: string };
const stored = async (id: string) => (await prisma.user.findUnique({ where: { id }, select: { calendarEmail: true } }))!.calendarEmail;

beforeAll(requireTestDatabase);
beforeEach(async () => {
  await resetDatabase();
  guide = await seedGuide("G-991", { email: "guide@example.test" });
  other = await seedGuide("G-992", { email: "other@example.test" });
  admin = await prisma.user.create({ data: { email: "admin@example.test", displayName: "Admin Example", role: "ADMIN", state: "ACTIVE" } });
});

describe("Admin → Guides", () => {
  beforeEach(() => authMock.auth.mockResolvedValue({ user: { id: admin.id, role: "ADMIN" } }));
  it("sets it (lower-cased), shows it, and clears it with a blank", async () => {
    expect((await GUIDES_PATCH(req("/api/guides", "PATCH", { id: guide.id, calendarEmail: " Guide.Cal@Example.TEST " }))).status).toBe(200);
    expect(await stored(guide.id)).toBe("guide.cal@example.test");
    const rows = (await (await GUIDES_GET()).json()).rows as { id: string; calendarEmail: string }[];
    expect(rows.find((r) => r.id === guide.id)?.calendarEmail).toBe("guide.cal@example.test");
    expect((await GUIDES_PATCH(req("/api/guides", "PATCH", { id: guide.id, calendarEmail: "" }))).status).toBe(200);
    expect(await stored(guide.id)).toBeNull();
  });
  it("refuses something that is not an email, and changes nothing", async () => {
    await prisma.user.update({ where: { id: guide.id }, data: { calendarEmail: "kept@example.test" } });
    expect((await GUIDES_PATCH(req("/api/guides", "PATCH", { id: guide.id, calendarEmail: "not an email" }))).status).toBe(400);
    expect(await stored(guide.id)).toBe("kept@example.test");
  });
});

describe("Guide → Profile", () => {
  beforeEach(() => authMock.auth.mockResolvedValue({ user: { id: guide.id, role: "GUIDE", guideId: "G-991" } }));
  it("the guide sets their own, and sees it", async () => {
    expect((await PROFILE_PUT(req("/api/profile", "PUT", { calendarEmail: "me.calendar@example.test" }))).status).toBe(200);
    expect(await stored(guide.id)).toBe("me.calendar@example.test");
    expect((await (await PROFILE_GET(req("/api/profile", "GET"))).json()).calendarEmail).toBe("me.calendar@example.test");
  });
  it("is optional: saving the profile without it leaves it alone", async () => {
    await prisma.user.update({ where: { id: guide.id }, data: { calendarEmail: "kept@example.test" } });
    expect((await PROFILE_PUT(req("/api/profile", "PUT", { phone: "+00 111" }))).status).toBe(200);
    expect(await stored(guide.id)).toBe("kept@example.test");
  });
  it("a guide cannot set another guide's — a userId from a guide is ignored, only their own changes", async () => {
    await PROFILE_PUT(req("/api/profile", "PUT", { userId: other.id, calendarEmail: "x@example.test" }));
    expect(await stored(other.id)).toBeNull();
    expect(await stored(guide.id)).toBe("x@example.test");
  });
});
