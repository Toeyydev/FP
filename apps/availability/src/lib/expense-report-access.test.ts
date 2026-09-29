import { vi, describe, it, expect, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  assignment: { findUnique: vi.fn() },
  tourPayment: { findUnique: vi.fn() },
  payrollStatus: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
  jobSheet: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

import { expenseReportAccess } from "./expense-report-access";

// A made-up departure.
const JOB = { guideId: "G-001", date: "2030-04-06", slotIdx: 2 };
const GUIDE = { kind: "guide" as const, guideId: "G-001" };

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.assignment.findUnique.mockResolvedValue({ id: "a_1" });
  prismaMock.tourPayment.findUnique.mockResolvedValue(null);
  prismaMock.payrollStatus.findUnique.mockResolvedValue(null);
  prismaMock.user.findUnique.mockResolvedValue({ id: "u_1" });
  prismaMock.jobSheet.findUnique.mockResolvedValue(null);
});

describe("expenseReportAccess — a guide", () => {
  it("files for their own assigned, unpaid departure", async () => {
    expect(await expenseReportAccess(GUIDE, JOB)).toEqual({ ok: true });
  });
  it("cannot file for another guide's job", async () => {
    expect(await expenseReportAccess({ kind: "guide", guideId: "G-002" }, JOB)).toEqual({ ok: false, status: 403, error: "forbidden" });
    expect(prismaMock.assignment.findUnique).not.toHaveBeenCalled();
  });
  it("cannot file for a departure they were never assigned to", async () => {
    prismaMock.assignment.findUnique.mockResolvedValue(null);
    expect(await expenseReportAccess(GUIDE, JOB)).toEqual({ ok: false, status: 404, error: "not-assigned" });
  });
  it("cannot file once the job is paid per tour", async () => {
    prismaMock.tourPayment.findUnique.mockResolvedValue({ status: "PAID", paidAt: new Date("2030-04-09T03:00:00Z") });
    expect(await expenseReportAccess(GUIDE, JOB)).toEqual({ ok: false, status: 409, error: "already-paid" });
  });
  it("cannot file once a monthly payroll made after the tour covers it", async () => {
    prismaMock.payrollStatus.findUnique.mockResolvedValue({ status: "paid", paidAt: new Date("2030-04-30T05:00:00Z") });
    expect(await expenseReportAccess(GUIDE, JOB)).toEqual({ ok: false, status: 409, error: "already-paid" });
  });
  it("still files when a payroll run happened before the tour (it did not cover this job)", async () => {
    prismaMock.payrollStatus.findUnique.mockResolvedValue({ status: "paid", paidAt: new Date("2030-04-01T05:00:00Z") });
    expect(await expenseReportAccess(GUIDE, JOB)).toEqual({ ok: true });
  });
});

describe("expenseReportAccess — an operator on a guide's behalf", () => {
  const OPS = { kind: "operator" as const };
  it("files for a job with an assignment", async () => {
    expect(await expenseReportAccess(OPS, JOB)).toEqual({ ok: true });
  });
  it("files for an imported job that has a sheet but no assignment", async () => {
    prismaMock.assignment.findUnique.mockResolvedValue(null);
    prismaMock.jobSheet.findUnique.mockResolvedValue({ id: "js_1" });
    expect(await expenseReportAccess(OPS, JOB)).toEqual({ ok: true });
  });
  it("cannot create a report for a job that does not exist", async () => {
    prismaMock.assignment.findUnique.mockResolvedValue(null);
    expect(await expenseReportAccess(OPS, JOB)).toEqual({ ok: false, status: 404, error: "no-job" });
  });
  it("cannot file for a guide id that belongs to nobody", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    expect(await expenseReportAccess(OPS, JOB)).toEqual({ ok: false, status: 404, error: "unknown-guide" });
  });
});

it("refuses a caller that is neither a guide nor an operator", async () => {
  expect(await expenseReportAccess(null, JOB)).toEqual({ ok: false, status: 403, error: "forbidden" });
});
