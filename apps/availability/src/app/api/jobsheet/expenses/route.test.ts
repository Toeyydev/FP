import { vi, describe, it, expect, beforeEach } from "vitest";

// The route runs the real access rule and the real report rules; the database, the
// session and the outside world (ops notification, Drive) are stand-ins.
const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  assignment: { findUnique: vi.fn(), count: vi.fn() },
  tourPayment: { findUnique: vi.fn() },
  payrollStatus: { findUnique: vi.fn() },
  jobSheet: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn(), findMany: vi.fn() },
  booking: { findMany: vi.fn() },
  tour: { findUnique: vi.fn() },
  // Read by the report's payer rules once they land (PR #201, and the job-duration lookup after it); harmless before.
  tourReport: { findUnique: vi.fn() },
  checkin: { findFirst: vi.fn() },
  guideAdvance: { count: vi.fn() },
  jobOffer: { findFirst: vi.fn() },
}));
const session = vi.hoisted(() => ({ current: null as null | { user: { id: string; role: string; guideId: string | null } } }));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => session.current) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/booking-import", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/jobref", () => ({ ensureJobRef: vi.fn(async () => "FOLK-BKK-20300406-01") }));
vi.mock("@/lib/jobsheet-drive", () => ({ saveJobSheetToDrive: vi.fn(async () => null) }));

import { POST } from "./route";
import { audit } from "@/lib/audit";
import { notifyOps } from "@/lib/booking-import";
import { saveJobSheetToDrive } from "@/lib/jobsheet-drive";

// A made-up departure and guides.
const body = { guideId: "G-001", date: "2030-04-06", slotIdx: 2, expenses: [{ description: "Water", price: 10, pax: 4 }] };
const post = (b: unknown) => POST(new Request("https://ops.folkpaths.com/api/jobsheet/expenses", { method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json" } }) as never);
const as = (role: string, guideId: string | null) => { session.current = { user: { id: `u_${role}`, role, guideId } }; };
const nothingWritten = () => {
  expect(prismaMock.jobSheet.update).not.toHaveBeenCalled();
  expect(prismaMock.jobSheet.create).not.toHaveBeenCalled();
  expect(audit).not.toHaveBeenCalled();
  expect(notifyOps).not.toHaveBeenCalled();
  expect(saveJobSheetToDrive).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  as("GUIDE", "G-001");
  prismaMock.user.findUnique.mockResolvedValue({ id: "u_guide" });
  prismaMock.assignment.findUnique.mockResolvedValue({ id: "a_1", tourId: "T-001" });
  prismaMock.assignment.count.mockResolvedValue(1);
  prismaMock.tourPayment.findUnique.mockResolvedValue(null);
  prismaMock.payrollStatus.findUnique.mockResolvedValue(null);
  prismaMock.jobSheet.findUnique.mockResolvedValue({ id: "js_1", tourId: "T-001", bookings: [] });
  prismaMock.jobSheet.findMany.mockResolvedValue([]);
  prismaMock.booking.findMany.mockResolvedValue([]);
  prismaMock.tour.findUnique.mockResolvedValue({ name: "Test tour" });
  prismaMock.tourReport.findUnique.mockResolvedValue(null);
  prismaMock.checkin.findFirst.mockResolvedValue(null);
  prismaMock.guideAdvance.count.mockResolvedValue(0);
  prismaMock.jobOffer.findFirst.mockResolvedValue(null);
});

describe("POST /api/jobsheet/expenses — who may file", () => {
  it("a guide files their own assigned job", async () => {
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(prismaMock.jobSheet.update.mock.calls[0][0].where).toEqual({ guideId_date_slotIdx: { guideId: "G-001", date: "2030-04-06", slotIdx: 2 } });
  });

  it("a guide cannot file another guide's job — 403, nothing written", async () => {
    const res = await post({ ...body, guideId: "G-002" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("forbidden");
    nothingWritten();
  });

  it("a guide cannot file a departure they were not assigned — 404, no sheet scaffolded", async () => {
    prismaMock.assignment.findUnique.mockResolvedValue(null);
    prismaMock.jobSheet.findUnique.mockResolvedValue(null);
    const res = await post(body);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not-assigned");
    nothingWritten();
  });

  it("a guide cannot file after the job is paid — 409, nothing written", async () => {
    prismaMock.tourPayment.findUnique.mockResolvedValue({ status: "PAID", paidAt: new Date("2030-04-10T03:00:00Z") });
    const res = await post(body);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("already-paid");
    nothingWritten();
  });

  it("an operator files for a guide's existing job", async () => {
    as("OPERATOR", null);
    expect((await post({ ...body, guideId: "G-002" })).status).toBe(200);
  });

  it("an operator cannot create a report for a job that does not exist — 404, nothing written", async () => {
    as("ADMIN", null);
    prismaMock.assignment.findUnique.mockResolvedValue(null);
    prismaMock.jobSheet.findUnique.mockResolvedValue(null);
    const res = await post(body);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("no-job");
    nothingWritten();
  });

  it("an accountant (no guide profile, not an operator) is refused — 403, nothing written", async () => {
    as("ACCOUNTANT", null);
    expect((await post(body)).status).toBe(403);
    nothingWritten();
  });

  it("no session — 401, nothing written", async () => {
    session.current = null;
    expect((await post(body)).status).toBe(401);
    nothingWritten();
  });
});
