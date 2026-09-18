import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  assignment: { findMany: vi.fn() },
  jobSheet: { findMany: vi.fn() },
  auditLog: { findMany: vi.fn(), create: vi.fn() },
  user: { findMany: vi.fn() },
  tourPayment: { findMany: vi.fn() },
  payrollStatus: { findMany: vi.fn() },
}));
const lineMock = vi.hoisted(() => ({ linePush: vi.fn(), lineEnabled: true }));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/line", () => lineMock);

import { EXPENSE_DUE_MS, expenseDueMs, overdueMessage, sweepExpenseReminders } from "./expense-reminders";

// Slot 0 = 08:30 Bangkok. A 180-minute tour on 2026-09-19 ends 11:30 BKK (04:30 UTC),
// so its report is late from 04:30 UTC on the 20th.
const TOUR_DATE = "2026-09-19";
const DUE_AT = Date.UTC(2026, 8, 20, 4, 30);
const NOW = Date.UTC(2026, 8, 20, 5, 0); // half an hour past due

const ASSIGNMENT = { guideId: "G-001", date: TOUR_DATE, slotIdx: 0, tourId: "T-001", tour: { id: "T-001", name: "Grand Palace", durationMin: 180 } };
const GUIDE = { id: "u_1", guideId: "G-001", displayName: "Mali Somchai", lineUserId: "U_line_1" };
const KEY = `${TOUR_DATE}:0:G-001`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  lineMock.lineEnabled = true;
  lineMock.linePush.mockResolvedValue(undefined); // the real one returns a promise
  prismaMock.assignment.findMany.mockResolvedValue([ASSIGNMENT]);
  prismaMock.jobSheet.findMany.mockResolvedValue([]);
  prismaMock.auditLog.findMany.mockResolvedValue([]);
  prismaMock.auditLog.create.mockResolvedValue({});
  prismaMock.user.findMany.mockResolvedValue([GUIDE]);
  prismaMock.tourPayment.findMany.mockResolvedValue([]);
  prismaMock.payrollStatus.findMany.mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

describe("expenseDueMs", () => {
  it("is 24 hours after the tour ENDS, not after it starts", () => {
    expect(expenseDueMs(TOUR_DATE, 0, 180)).toBe(DUE_AT);
    // A longer tour on the same departure is due later by exactly its extra length.
    expect(expenseDueMs(TOUR_DATE, 0, 300) - expenseDueMs(TOUR_DATE, 0, 180)).toBe(120 * 60_000);
    expect(EXPENSE_DUE_MS).toBe(24 * 3600_000);
  });
});

describe("overdueMessage", () => {
  it("names the tour and links straight to the job", () => {
    const m = overdueMessage({ firstName: "Mali", tourName: "Grand Palace", date: TOUR_DATE, slotIdx: 0, guideId: "G-001" });
    expect(m).toContain("Mali, your expense report is still missing.");
    expect(m).toContain("Grand Palace at 08:30");
    expect(m).toMatch(/Sat\s+19\s+Sept?/); // ICU writes the month "Sep" or "Sept" by version
    expect(m).toContain(`/job-sheet?guideId=G-001&date=${TOUR_DATE}&slotIdx=0`);
  });

  it("reads properly for a guide with no name on file", () => {
    expect(overdueMessage({ firstName: "", tourName: "T-001", date: TOUR_DATE, slotIdx: 0, guideId: "G-001" }))
      .toContain("Your expense report is still missing.");
  });
});

describe("sweepExpenseReminders", () => {
  it("chases a job whose report is overdue, once", async () => {
    expect(await sweepExpenseReminders(NOW)).toBe(1);
    expect(lineMock.linePush).toHaveBeenCalledWith("U_line_1", expect.stringContaining("Grand Palace"));
  });

  it("says nothing until the 24 hours are up", async () => {
    expect(await sweepExpenseReminders(DUE_AT - 1)).toBe(0);
    expect(lineMock.linePush).not.toHaveBeenCalled();
    expect(await sweepExpenseReminders(DUE_AT)).toBe(1);
  });

  it("says nothing when the guide has already reported", async () => {
    prismaMock.jobSheet.findMany.mockResolvedValue([{ guideId: "G-001", date: TOUR_DATE, slotIdx: 0, guideExpensesAt: new Date() }]);
    expect(await sweepExpenseReminders(NOW)).toBe(0);
    expect(lineMock.linePush).not.toHaveBeenCalled();
  });

  it("sends once and never again — the claim survives restarts and other replicas", async () => {
    prismaMock.auditLog.findMany.mockResolvedValue([{ entityId: KEY }]);
    expect(await sweepExpenseReminders(NOW)).toBe(0);
    expect(lineMock.linePush).not.toHaveBeenCalled();
  });

  it("claims BEFORE sending, so a crash mid-send cannot double-notify", async () => {
    await sweepExpenseReminders(NOW);
    expect(prismaMock.auditLog.create.mock.invocationCallOrder[0]).toBeLessThan(lineMock.linePush.mock.invocationCallOrder[0]);
    expect(prismaMock.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: "tour.expense_reminder", entityId: KEY });
  });

  it("never chases a report the server would refuse — a paid job's window is closed", async () => {
    prismaMock.tourPayment.findMany.mockResolvedValue([{ guideId: "G-001", date: TOUR_DATE, slotIdx: 0, status: "PAID", paidAt: new Date(NOW) }]);
    expect(await sweepExpenseReminders(NOW)).toBe(0);
    expect(lineMock.linePush).not.toHaveBeenCalled();
  });

  it("skips a guide with no LINE link WITHOUT claiming, so they are chased if they link later", async () => {
    prismaMock.user.findMany.mockResolvedValue([{ ...GUIDE, lineUserId: null }]);
    expect(await sweepExpenseReminders(NOW)).toBe(0);
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it("does nothing at all when LINE is not configured", async () => {
    lineMock.lineEnabled = false;
    expect(await sweepExpenseReminders(NOW)).toBe(0);
    expect(prismaMock.assignment.findMany).not.toHaveBeenCalled();
  });

  it("never looks back past the date the rule starts, so a deploy cannot spam old tours", async () => {
    await sweepExpenseReminders(NOW);
    const { where } = prismaMock.assignment.findMany.mock.calls[0][0];
    // 7 days back from 2026-09-20 is the 13th, but the rule starts on the 18th.
    expect(where.date.gte).toBe("2026-09-18");
  });
});
