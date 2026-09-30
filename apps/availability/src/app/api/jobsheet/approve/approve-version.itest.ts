import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// An approval is a person signing off the version of the job sheet they SAW. If the sheet
// changed since — an automatic booking update, another operator's save — the approval is
// refused and nothing changes. Real database, real route, real booking reconciliation.
// All data invented — this repo is public.

vi.hoisted(() => { process.env.BOOKING_RECONCILE_FLAG_SINCE = "2000-01-01"; });
const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPushToUser: vi.fn(async () => 0) }));
vi.mock("@/lib/line", async (orig) => ({ ...(await orig<typeof import("@/lib/line")>()), lineEnabled: false }));
vi.mock("@/lib/email", async (orig) => ({ ...(await orig<typeof import("@/lib/email")>()), sendEmail: vi.fn(async () => true) }));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { POST } from "@/app/api/jobsheet/approve/route";
import { reconcileBookingChange } from "@/lib/booking-reconcile";
import { toSheetBooking } from "@/lib/sheet-bookings";

const DATE = new Date(Date.now() + 5 * 86400_000 + 7 * 3600_000).toISOString().slice(0, 10);
const G = "G-961";
const post = async (body: Record<string, unknown>) => {
  const r = await POST(new NextRequest("http://test.local/api/jobsheet/approve", { method: "POST", body: JSON.stringify({ guideId: G, date: DATE, slotIdx: 0, ...body }), headers: { "content-type": "application/json" } }));
  return { status: r.status, body: await r.json() };
};
const sheetNow = () => prisma.jobSheet.findUniqueOrThrow({ where: { guideId_date_slotIdx: { guideId: G, date: DATE, slotIdx: 0 } } });
const mk = (ref: string, pax: number, status = "OFFERED") => prisma.booking.create({ data: { source: "GetYourGuide", externalRef: ref, confirmationCode: `CODE-${ref}`, customerName: `Guest ${ref}`, date: DATE, slotIdx: 0, tourId: "T-900", pax, status } });

beforeAll(() => { requireTestDatabase(); });
beforeEach(async () => {
  await resetDatabase();
  await seedGuide(G);
  const op = await prisma.user.create({ data: { email: "op-approve@example.test", displayName: "Op Example", role: "OPERATOR", state: "ACTIVE" } });
  authMock.auth.mockResolvedValue({ user: { id: op.id, role: "OPERATOR" } });
  await prisma.assignment.create({ data: { guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", pax: 6 } });
  const a = await mk("AAA", 4), b = await mk("BBB", 2);
  await prisma.jobSheet.create({ data: { ref: "FOLK-APPROVE-01", guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", bookings: [a, b].map(toSheetBooking) as never } });
});

describe("approving the version that was reviewed", () => {
  it("the operator reviewed 6 guests; a late booking made it 8; approving the 6-guest version is refused", async () => {
    const reviewed = (await sheetNow()).updatedAt; // what the operator's screen shows
    const late = await mk("LATE", 2, "PENDING");
    expect((await reconcileBookingChange(late.id, { source: "test" })).kind).toBe("reconciled");

    const r = await post({ approve: true, reviewedUpdatedAt: reviewed.toISOString() });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("JOB_SHEET_CHANGED_REVIEW_AGAIN");
    expect(r.body.reasons[0]).toContain("Job Sheet changed since you reviewed it");
    expect((await sheetNow()).approvalStatus).toBeNull();

    // Reviewing the latest version and approving that works.
    const latest = (await sheetNow()).updatedAt;
    const ok = await post({ approve: true, reviewedUpdatedAt: latest.toISOString() });
    expect(ok.status).toBe(200);
    expect(ok.body.approvalStatus).toBe("APPROVED");
    expect(new Date(ok.body.updatedAt).getTime()).toBe((await sheetNow()).updatedAt.getTime());
  });

  it("approving without saying which version was reviewed is refused", async () => {
    const r = await post({ approve: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("reviewed-version-required");
    expect((await sheetNow()).approvalStatus).toBeNull();
  });

  it("removing an approval needs no version (it only makes the sheet reviewable again)", async () => {
    await prisma.jobSheet.update({ where: { id: (await sheetNow()).id }, data: { approvalStatus: "APPROVED" } });
    const r = await post({ approve: false });
    expect(r.status).toBe(200);
    expect((await sheetNow()).approvalStatus).toBeNull();
  });

  it("an approval pressed while the reconciliation holds the sheet waits, then is refused — never approves what it did not see", async () => {
    const reviewed = (await sheetNow()).updatedAt;
    const late = await mk("LATE2", 2, "PENDING");
    let approving: Promise<{ status: number; body: { error?: string } }> | null = null;
    await reconcileBookingChange(late.id, { source: "test", beforeWrite: async (attempt) => {
      if (attempt !== 1) return;
      approving = post({ approve: true, reviewedUpdatedAt: reviewed.toISOString() });
      await new Promise((res) => setTimeout(res, 200));
    } });
    const r = await approving!;
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("JOB_SHEET_CHANGED_REVIEW_AGAIN");
    const s = await sheetNow();
    expect(s.approvalStatus).toBeNull();
    expect((s.bookings as { bookingNo: string }[]).map((x) => x.bookingNo)).toEqual(["AAA", "BBB", "LATE2"]);
  });
});
