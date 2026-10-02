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
  guidePaymentJob: { findMany: vi.fn() },
  guidePayment: { findMany: vi.fn() },
  // The month view's supplemental-payment summary — none in these cases.
  supplementalPayment: { findMany: vi.fn(async () => []) },
  guidePaymentSupplementLine: { findMany: vi.fn(async () => []) },
  // The month's company advances (lib/advances/coverage) — none unless a case records one.
  guideAdvance: { findMany: vi.fn(async () => [] as { guideId: string; date: string; slotIdx: number; amountSatang: number; allowedCategories: string[] }[]) },
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
  prismaMock.guidePaymentJob.findMany.mockResolvedValue([]);
  prismaMock.guidePayment.findMany.mockResolvedValue([]);
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

// A month after two false "paid" marks were undone: one job is back to pending with no EXP
// while its neighbour keeps its own; another was left out of the combined document made
// while it looked paid, and one job in that document now has an intentional ฿0 fee.
describe("GET /api/payments — after undoing false paid marks", () => {
  const P = "2020-04";
  const fee = (price: number) => ({ price, time: 1, whtPct: price ? 3 : 0 });
  const job = (date: string, slotIdx: number, ref: string, expenses: object[], guideFee: object) => ({
    guideId: GUIDE, date, slotIdx, tourId: "T-TEST", ref, createdAt: new Date(`${date}T20:00:00Z`), origin: "NORMAL",
    expenses, guideFee, peakDocumentNo: null, peakDocumentId: null, peakSyncStatus: null, approvalStatus: "APPROVED",
  });
  const guide = (d: string) => ({ description: d, price: 10, pax: 4, paidBy: "guide" });
  const sheetsApr = [
    job(`${P}-01`, 2, "FOLK-TEST-A", [guide("Water"), { description: "Bus", price: 15, pax: 4, paidBy: "guide" }], fee(1200)),
    job(`${P}-01`, 7, "FOLK-TEST-B", [{ description: "Food", price: 600, pax: 1, paidBy: "advance" }, { description: "Review reward", price: 40, pax: 1 }], fee(1100)),
    job(`${P}-03`, 7, "FOLK-TEST-C", [{ description: "Food", price: 500, pax: 1, paidBy: "guide" }], fee(1000)),
    job(`${P}-05`, 0, "FOLK-TEST-E", [{ description: "Water", price: 10, pax: 3, paidBy: "guide" }, { description: "Bus", price: 20, pax: 3, paidBy: "guide" }], fee(1200)),
    job(`${P}-05`, 3, "FOLK-TEST-D", [{ description: "Water", price: 10, pax: 1, paidBy: "guide" }, { description: "Review reward", price: 30, pax: 2 }], fee(0)),
  ];
  const DOC = "FOLK-PAY-TEST-01";
  const pending = (date: string, slotIdx: number, peakPaymentRef: string | null) => ({ guideId: GUIDE, date, slotIdx, status: "PENDING", paidAt: null, peakRef: null, eslipUrl: null, slips: null, peakPaymentRef });
  const doc = {
    paymentRef: DOC, guideId: GUIDE, status: "AWAITING_PAYMENT", alreadyPaid: false, error: null, total: 4471,
    jobs: [
      { ref: "FOLK-TEST-A", date: `${P}-01`, slotIdx: 2, payout: 1264 }, { ref: "FOLK-TEST-B", date: `${P}-01`, slotIdx: 7, payout: 1107 },
      { ref: "FOLK-TEST-E", date: `${P}-05`, slotIdx: 0, payout: 1254 }, { ref: "FOLK-TEST-D", date: `${P}-05`, slotIdx: 3, payout: 846 },
    ],
    lines: [
      { jobRef: "FOLK-TEST-A", date: `${P}-01`, slotIdx: 2, price: 1200, wht: 36 }, { jobRef: "FOLK-TEST-A", date: `${P}-01`, slotIdx: 2, price: 100, wht: 0 },
      { jobRef: "FOLK-TEST-B", date: `${P}-01`, slotIdx: 7, price: 1100, wht: 33 }, { jobRef: "FOLK-TEST-B", date: `${P}-01`, slotIdx: 7, price: 40, wht: 0 },
      { jobRef: "FOLK-TEST-E", date: `${P}-05`, slotIdx: 0, price: 1200, wht: 36 }, { jobRef: "FOLK-TEST-E", date: `${P}-05`, slotIdx: 0, price: 90, wht: 0 },
      // Job D as the document was made: its old ฿800 fee.
      { jobRef: "FOLK-TEST-D", date: `${P}-05`, slotIdx: 3, price: 800, wht: 24 }, { jobRef: "FOLK-TEST-D", date: `${P}-05`, slotIdx: 3, price: 10, wht: 0 }, { jobRef: "FOLK-TEST-D", date: `${P}-05`, slotIdx: 3, price: 60, wht: 0 },
    ],
    paymentDate: null, paymentMethodName: null, peakDocumentNo: "EXP-TEST-0004", peakDocumentLink: null, slipUrl: null, attachmentStatus: null, attachmentError: null, createdAt: new Date(), updatedAt: new Date(),
  };
  async function april() {
    const res = await GET(new NextRequest(`https://ops.folkpaths.com/api/payments?period=${P}`));
    expect(res.status).toBe(200);
    return res.json() as Promise<{ rows: { jobs: (Job & { amount: number; fee: number; expenses: number; combinable: boolean })[] }[]; paymentDocs: { paymentRef: string; total: number; gross: number; wht: number; drift: { stored: object; current: object; delta: object; changed: { ref: string }[]; leftOut: { ref: string }[]; inSync: boolean } | null }[] }>;
  }
  beforeEach(() => {
    prismaMock.assignment.findMany.mockResolvedValue(sheetsApr.map((s) => ({ guideId: GUIDE, date: s.date, slotIdx: s.slotIdx, tourId: "T-TEST", createdAt: s.createdAt })));
    prismaMock.jobSheet.findMany.mockResolvedValue(sheetsApr);
    prismaMock.tourPayment.findMany.mockResolvedValue([
      pending(`${P}-01`, 2, DOC), pending(`${P}-01`, 7, DOC), pending(`${P}-05`, 0, DOC), pending(`${P}-05`, 3, DOC),
      pending(`${P}-03`, 7, null), // was marked paid by mistake, now undone
    ]);
    prismaMock.guidePaymentDocument.findMany.mockResolvedValue([doc]);
  });

  it("the undone job is pending again, counts in the unpaid total, and has no PEAK document", async () => {
    const { rows } = await april();
    const c = rows[0].jobs.find((j) => j.ref === "FOLK-TEST-C")!;
    expect(c).toMatchObject({ paid: false, payStatus: "PENDING", peakRef: null, amount: 1470, combinable: true });
    expect(c.peakStatus.state).toBe("NOT_IN_PEAK");
    expect(rows[0].jobs.filter((j) => !j.paid).reduce((s, j) => s + j.amount, 0)).toBe(5163.8);
  });

  it("a ฿0 fee stays ฿0: the job pays only its reimbursement and review reward", async () => {
    const { rows } = await april();
    expect(rows[0].jobs.find((j) => j.ref === "FOLK-TEST-D")).toMatchObject({ amount: 70, fee: 0, expenses: 70 });
  });

  it("the stored document keeps its figures, and is reported out of sync with the current payout", async () => {
    const { paymentDocs } = await april();
    const d = paymentDocs[0];
    expect(d).toMatchObject({ total: 4471, gross: 4600, wht: 129 });
    expect(d.drift).toMatchObject({
      stored: { jobs: 4, gross: 4600, wht: 129, net: 4471 },
      current: { jobs: 5, gross: 5300, wht: 136.2, net: 5163.8 },
      delta: { gross: 700, wht: 7.2, net: 692.8 },
      inSync: false,
    });
    // B is in the list too: its document was created when a review incentive was
    // paid untaxed, so the stored figures no longer match the ledger.
    expect(d.drift!.changed.map((c) => c.ref)).toEqual(["FOLK-TEST-B", "FOLK-TEST-D"]);
    expect(d.drift!.leftOut.map((j) => j.ref)).toEqual(["FOLK-TEST-C"]);
  });

  it("an undone job next to a job with its own EXP shows no EXP of its own", async () => {
    prismaMock.guidePaymentDocument.findMany.mockResolvedValue([]);
    prismaMock.tourPayment.findMany.mockResolvedValue([
      { ...pending(`${P}-01`, 2, null), status: "PAID", paidAt: new Date(`${P}-02T10:00:00Z`), peakRef: EXP_B, eslipUrl: "https://drive.test/slip" },
      pending(`${P}-03`, 7, null),
    ]);
    const body = await april();
    const c = body.rows[0].jobs.find((j) => j.ref === "FOLK-TEST-C")!;
    expect(c).toMatchObject({ paid: false, peakRef: null });
    expect(jobPeakDocumentNo(c.peakStatus)).toBeNull();
    expect(pathsOf(body, EXP_B)).toEqual(["response.rows[0].jobs[0].peakRef", "response.rows[0].jobs[0].peakStatus.documentNo"]);
  });
});

