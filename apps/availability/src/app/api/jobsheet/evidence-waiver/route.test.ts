import { vi, describe, it, expect, beforeEach } from "vitest";

// An admin accepting one reimbursement row without a receipt. Mocked at the seams only;
// the evidence rule itself is the real one. All data is invented — this repo is public.
const prismaMock = vi.hoisted(() => ({
  jobSheet: { findUnique: vi.fn(), update: vi.fn() },
}));
const authMock = vi.hoisted(() => vi.fn());
const auditMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/audit", () => ({ audit: auditMock }));

import { POST } from "./route";

const REASON = "the temple issues no printed ticket";
const call = (body: object) => POST(new Request("https://ops.folkpaths.com/api/jobsheet/evidence-waiver", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}) as unknown as Parameters<typeof POST>[0]);

const ROW = { description: "Lunch", price: 45, pax: 2, expenseType: "meal", paidBy: "guide" };
const REQ = { guideId: "G-TEST", date: "2030-05-06", slotIdx: 2, index: 0, reason: REASON };

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "u_admin", role: "ADMIN" } });
  prismaMock.jobSheet.findUnique.mockResolvedValue({ id: "js_1", ref: "FOLK-BKK-20300506-01", expenses: [ROW] });
  prismaMock.jobSheet.update.mockResolvedValue({ id: "js_1" });
});

describe("POST /api/jobsheet/evidence-waiver", () => {
  it("records who accepted it, when, and why — on that one row", async () => {
    const res = await call(REQ);
    expect(res.status).toBe(200);
    const rows = prismaMock.jobSheet.update.mock.calls[0][0].data.expenses;
    expect(rows[0].evidenceWaiver).toMatchObject({ by: "u_admin", reason: REASON });
    expect(Date.parse(rows[0].evidenceWaiver.at)).not.toBeNaN();
    expect(rows[0].description).toBe("Lunch"); // the row is otherwise untouched
  });

  it("leaves an audit row naming the sheet, the row and the money", async () => {
    await call(REQ);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0][0]).toMatchObject({
      action: "jobsheet.evidence_waived", actorId: "u_admin", entityId: "js_1",
      detail: { ref: "FOLK-BKK-20300506-01", row: 1, description: "Lunch", amount: 90, reason: REASON },
    });
  });

  it("is not something an operator can do", async () => {
    authMock.mockResolvedValue({ user: { id: "op_1", role: "OPERATOR" } });
    const res = await call(REQ);
    expect(res.status).toBe(403);
    expect(prismaMock.jobSheet.update).not.toHaveBeenCalled();
  });

  it("will not take a one-word reason", async () => {
    const res = await call({ ...REQ, reason: "lost" });
    expect(res.status).toBe(400);
    expect(prismaMock.jobSheet.update).not.toHaveBeenCalled();
  });

  it("refuses a row that has its receipt — there would be nothing to accept", async () => {
    prismaMock.jobSheet.findUnique.mockResolvedValue({ id: "js_1", ref: "R", expenses: [{ ...ROW, receiptUrl: "https://drive.example.test/r" }] });
    const res = await call(REQ);
    expect(res.status).toBe(409);
    expect((await res.json()).reasons[0]).toContain("does not need a waiver");
  });

  it("refuses a row the company paid — its evidence is on the company's side", async () => {
    prismaMock.jobSheet.findUnique.mockResolvedValue({ id: "js_1", ref: "R", expenses: [{ ...ROW, paidBy: "company" }] });
    expect((await call(REQ)).status).toBe(409);
  });

  it("says so when the sheet, or the row, is not there", async () => {
    prismaMock.jobSheet.findUnique.mockResolvedValue(null);
    expect((await call(REQ)).status).toBe(404);
    prismaMock.jobSheet.findUnique.mockResolvedValue({ id: "js_1", ref: "R", expenses: [ROW] });
    const res = await call({ ...REQ, index: 7 });
    expect(res.status).toBe(404);
    expect((await res.json()).reasons[0]).toContain("row 8");
  });
});
