import { vi, describe, it, expect, beforeEach } from "vitest";

// Payments board rows: a job shows a PEAK document number only when it has one of its
// own. Two paid jobs of the same guide in the same month must never share an EXP
// because they sit next to each other. Mocked at the seams only; the rules are real.
// All data is invented — this repo is public.
const prismaMock = vi.hoisted(() => ({
  assignment: { findMany: vi.fn() },
  jobSheet: { findMany: vi.fn() },
  payrollStatus: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
  tour: { findMany: vi.fn() },
  tourPayment: { findMany: vi.fn() },
  guidePaymentDocument: { findMany: vi.fn() },
}));
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/peak-payment-server", () => ({ paymentDocumentLocksInMonth: vi.fn(async () => []) }));
vi.mock("@/lib/historical-guard", () => ({ hasHistoricalJobSheet: vi.fn(async () => false), historicalDeleteConflict: vi.fn(), isRestrictViolation: vi.fn() }));

import { NextRequest } from "next/server";
import { GET } from "./route";
import { jobPeakDocumentNo } from "@/lib/peak-job-status";

const GUIDE = "G-TEST";
const EXP_B = "EXP-TEST-0016";
// Job A: paid later on its own, no PEAK document. Job B: paid earlier, its EXP recorded.
const A = { date: "2020-03-19", slotIdx: 2, ref: "FOLK-TEST-0319-02" };
const B = { date: "2020-03-21", slotIdx: 0, ref: "FOLK-TEST-0321-02" };
const sheet = (j: typeof A, createdAt: string) => ({
  guideId: GUIDE, date: j.date, slotIdx: j.slotIdx, tourId: "T-TEST", ref: j.ref, createdAt: new Date(createdAt), origin: "NORMAL",
  expenses: [{ description: "Water", price: 10, pax: 3, paidBy: "guide" }], guideFee: { price: 1200, time: 1, whtPct: 3 },
  peakDocumentNo: null, peakDocumentId: null, peakSyncStatus: null, approvalStatus: "APPROVED",
});
const pay = (j: typeof A, paidAt: string, peakRef: string | null) => ({
  guideId: GUIDE, date: j.date, slotIdx: j.slotIdx, status: "PAID", paidAt: new Date(paidAt), peakRef,
  eslipUrl: peakRef ? "https://drive.test/slip-b" : null, slips: null, peakPaymentRef: null,
});

type Job = { ref: string; paid: boolean; payStatus: string; peakRef: string | null; peakStatus: { state: string; documentNo: string | null; source: string | null }; eslipUrl: string | null; canRecordExp: boolean };
async function board() {
  const res = await GET(new NextRequest("https://ops.folkpaths.com/api/payments?period=2020-03"));
  expect(res.status).toBe(200);
  return res.json() as Promise<{ rows: { guideId: string; peakRef: string | null; jobs: Job[] }[] }>;
}
// Every place in the response a value appears, as a path.
function pathsOf(v: unknown, needle: string, path = "response"): string[] {
  if (typeof v === "string") return v.includes(needle) ? [path] : [];
  if (Array.isArray(v)) return v.flatMap((x, i) => pathsOf(x, needle, `${path}[${i}]`));
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => pathsOf(x, needle, `${path}.${k}`));
  return [];
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "op_1", role: "OPERATOR" } });
  prismaMock.assignment.findMany.mockResolvedValue([
    { guideId: GUIDE, date: A.date, slotIdx: A.slotIdx, tourId: "T-TEST", createdAt: new Date("2020-04-15T12:00:00Z") },
    { guideId: GUIDE, date: B.date, slotIdx: B.slotIdx, tourId: "T-TEST", createdAt: new Date("2020-03-23T10:00:00Z") },
  ]);
  prismaMock.jobSheet.findMany.mockResolvedValue([sheet(A, "2020-04-15T12:02:00Z"), sheet(B, "2020-03-23T10:00:00Z")]);
  prismaMock.payrollStatus.findMany.mockResolvedValue([]);
  prismaMock.user.findMany.mockResolvedValue([{ guideId: GUIDE, displayName: "Guide T" }]);
  prismaMock.tour.findMany.mockResolvedValue([{ id: "T-TEST", name: "Test tour" }]);
  prismaMock.tourPayment.findMany.mockResolvedValue([pay(A, "2020-04-15T13:09:00Z", null), pay(B, "2020-03-26T16:17:00Z", EXP_B)]);
  prismaMock.guidePaymentDocument.findMany.mockResolvedValue([]);
});

describe("GET /api/payments — a job's EXP is its own, never a neighbour's", () => {
  it("paid job with no PEAK document: Paid · Not in PEAK · no EXP; the paid job with an EXP keeps it", async () => {
    const { rows } = await board();
    const [jobA, jobB] = rows[0].jobs;
    expect(jobA).toMatchObject({ ref: A.ref, paid: true, payStatus: "PAID", peakRef: null, eslipUrl: null, canRecordExp: true });
    expect(jobA.peakStatus).toEqual({ state: "NOT_IN_PEAK", documentNo: null, source: null });
    expect(jobPeakDocumentNo(jobA.peakStatus)).toBeNull();
    expect(jobB).toMatchObject({ ref: B.ref, paid: true, payStatus: "PAID", peakRef: EXP_B });
    expect(jobB.peakStatus).toEqual({ state: "IN_PEAK", documentNo: EXP_B, source: "payment" });
    expect(jobPeakDocumentNo(jobB.peakStatus)).toBe(EXP_B);
  });

  it("the EXP appears nowhere in the response except on the job that holds it", async () => {
    const body = await board();
    expect(pathsOf(body, EXP_B)).toEqual(["response.rows[0].jobs[1].peakRef", "response.rows[0].jobs[1].peakStatus.documentNo"]);
    expect(JSON.stringify(body.rows[0].jobs[0])).not.toContain(EXP_B);
  });

  it("a ref on the guide's monthly payroll row does not become the EXP of a job that payroll did not pay", async () => {
    prismaMock.payrollStatus.findMany.mockResolvedValue([{ guideId: GUIDE, period: "2020-03", status: "pending", paidAt: null, eslipUrl: null, peakRef: "EXP-TEST-0900" }]);
    const { rows } = await board();
    const [jobA, jobB] = rows[0].jobs;
    expect(rows[0].peakRef).toBe("EXP-TEST-0900"); // the month's own record, shown as the month's
    expect(jobPeakDocumentNo(jobA.peakStatus)).toBeNull(); // the payroll CSV used to print EXP-TEST-0900 here
    expect(jobPeakDocumentNo(jobB.peakStatus)).toBe(EXP_B);
  });
});