// Issue #206 — "From company advance" on a job with no advance on record. All figures invented.
describe("GET /api/payments — a Company Advance row with no advance on record is reported, never just left out", () => {
  const C = { date: "2020-03-24", slotIdx: 1, ref: "FOLK-TEST-0324-01" };
  const TICKET = { description: "Temple ticket", price: 300, pax: 2, expenseType: "entrance", paidBy: "advance", paidBySource: "operator" };
  type Held = { ref: string; amount: number; paid: boolean; payBlock: string | null; combinable: boolean; combinedBlock: { code: string } | null; advanceGap: { code: string; amount: number; excess: number; issued: number; rows: { rowNo: number; description: string; amount: number; why: string }[] } | null };
  const held = async () => {
    const res = await GET(new NextRequest("https://ops.folkpaths.com/api/payments?period=2020-03"));
    const body = (await res.json()) as { rows: { jobs: Held[] }[] };
    return body.rows[0].jobs.find((j) => j.ref === C.ref)!;
  };
  beforeEach(() => {
    prismaMock.assignment.findMany.mockResolvedValue([{ guideId: GUIDE, date: C.date, slotIdx: C.slotIdx, tourId: "T-TEST", createdAt: new Date("2020-03-20T10:00:00Z") }]);
    prismaMock.jobSheet.findMany.mockResolvedValue([{ ...sheet(C, "2020-03-20T10:00:00Z"), guideFee: { price: 1000, time: 1, whtPct: 3 }, expenses: [TICKET] }]);
    prismaMock.tourPayment.findMany.mockResolvedValue([]);
    prismaMock.guideAdvance.findMany.mockResolvedValue([]);
  });

  it("no advance: the job carries the machine-readable reason, cannot be paid, and cannot join a combined PEAK document", async () => {
    const j = await held();
    expect(j.advanceGap).toEqual({ code: "ADVANCE_NOT_RECORDED", amount: 600, excess: 0, issued: 0, rows: [{ rowNo: 1, description: "Temple ticket", category: "entrance", amount: 600, why: "NO_ADVANCE" }] });
    expect(j.payBlock).toMatch(/฿600\.00 of expenses .* no advance is recorded for this job/);
    expect(j.combinable).toBe(false);
    expect(j.combinedBlock?.code).toBe("advance-not-recorded");
    expect(j.amount).toBe(970); // the figure is not altered — the job is held
  });

  it("only live advances are asked for", async () => {
    await held();
    expect(prismaMock.guideAdvance.findMany.mock.calls[0][0].where).toMatchObject({ reversedAt: null, date: { gte: "2020-03-01", lte: "2020-03-31" } });
  });

  it("an advance on record for that job: no reason, payable and combinable as before", async () => {
    prismaMock.guideAdvance.findMany.mockResolvedValue([{ guideId: GUIDE, date: C.date, slotIdx: C.slotIdx, amountSatang: 100000, allowedCategories: ["entrance"] }]);
    const j = await held();
    expect(j).toMatchObject({ advanceGap: null, payBlock: null, combinable: true, combinedBlock: null, amount: 970 });
  });

  it("an advance too small for the row, or for another kind of cost, still holds the job", async () => {
    prismaMock.guideAdvance.findMany.mockResolvedValue([{ guideId: GUIDE, date: C.date, slotIdx: C.slotIdx, amountSatang: 50000, allowedCategories: ["entrance"] }]);
    expect(await held()).toMatchObject({ combinable: false, advanceGap: { code: "ADVANCE_NOT_RECORDED", amount: 100, excess: 100, issued: 500, rows: [] } });
    prismaMock.guideAdvance.findMany.mockResolvedValue([{ guideId: GUIDE, date: C.date, slotIdx: C.slotIdx, amountSatang: 100000, allowedCategories: ["meal"] }]);
    expect(await held()).toMatchObject({ combinable: false, advanceGap: { amount: 600, rows: [{ why: "CATEGORY_NOT_ALLOWED" }] } });
  });

  it("an advance for another job of the same guide does not cover this one", async () => {
    prismaMock.guideAdvance.findMany.mockResolvedValue([{ guideId: GUIDE, date: C.date, slotIdx: C.slotIdx + 1, amountSatang: 100000, allowedCategories: ["entrance"] }, { guideId: "G-OTHER", date: C.date, slotIdx: C.slotIdx, amountSatang: 100000, allowedCategories: ["entrance"] }]);
    expect((await held()).advanceGap).toMatchObject({ code: "ADVANCE_NOT_RECORDED", amount: 600 });
  });

  it("payer corrected to the guide: the ฿600 is in the payout again and nothing is held", async () => {
    prismaMock.jobSheet.findMany.mockResolvedValue([{ ...sheet(C, "2020-03-20T10:00:00Z"), guideFee: { price: 1000, time: 1, whtPct: 3 }, expenses: [{ ...TICKET, paidBy: "guide" }] }]);
    expect(await held()).toMatchObject({ advanceGap: null, payBlock: null, combinable: true, amount: 1570 });
  });

  it("a job already paid still shows the reason, so the shortfall can be looked at", async () => {
    prismaMock.tourPayment.findMany.mockResolvedValue([{ ...pay(C, "2020-03-26T10:00:00Z", null) }]);
    const j = await held();
    expect(j.paid).toBe(true);
    expect(j.advanceGap).toMatchObject({ code: "ADVANCE_NOT_RECORDED", amount: 600 });
  });
});
