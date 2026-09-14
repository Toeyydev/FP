import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// All data here is invented (fictional month and amounts) — this repo is public.
//
// Mocked at the seams only — the database, Drive, PEAK's network calls and auth. The
// loader, the claim transaction, the paid/failed writes and the document builder are
// the REAL ones, so these tests check the actual queries that lock the jobs and point
// every one of them at the same document.

type Row = Record<string, any>;
type Where = Record<string, any>;

const db = vi.hoisted(() => ({
  users: [] as Row[], sheets: [] as Row[], assigns: [] as Row[], pays: [] as Row[], payrolls: [] as Row[], docs: [] as Row[], tours: [] as Row[], audits: [] as Row[],
}));

const prismaMock = vi.hoisted(() => {
  const matchValue = (v: any, cond: any): boolean => {
    if (cond === null) return v === null || v === undefined;
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      if ("not" in cond) return cond.not === null ? v !== null && v !== undefined : v !== cond.not;
      if ("in" in cond) return cond.in.includes(v);
      if ("startsWith" in cond) return typeof v === "string" && v.startsWith(cond.startsWith);
      if ("gte" in cond || "lte" in cond) return (cond.gte === undefined || v >= cond.gte) && (cond.lte === undefined || v <= cond.lte);
    }
    return v === cond;
  };
  const matches = (row: Row, where: Where = {}): boolean =>
    Object.entries(where).every(([k, cond]) => {
      if (k === "OR") return (cond as Where[]).some((w) => matches(row, w));
      if (k === "guideId_date_slotIdx") return row.guideId === cond.guideId && row.date === cond.date && row.slotIdx === cond.slotIdx;
      return matchValue(row[k], cond);
    });
  const table = (rows: () => Row[]) => ({
    findMany: vi.fn(async ({ where }: { where?: Where } = {}) => rows().filter((r) => matches(r, where)).map((r) => ({ ...r }))),
    findUnique: vi.fn(async ({ where }: { where: Where }) => { const r = rows().find((x) => matches(x, where)); return r ? { ...r } : null; }),
    findFirst: vi.fn(async ({ where }: { where?: Where } = {}) => { const r = rows().find((x) => matches(x, where)); return r ? { ...r } : null; }),
    count: vi.fn(async ({ where }: { where?: Where } = {}) => rows().filter((r) => matches(r, where)).length),
    create: vi.fn(async ({ data }: { data: Row }) => {
      if (data.paymentRef && rows().some((r) => r.paymentRef === data.paymentRef)) throw Object.assign(new Error("unique"), { code: "P2002" });
      const r = { id: `id_${rows().length}`, createdAt: new Date(), updatedAt: new Date(), ...data }; rows().push(r); return { ...r };
    }),
    update: vi.fn(async ({ where, data }: { where: Where; data: Row }) => {
      const r = rows().find((x) => matches(x, where)); if (!r) throw new Error("not found"); Object.assign(r, data, { updatedAt: new Date() }); return { ...r };
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Where; data: Row }) => {
      const hit = rows().filter((x) => matches(x, where)); hit.forEach((r) => Object.assign(r, data, { updatedAt: new Date() })); return { count: hit.length };
    }),
    upsert: vi.fn(async ({ where, create, update }: { where: Where; create: Row; update: Row }) => {
      const r = rows().find((x) => matches(x, where));
      if (r) { Object.assign(r, update); return { ...r }; }
      const n = { status: "PENDING", peakPaymentRef: null, peakDocumentId: null, peakRef: null, eslipUrl: null, slips: null, ...create };
      rows().push(n); return { ...n };
    }),
  });
  const client: Row = {
    user: table(() => db.users),
    jobSheet: table(() => db.sheets),
    assignment: table(() => db.assigns),
    tourPayment: table(() => db.pays),
    payrollStatus: table(() => db.payrolls),
    guidePaymentDocument: table(() => db.docs),
    tour: table(() => db.tours),
    auditLog: table(() => db.audits),
  };
  client.$transaction = vi.fn(async (arg: any) => (typeof arg === "function" ? arg(client) : Promise.all(arg)));
  return client;
});

const authMock = vi.hoisted(() => vi.fn());
const peak = vi.hoisted(() => ({ create: vi.fn(), attach: vi.fn(), get: vi.fn(), pay: vi.fn() }));
const drive = vi.hoisted(() => ({ save: vi.fn() }));

vi.mock("@prisma/client", () => ({ Prisma: { PrismaClientKnownRequestError: class extends Error { code = ""; } } }));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/roles", () => ({ isOps: (r?: string) => r === "OPERATOR" || r === "ADMIN", canViewFinance: (r?: string) => ["OPERATOR", "ADMIN", "ACCOUNTANT"].includes(r ?? "") }));
vi.mock("@/lib/jobsheet-send", () => ({ sendPaymentNotice: vi.fn(async () => {}) }));
vi.mock("@/lib/google-drive", () => ({ googleDriveEnabled: true, folkpathsDriveToken: async () => "refresh-token", saveBufferToDrive: drive.save }));
vi.mock("@/lib/peak-api", () => ({
  peakEnabled: true,
  createExpenseAllInOne: peak.create,
  insertExpenseFile: peak.attach,
  getExpenseByCode: peak.get,
  payExistingExpense: peak.pay,
  sanitizePeakError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock("@/lib/peak-account-map", () => ({
  peakAccountMap: async () => ({ entrance: { code: "510104" }, transport: { code: "510104" }, meal: { code: "510104" }, other: { code: "510104" } }),
  guideFeeAccount: async () => ({ code: "510111" }),
  reviewRewardAccount: async () => ({ code: "510110" }),
}));

import { POST, PATCH } from "./route";
import { POST as PAY } from "./pay/route";
import { POST as SYNC } from "../../jobsheet/peak-sync/route";
import { POST as PREVIEW } from "./preview/route";
import { GET as PAYMENTS } from "../../payments/route";
import { NextRequest } from "next/server";
import { POST as MARK_VOIDED } from "../../jobsheet/peak-voided/route";
import { audit } from "@/lib/audit";
import { sendPaymentNotice } from "@/lib/jobsheet-send";

const GUIDE = "G-TEST";
const FEE = (price: number) => ({ price, time: 1, whtPct: 3 });
const J1 = { date: "2030-05-06", slotIdx: 0 };
const J2 = { date: "2030-05-06", slotIdx: 1 };
const J3 = { date: "2030-05-12", slotIdx: 0 };
const OTHER = { date: "2030-05-20", slotIdx: 0 }; // unpaid, not selected

function seed() {
  db.users = [{ guideId: GUIDE, peakContactId: "contact-guide-a", fullName: "Guide A", displayName: "Guide A" }];
  const sheet = (j: typeof J1, ref: string, price: number, expenses: Row[] = []) =>
    ({ guideId: GUIDE, ...j, tourId: "T-001", ref, expenses, guideFee: FEE(price), origin: "NORMAL", createdAt: new Date("2030-05-01"), peakDocumentNo: null, peakDocumentId: null, approvalStatus: "APPROVED" });
  db.sheets = [
    sheet(J1, "FOLK-BKK-20300506-01", 1200),
    sheet(J2, "FOLK-BKK-20300506-02", 1200),
    sheet(J3, "FOLK-BKK-20300512-01", 1800, [{ description: "Offering flowers", price: 95, pax: 1, expenseType: "other", paidBy: "guide" }]),
    sheet(OTHER, "FOLK-BKK-20300520-01", 1200),
  ];
  db.assigns = [J1, J2, J3, OTHER].map((j) => ({ guideId: GUIDE, ...j, tourId: "T-001", createdAt: new Date("2030-05-01") }));
  db.pays = [];
  db.payrolls = [];
  db.docs = [];
  db.tours = [{ id: "T-001", name: "Test Temple Tour" }];
  db.audits = [];
}

// Stage 1: create the document. JSON — nothing about a payment is sent.
const create = (jobs: { date: string; slotIdx: number }[]) =>
  POST(new Request("https://ops.folkpaths.com/api/pay/peak-document", { method: "POST", body: JSON.stringify({ guideId: GUIDE, jobs }), headers: { "content-type": "application/json" } }) as unknown as Parameters<typeof POST>[0]);
// Stage 2: record the payment against an existing document.
const payDoc = (over: Record<string, string> = {}) => {
  const fd = new FormData();
  fd.append("paymentRef", over.paymentRef ?? "FOLK-PAY-203005-01");
  fd.append("documentNo", over.documentNo ?? "EXP-TEST-0042");
  fd.append("paymentDate", over.paymentDate ?? "2030-05-13");
  fd.append("paymentMethodId", over.paymentMethodId ?? "pm-test");
  fd.append("paymentMethodName", "Test bank account");
  if (over.noFile !== "1") fd.append("file", new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }), "slip.png");
  return PAY(new Request("https://ops.folkpaths.com/api/pay/peak-document/pay", { method: "POST", body: fd }) as unknown as Parameters<typeof PAY>[0]);
};
// PEAK's read-back of the created document: approved, unpaid, owing the gross with the withholding apart.
const peakExpense = (over: Row = {}) => ({ ok: true, expense: { id: "peak-doc-42", code: "EXP-TEST-0042", reference: "FOLK-PAY-203005-01", contactId: "contact-guide-a", status: "Approve", statusId: 3, isVoid: false, netAmount: 4295, whtAmount: 126, paymentAmount: 0, remainAmount: 4295, remainWhtAmount: 126, documentLink: "https://peak.example/42", payments: 0, ...over } });
const resolve = (body: unknown) =>
  PATCH(new Request("https://ops.folkpaths.com/api/pay/peak-document", { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } }) as unknown as Parameters<typeof PATCH>[0]);

const payOf = (j: { date: string; slotIdx: number }) => db.pays.find((p) => p.date === j.date && p.slotIdx === j.slotIdx);

beforeEach(() => {
  vi.clearAllMocks();
  seed();
  // The tours ran in May 2030; this is the week after.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2030-05-20T03:00:00Z"));
  authMock.mockResolvedValue({ user: { id: "op_1", role: "OPERATOR" } });
  drive.save.mockResolvedValue({ id: "file-1", link: "https://drive.example/slip-1" });
  peak.create.mockResolvedValue({ ok: true, code: "EXP-TEST-0042", id: "peak-doc-42", link: "https://peak.example/42" });
  peak.attach.mockResolvedValue({ ok: true, desc: "Success" });
  peak.get.mockResolvedValue(peakExpense());
  peak.pay.mockResolvedValue({ ok: true, code: "200", remainPaymentAmount: 0, remainWhtAmount: 0 });
});
afterEach(() => { vi.useRealTimers(); });

describe("stage 1 — POST /api/pay/peak-document creates ONE unpaid document", () => {
  it("creates exactly one PEAK expense, with no payment in it, and returns its EXP", async () => {
    const res = await create([J1, J2, J3]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, status: "AWAITING_PAYMENT", paymentRef: "FOLK-PAY-203005-01", documentNo: "EXP-TEST-0042", documentLink: "https://peak.example/42", gross: 4295, wht: 126, total: 4169, lineCount: 4 });
    expect(peak.create).toHaveBeenCalledTimes(1);
    const expense = peak.create.mock.calls[0][0];
    expect(expense).not.toHaveProperty("paidPayments");
    expect(expense.reference).toBe("FOLK-PAY-203005-01");
    expect(expense.contact).toEqual({ id: "contact-guide-a" });
    expect(expense.products.map((p: Row) => [p.description, p.accountCode, p.price, p.withHoldingTaxAmount])).toEqual([
      ["Guide fee - FOLK-BKK-20300506-01", "510111", 1200, 36],
      ["Guide fee - FOLK-BKK-20300506-02", "510111", 1200, 36],
      ["Guide fee - FOLK-BKK-20300512-01", "510111", 1800, 54],
      ["Reimbursement / Other Tour Cost - FOLK-BKK-20300512-01", "510104", 95, 0],
    ]);
  });

  it("stores the document as AWAITING_PAYMENT and locks the jobs to it — none paid, no slip, no attachment, no notice", async () => {
    await create([J1, J2, J3]);
    expect(db.docs).toHaveLength(1);
    expect(db.docs[0]).toMatchObject({ paymentRef: "FOLK-PAY-203005-01", status: "AWAITING_PAYMENT", peakDocumentNo: "EXP-TEST-0042", peakDocumentId: "peak-doc-42", total: 4169 });
    expect(db.docs[0].paymentDate ?? null).toBeNull();
    expect(db.docs[0].paymentMethodId ?? null).toBeNull();
    for (const j of [J1, J2, J3]) expect(payOf(j)).toMatchObject({ status: "PENDING", peakPaymentRef: "FOLK-PAY-203005-01", peakRef: null, eslipUrl: null });
    expect(payOf(OTHER)).toBeUndefined();
    expect(drive.save).not.toHaveBeenCalled();
    expect(peak.attach).not.toHaveBeenCalled();
    expect(peak.pay).not.toHaveBeenCalled();
    expect(sendPaymentNotice).not.toHaveBeenCalled();
  });

  it("asked twice for the same jobs, answers with the same document — never a second EXP", async () => {
    expect((await create([J1, J2, J3])).status).toBe(200);
    const again = await create([J1, J2, J3]);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ existing: true, documentNo: "EXP-TEST-0042", status: "AWAITING_PAYMENT" });
    expect(peak.create).toHaveBeenCalledTimes(1);
    expect(db.docs).toHaveLength(1);
  });

  it("a different selection that overlaps a live document is refused, not merged into a new EXP", async () => {
    await create([J1, J2, J3]);
    const res = await create([J3, OTHER]);
    expect(res.status).toBe(409);
    expect((await res.json()).reasons.join(" ")).toContain("Included in combined PEAK document EXP-TEST-0042");
    expect(peak.create).toHaveBeenCalledTimes(1);
  });

  it("releases the jobs when PEAK refuses — no document stands", async () => {
    peak.create.mockResolvedValue({ ok: false, desc: "Invalid accountCode" });
    const res = await create([J1, J2, J3]);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("peak-refused");
    expect(db.docs[0]).toMatchObject({ status: "FAILED", error: "Invalid accountCode" });
    for (const j of [J1, J2, J3]) expect(payOf(j)).toMatchObject({ status: "PENDING", peakPaymentRef: null });
    // Released means a new document can be created.
    peak.create.mockResolvedValue({ ok: true, code: "EXP-TEST-0043", id: "peak-doc-43" });
    expect((await create([J1, J2, J3])).status).toBe(200);
  });

  it("keeps the jobs locked when PEAK may have created the document — no automatic retry, a second press creates nothing", async () => {
    peak.create.mockResolvedValue({ ok: false, uncertain: true, desc: "PEAK did not respond within 30s" });
    const res = await create([J1, J2, J3]);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("peak-uncertain");
    expect(db.docs[0].status).toBe("CREATE_UNCERTAIN");
    for (const j of [J1, J2, J3]) expect(payOf(j)).toMatchObject({ status: "PENDING", peakPaymentRef: "FOLK-PAY-203005-01" });
    const again = await create([J1, J2, J3]);
    expect(again.status).toBe(409);
    expect(peak.create).toHaveBeenCalledTimes(1);
  });

  it("refuses a job whose sheet already posted its own PEAK document, before calling PEAK", async () => {
    db.sheets.find((s) => s.date === J3.date && s.slotIdx === J3.slotIdx)!.peakDocumentNo = "EXP-TEST-0001";
    const res = await create([J1, J2, J3]);
    expect(res.status).toBe(409);
    expect((await res.json()).reasons.join(" ")).toContain("EXP-TEST-0001");
    expect(peak.create).not.toHaveBeenCalled();
    expect(db.docs).toHaveLength(0);
  });

  it("the job-sheet Sync to PEAK is refused while the combined document holds the job", async () => {
    await create([J1, J2, J3]);
    const res = await SYNC(new Request("https://ops.folkpaths.com/api/jobsheet/peak-sync", { method: "POST", body: JSON.stringify({ guideId: GUIDE, ...J1 }), headers: { "content-type": "application/json" } }) as unknown as Parameters<typeof SYNC>[0]);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("paid-in-payment-document");
    expect(body.reason).toContain("Included in combined PEAK document EXP-TEST-0042");
    expect(body.reason).toContain("Awaiting payment");
    expect(peak.create).toHaveBeenCalledTimes(1);
  });
});

describe("stage 2 — POST /api/pay/peak-document/pay records the payment against the same EXP", () => {
  it("pays the existing EXP — no second document — marks all jobs paid with the same EXP, attaches the slip and tells the guide once", async () => {
    await create([J1, J2, J3]);
    const res = await payDoc();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "PAID", paymentRef: "FOLK-PAY-203005-01", documentNo: "EXP-TEST-0042", amount: 4169, paymentDate: "2030-05-13", notified: true });
    expect(peak.create).toHaveBeenCalledTimes(1);
    expect(peak.get).toHaveBeenCalledWith("EXP-TEST-0042");
    expect(peak.pay).toHaveBeenCalledTimes(1);
    expect(peak.pay.mock.calls[0][0]).toEqual({ documentNo: "EXP-TEST-0042", paymentDate: "20300513", paymentMethodId: "pm-test", amount: 4169, withholdingTaxAmount: 126 });
    for (const j of [J1, J2, J3]) {
      expect(payOf(j)).toMatchObject({ status: "PAID", peakPaymentRef: "FOLK-PAY-203005-01", peakRef: "EXP-TEST-0042", peakDocumentId: "peak-doc-42", eslipUrl: "https://drive.example/slip-1" });
      expect(payOf(j)!.paidAt.toISOString()).toBe("2030-05-13T05:00:00.000Z");
    }
    expect(payOf(OTHER)).toBeUndefined();
    expect(db.docs).toHaveLength(1);
    expect(db.docs[0]).toMatchObject({ status: "PAID", paymentDate: "2030-05-13", paymentMethodId: "pm-test", slipUrl: "https://drive.example/slip-1", attachmentStatus: "ATTACHED" });
    expect(drive.save).toHaveBeenCalledTimes(1);
    expect(peak.attach).toHaveBeenCalledTimes(1);
    expect(peak.attach.mock.calls[0][0]).toMatchObject({ transactionId: "peak-doc-42", transactionCode: "EXP-TEST-0042" });
    expect(sendPaymentNotice).toHaveBeenCalledTimes(1);
  });

  it("refuses to pay before a document exists", async () => {
    const res = await payDoc();
    expect(res.status).toBe(404);
    expect(peak.pay).not.toHaveBeenCalled();
  });

  it("refuses a document whose PEAK creation is not confirmed", async () => {
    peak.create.mockResolvedValue({ ok: false, uncertain: true, desc: "timeout" });
    await create([J1, J2, J3]);
    const res = await payDoc();
    expect(res.status).toBe(409);
    expect((await res.json()).reasons.join(" ")).toContain("no PEAK document awaiting payment");
    expect(peak.pay).not.toHaveBeenCalled();
  });

  it("refuses to pay an already-paid EXP again", async () => {
    await create([J1, J2, J3]);
    expect((await payDoc()).status).toBe(200);
    const again = await payDoc();
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "already-paid" });
    expect(peak.pay).toHaveBeenCalledTimes(1);
    expect(sendPaymentNotice).toHaveBeenCalledTimes(1);
  });

  it("refuses the wrong EXP for the document", async () => {
    await create([J1, J2, J3]);
    const res = await payDoc({ documentNo: "EXP-TEST-0099" });
    expect(res.status).toBe(409);
    expect((await res.json()).reasons.join(" ")).toContain("is for EXP-TEST-0042, not EXP-TEST-0099");
    expect(peak.get).not.toHaveBeenCalled();
    expect(peak.pay).not.toHaveBeenCalled();
  });

  it("reads the EXP back from PEAK and pays nothing — no slip upload — if PEAK shows it is a draft", async () => {
    await create([J1, J2, J3]);
    peak.get.mockResolvedValue(peakExpense({ status: "Draft" }));
    const res = await payDoc();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "peak-check-failed" });
    expect(drive.save).not.toHaveBeenCalled();
    expect(peak.pay).not.toHaveBeenCalled();
    expect(db.docs[0]).toMatchObject({ status: "AWAITING_PAYMENT" });
    for (const j of [J1, J2, J3]) expect(payOf(j)!.status).toBe("PENDING");
  });

  it("keeps the jobs unpaid when PEAK may have recorded the payment — no retry, no notice", async () => {
    await create([J1, J2, J3]);
    peak.pay.mockResolvedValue({ ok: false, uncertain: true, desc: "PEAK did not respond within 30s" });
    const res = await payDoc();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "peak-uncertain" });
    expect(db.docs[0].status).toBe("PAYMENT_UNCERTAIN");
    for (const j of [J1, J2, J3]) expect(payOf(j)).toMatchObject({ status: "PENDING", peakPaymentRef: "FOLK-PAY-203005-01" });
    expect(sendPaymentNotice).not.toHaveBeenCalled();
    expect((await payDoc()).status).toBe(409);
    expect(peak.pay).toHaveBeenCalledTimes(1);
  });

  it("when PEAK refuses the payment the document awaits payment again, and the jobs stay unpaid", async () => {
    await create([J1, J2, J3]);
    peak.pay.mockResolvedValue({ ok: false, code: "347", desc: "Transaction must be Waiting Payment Status." });
    const res = await payDoc();
    expect(res.status).toBe(502);
    expect(db.docs[0]).toMatchObject({ status: "AWAITING_PAYMENT", error: "Transaction must be Waiting Payment Status.", paymentDate: null });
    for (const j of [J1, J2, J3]) expect(payOf(j)!.status).toBe("PENDING");
    peak.pay.mockResolvedValue({ ok: true, code: "200", remainPaymentAmount: 0, remainWhtAmount: 0 });
    expect((await payDoc()).status).toBe(200);
    expect(peak.create).toHaveBeenCalledTimes(1);
  });

  it("a job whose figures changed after the EXP was created stops the payment — no PEAK call, no new document", async () => {
    await create([J1, J2, J3]);
    db.sheets.find((s) => s.date === J3.date && s.slotIdx === J3.slotIdx)!.expenses = [{ description: "Offering flowers", price: 120, pax: 1, expenseType: "other", paidBy: "guide" }];
    const res = await payDoc();
    expect(res.status).toBe(409);
    const reasons = (await res.json()).reasons.join(" ");
    expect(reasons).toContain("FOLK-BKK-20300512-01 now pays ฿1,866.00, but EXP-TEST-0042 was created for ฿1,841.00");
    expect(reasons).toContain("Nothing was paid");
    expect(peak.get).not.toHaveBeenCalled();
    expect(peak.pay).not.toHaveBeenCalled();
    expect(peak.create).toHaveBeenCalledTimes(1);
    expect(db.docs[0].status).toBe("AWAITING_PAYMENT");
  });

  it("a job that lost its approval between the stages stops the payment", async () => {
    await create([J1, J2, J3]);
    db.sheets.find((s) => s.date === J2.date && s.slotIdx === J2.slotIdx)!.approvalStatus = null;
    const res = await payDoc();
    expect(res.status).toBe(409);
    expect((await res.json()).reasons.join(" ")).toContain("FOLK-BKK-20300506-02 is no longer approved");
    expect(peak.pay).not.toHaveBeenCalled();
  });

  it("needs a slip", async () => {
    await create([J1, J2, J3]);
    expect((await payDoc({ noFile: "1" })).status).toBe(400);
    expect(peak.pay).not.toHaveBeenCalled();
  });

  it("keeps the payment when only the slip attachment fails — the money is recorded", async () => {
    await create([J1, J2, J3]);
    peak.attach.mockResolvedValue({ ok: false, desc: "file too large" });
    const res = await payDoc();
    expect(res.status).toBe(200);
    expect((await res.json()).attachment).toEqual({ ok: false, reason: "file too large" });
    for (const j of [J1, J2, J3]) expect(payOf(j)!.status).toBe("PAID");
    expect(db.docs[0]).toMatchObject({ status: "PAID", attachmentStatus: "FAILED" });
  });
});

describe("a billed expense with no Paid By stops the document before PEAK", () => {
  const unset = () => {
    const j3 = db.sheets.find((s) => s.date === J3.date && s.slotIdx === J3.slotIdx)!;
    j3.expenses = [{ description: "Offering flowers", price: 95, pax: 1, expenseType: "other" }]; // Paid By missing
  };

  it("the preview refuses, naming the job sheet and row", async () => {
    unset();
    const res = await PREVIEW(new Request("https://ops.folkpaths.com/api/pay/peak-document/preview", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ guideId: GUIDE, jobs: [J1, J2, J3] }),
    }) as unknown as Parameters<typeof PREVIEW>[0]);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reasons.join(" ")).toContain('FOLK-BKK-20300512-01 row 1 "Offering flowers": Paid By is not set');
  });

  it("creating the document refuses with 409 — no PEAK document, no payment record, nothing paid", async () => {
    unset();
    const res = await create([J1, J2, J3]);
    expect(res.status).toBe(409);
    expect((await res.json()).reasons.join(" ")).toContain('FOLK-BKK-20300512-01 row 1 "Offering flowers": Paid By is not set');
    expect(peak.create).not.toHaveBeenCalled();
    expect(db.docs).toHaveLength(0);
    expect(db.pays.filter((p) => p.status === "PAID" || p.peakPaymentRef)).toHaveLength(0);
  });
});

describe("PATCH /api/pay/peak-document — settling what PEAK did not confirm", () => {
  it("a document found in PEAK is recorded as awaiting payment — NOT paid", async () => {
    peak.create.mockResolvedValue({ ok: false, uncertain: true, desc: "timeout" });
    await create([J1, J2, J3]);
    db.docs[0].updatedAt = new Date(Date.now() - 10 * 60_000); // past the in-flight window
    const res = await resolve({ paymentRef: "FOLK-PAY-203005-01", resolution: "found", documentNo: "EXP-TEST-0044" });
    expect(res.status).toBe(200);
    expect(db.docs[0]).toMatchObject({ status: "AWAITING_PAYMENT", peakDocumentNo: "EXP-TEST-0044" });
    for (const j of [J1, J2, J3]) expect(payOf(j)).toMatchObject({ status: "PENDING", peakPaymentRef: "FOLK-PAY-203005-01" });
    expect(sendPaymentNotice).not.toHaveBeenCalled();
  });

  it("a document not in PEAK releases the jobs", async () => {
    peak.create.mockResolvedValue({ ok: false, uncertain: true, desc: "timeout" });
    await create([J1, J2, J3]);
    db.docs[0].updatedAt = new Date(Date.now() - 10 * 60_000);
    expect((await resolve({ paymentRef: "FOLK-PAY-203005-01", resolution: "not-found" })).status).toBe(200);
    expect(db.docs[0].status).toBe("FAILED");
    for (const j of [J1, J2, J3]) expect(payOf(j)!.peakPaymentRef).toBeNull();
  });

  it("a payment found in PEAK marks the jobs paid and tells the guide once", async () => {
    await create([J1, J2, J3]);
    peak.pay.mockResolvedValue({ ok: false, uncertain: true, desc: "timeout" });
    await payDoc();
    db.docs[0].updatedAt = new Date(Date.now() - 10 * 60_000);
    expect((await resolve({ paymentRef: "FOLK-PAY-203005-01", resolution: "payment-found" })).status).toBe(200);
    expect(db.docs[0].status).toBe("PAID");
    for (const j of [J1, J2, J3]) expect(payOf(j)).toMatchObject({ status: "PAID", peakRef: "EXP-TEST-0042" });
    expect(sendPaymentNotice).toHaveBeenCalledTimes(1);
  });

  it("no payment in PEAK returns the document to awaiting payment", async () => {
    await create([J1, J2, J3]);
    peak.pay.mockResolvedValue({ ok: false, uncertain: true, desc: "timeout" });
    await payDoc();
    db.docs[0].updatedAt = new Date(Date.now() - 10 * 60_000);
    expect((await resolve({ paymentRef: "FOLK-PAY-203005-01", resolution: "payment-not-found" })).status).toBe(200);
    expect(db.docs[0]).toMatchObject({ status: "AWAITING_PAYMENT", paymentDate: null });
    for (const j of [J1, J2, J3]) expect(payOf(j)!.status).toBe("PENDING");
    expect(sendPaymentNotice).not.toHaveBeenCalled();
  });

  it("a document voided in PEAK before payment releases its jobs; the EXP stays on the document record", async () => {
    await create([J1, J2, J3]);
    expect((await resolve({ paymentRef: "FOLK-PAY-203005-01", resolution: "voided" })).status).toBe(200);
    expect(db.docs[0]).toMatchObject({ status: "VOIDED", peakDocumentNo: "EXP-TEST-0042" });
    for (const j of [J1, J2, J3]) expect(payOf(j)).toMatchObject({ status: "PENDING", peakPaymentRef: null });
  });

  it("will not resolve a document that may still be in flight", async () => {
    peak.create.mockImplementation(() => new Promise(() => {})); // never answers
    void create([J1, J2, J3]);
    await vi.waitFor(() => expect(db.docs[0]?.status).toBe("CREATING"));
    const res = await resolve({ paymentRef: "FOLK-PAY-203005-01", resolution: "not-found" });
    expect(res.status).toBe(409);
  });
});

describe("already in PEAK from the job sheet — the Payments count and the server agree", () => {
  const J4 = { date: "2030-05-21", slotIdx: 0 };
  const preview = (jobs: { date: string; slotIdx: number }[]) => PREVIEW(new Request("https://ops.folkpaths.com/api/pay/peak-document/preview", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ guideId: GUIDE, paymentDate: "2030-05-28", jobs }),
  }) as unknown as Parameters<typeof PREVIEW>[0]);
  const payments = async () => {
    const res = await PAYMENTS(new NextRequest("https://ops.folkpaths.com/api/payments?period=2030-05"));
    return (await res.json()).rows.find((r: Row) => r.guideId === GUIDE).jobs as Row[];
  };

  beforeEach(() => {
    // Payments counts only tours that have already run; these ran in May 2030.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-06-02T03:00:00Z"));
    db.sheets.push({ guideId: GUIDE, ...J4, tourId: "T-001", ref: "FOLK-BKK-20300521-01", expenses: [], guideFee: FEE(1200), origin: "NORMAL", createdAt: new Date("2030-05-01"), peakDocumentNo: null, peakDocumentId: null, approvalStatus: "APPROVED" });
    db.assigns.push({ guideId: GUIDE, ...J4, tourId: "T-001", createdAt: new Date("2030-05-01") });
    // Two of the five were synced to PEAK one at a time from their own job sheets.
    Object.assign(db.sheets.find((x) => x.date === J1.date && x.slotIdx === J1.slotIdx)!, { peakDocumentNo: "EXP-TEST-0027", peakDocumentId: "peak-doc-27", peakSyncStatus: "SYNCED" });
    Object.assign(db.sheets.find((x) => x.date === OTHER.date && x.slotIdx === OTHER.slotIdx)!, { peakDocumentNo: "EXP-TEST-0026", peakDocumentId: "peak-doc-26", peakSyncStatus: "SYNCED" });
  });
  afterEach(() => { vi.useRealTimers(); });

  it("GET /api/payments counts 3 payable together, keeps all 5 listed, and names each job's own document", async () => {
    const jobs = await payments();
    expect(jobs).toHaveLength(5);
    expect(jobs.filter((j) => !j.paid && j.combinable).map((j) => j.ref)).toEqual(["FOLK-BKK-20300506-02", "FOLK-BKK-20300512-01", "FOLK-BKK-20300521-01"]);
    const inPeak = jobs.filter((j) => j.combinedBlock?.code === "in-peak-from-sheet");
    expect(inPeak.map((j) => [j.ref, j.sheetPeakDocumentNo, j.combinable])).toEqual([
      ["FOLK-BKK-20300506-01", "EXP-TEST-0027", false],
      ["FOLK-BKK-20300520-01", "EXP-TEST-0026", false],
    ]);
  });

  it("the preview accepts exactly the jobs the page offers", async () => {
    const offered = (await payments()).filter((j) => !j.paid && j.combinable).map((j) => ({ date: j.date, slotIdx: j.slotIdx }));
    const body = await (await preview(offered)).json();
    // 1,164 + (1,746 + 95) + 1,164 — each fee net of 3% withholding, plus the reimbursement.
    expect(body).toMatchObject({ ok: true, total: 4169 });
    expect(body.jobs.map((j: Row) => j.ref)).toEqual(["FOLK-BKK-20300506-02", "FOLK-BKK-20300512-01", "FOLK-BKK-20300521-01"]);
  });

  it("and refuses the ones it does not, naming both documents and nothing else", async () => {
    const all = (await payments()).map((j) => ({ date: j.date, slotIdx: j.slotIdx }));
    const body = await (await preview(all)).json();
    expect(body.ok).toBe(false);
    expect(body.reasons).toHaveLength(2);
    expect(body.reasons[0]).toContain("FOLK-BKK-20300506-01");
    expect(body.reasons[0]).toContain("EXP-TEST-0027");
    expect(body.reasons[1]).toContain("FOLK-BKK-20300520-01");
    expect(body.reasons[1]).toContain("EXP-TEST-0026");
  });

  it("creating refuses the same set before any write — no PEAK call, no payment record", async () => {
    const res = await create([J1, J2, J3, J4, OTHER]);
    expect(res.status).toBe(409);
    expect(drive.save).not.toHaveBeenCalled();
    expect(peak.create).not.toHaveBeenCalled();
    expect(db.docs).toHaveLength(0);
    expect(db.pays).toHaveLength(0);
  });

  it("a sheet posted between loading and claiming is still refused inside the claim", async () => {
    const j4 = db.sheets.find((x) => x.date === J4.date && x.slotIdx === J4.slotIdx)!;
    // The loader reads every sheet with findMany, clean. The claim re-reads each one
    // inside its transaction — by then this one has been synced on its own.
    const real = prismaMock.jobSheet.findUnique.getMockImplementation()!;
    prismaMock.jobSheet.findUnique.mockImplementation(async (arg: any) => {
      if (arg?.where?.guideId_date_slotIdx?.date === J4.date) j4.peakDocumentNo = "EXP-TEST-0031";
      return real(arg);
    });
    try {
      const res = await create([J2, J4]);
      expect(res.status).toBe(409);
      expect((await res.json()).reasons.join(" ")).toContain("EXP-TEST-0031");
      expect(drive.save).not.toHaveBeenCalled();
      expect(peak.create).not.toHaveBeenCalled();
      expect(db.docs).toHaveLength(0);
      expect(db.pays).toHaveLength(0);
    } finally {
      prismaMock.jobSheet.findUnique.mockImplementation(real);
    }
  });
});

describe("a combined PEAK payment takes approved job sheets only", () => {
  const sheetOf = (j: { date: string; slotIdx: number }) => db.sheets.find((x) => x.date === j.date && x.slotIdx === j.slotIdx)!;
  const preview = (jobs: { date: string; slotIdx: number }[]) => PREVIEW(new Request("https://ops.folkpaths.com/api/pay/peak-document/preview", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ guideId: GUIDE, paymentDate: "2030-05-13", jobs }),
  }) as unknown as Parameters<typeof PREVIEW>[0]);

  it("approved: the preview builds the document and it can be created", async () => {
    expect((await (await preview([J1, J2, J3])).json()).ok).toBe(true);
    expect((await create([J1, J2, J3])).status).toBe(200);
  });

  it("unapproved: the preview names exactly that job, and only that job", async () => {
    sheetOf(J2).approvalStatus = null; // e.g. still "Review: no-show", never signed off
    const body = await (await preview([J1, J2, J3])).json();
    expect(body.ok).toBe(false);
    expect(body.reasons).toEqual(["FOLK-BKK-20300506-02 is not approved — approve the job sheet before paying it in a PEAK document"]);
  });

  it("a mixed batch with one unapproved job is refused whole — no slip, no PEAK write, no payment rows, no notice, no audit", async () => {
    sheetOf(J3).approvalStatus = null;
    const res = await create([J1, J2, J3]);
    expect(res.status).toBe(409);
    expect((await res.json()).reasons).toEqual([expect.stringContaining("FOLK-BKK-20300512-01 is not approved")]);
    expect(drive.save).not.toHaveBeenCalled();
    expect(peak.create).not.toHaveBeenCalled();
    expect(peak.attach).not.toHaveBeenCalled();
    expect(db.docs).toHaveLength(0);
    expect(db.pays).toHaveLength(0);
    expect(sendPaymentNotice).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("approval withdrawn after the jobs were loaded is caught inside the claim, before anything is written", async () => {
    const real = prismaMock.jobSheet.findUnique.getMockImplementation()!;
    prismaMock.jobSheet.findUnique.mockImplementation(async (arg: any) => {
      const k = arg?.where?.guideId_date_slotIdx;
      if (k?.date === J2.date && k?.slotIdx === J2.slotIdx) sheetOf(J2).approvalStatus = null;
      return real(arg);
    });
    try {
      const res = await create([J1, J2, J3]);
      expect(res.status).toBe(409);
      expect((await res.json()).reasons.join(" ")).toContain("FOLK-BKK-20300506-02 is no longer approved");
      expect(drive.save).not.toHaveBeenCalled();
      expect(peak.create).not.toHaveBeenCalled();
      expect(db.docs).toHaveLength(0);
      expect(db.pays).toHaveLength(0);
    } finally {
      prismaMock.jobSheet.findUnique.mockImplementation(real);
    }
  });

  it("Payments does not count an unapproved job as payable together", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-06-02T03:00:00Z"));
    try {
      sheetOf(J2).approvalStatus = null;
      const res = await PAYMENTS(new NextRequest("https://ops.folkpaths.com/api/payments?period=2030-05"));
      const jobs = (await res.json()).rows[0].jobs as Row[];
      expect(jobs.find((j) => j.ref === "FOLK-BKK-20300506-02")).toMatchObject({ combinable: false, combinedBlock: { code: "not-approved" } });
      expect(jobs.filter((j) => j.combinable).map((j) => j.ref)).toEqual(["FOLK-BKK-20300506-01", "FOLK-BKK-20300512-01", "FOLK-BKK-20300520-01"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the preview lists every row with no expense category, including on a job waiting for approval", () => {
  const sheetOf = (j: { date: string; slotIdx: number }) => db.sheets.find((x) => x.date === j.date && x.slotIdx === j.slotIdx)!;
  const preview = (jobs: { date: string; slotIdx: number }[]) => PREVIEW(new Request("https://ops.folkpaths.com/api/pay/peak-document/preview", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ guideId: GUIDE, paymentDate: "2030-05-13", jobs }),
  }) as unknown as Parameters<typeof PREVIEW>[0]);
  const noCategory = (): Row[] => [
    { description: "Water (Inc. Guide)", price: 10, pax: 3, paidBy: "guide" },
    { description: "Ferry (Inc. Guide)", price: 16, pax: 3, paidBy: "guide" },
    { description: "Bus (Inc. Guide)", price: 15, pax: 3, paidBy: "guide" },
  ];

  beforeEach(() => {
    for (const j of [J1, J2, J3]) sheetOf(j).expenses = noCategory();
    sheetOf(J1).approvalStatus = null; // still under review
  });

  it("all nine rows, with job number, row, description and amount — and the approval refusal alongside", async () => {
    const body = await (await preview([J1, J2, J3])).json();
    expect(body.ok).toBe(false);
    expect(body.reasons).toContain("FOLK-BKK-20300506-01 is not approved — approve the job sheet before paying it in a PEAK document");
    expect(body.missingCategories).toHaveLength(9);
    expect(body.missingCategories.map((r: Row) => [r.jobRef, r.rowNo, r.description, r.amount])).toEqual([
      ["FOLK-BKK-20300506-01", 1, "Water (Inc. Guide)", 30], ["FOLK-BKK-20300506-01", 2, "Ferry (Inc. Guide)", 48], ["FOLK-BKK-20300506-01", 3, "Bus (Inc. Guide)", 45],
      ["FOLK-BKK-20300506-02", 1, "Water (Inc. Guide)", 30], ["FOLK-BKK-20300506-02", 2, "Ferry (Inc. Guide)", 48], ["FOLK-BKK-20300506-02", 3, "Bus (Inc. Guide)", 45],
      ["FOLK-BKK-20300512-01", 1, "Water (Inc. Guide)", 30], ["FOLK-BKK-20300512-01", 2, "Ferry (Inc. Guide)", 48], ["FOLK-BKK-20300512-01", 3, "Bus (Inc. Guide)", 45],
    ]);
  });

  it("creating still refuses — listing the rows — and writes nothing, even once everything is approved", async () => {
    sheetOf(J1).approvalStatus = "APPROVED";
    const res = await create([J1, J2, J3]);
    expect(res.status).toBe(409);
    expect((await res.json()).missingCategories).toHaveLength(9);
    expect(drive.save).not.toHaveBeenCalled();
    expect(peak.create).not.toHaveBeenCalled();
    expect(db.docs).toHaveLength(0);
    expect(db.pays).toHaveLength(0);
    expect(db.sheets.flatMap((x) => x.expenses).every((e: Row) => !e.expenseType || e.description === "Offering flowers")).toBe(true);
  });

  it("once the categories are set on the sheets, the same jobs preview as one document", async () => {
    sheetOf(J1).approvalStatus = "APPROVED";
    for (const j of [J1, J2, J3]) sheetOf(j).expenses = noCategory().map((e) => ({ ...e, expenseType: e.description.startsWith("Water") ? "meal" : "transport" }));
    const body = await (await preview([J1, J2, J3])).json();
    expect(body).toMatchObject({ ok: true });
    expect(body.missingCategories).toBeUndefined();
  });
});

describe("Voided in PEAK: a job-sheet document voided in PEAK can be paid together again", () => {
  const sheetOf = (j: { date: string; slotIdx: number }) => db.sheets.find((x) => x.date === j.date && x.slotIdx === j.slotIdx)!;
  const preview = (jobs: { date: string; slotIdx: number }[]) => PREVIEW(new Request("https://ops.folkpaths.com/api/pay/peak-document/preview", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ guideId: GUIDE, paymentDate: "2030-05-13", jobs }),
  }) as unknown as Parameters<typeof PREVIEW>[0]);
  const markVoided = (documentNo: string) => MARK_VOIDED(new Request("https://ops.folkpaths.com/api/jobsheet/peak-voided", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ guideId: GUIDE, ...J1, documentNo, confirmVoidedInPeak: true }),
  }) as unknown as Parameters<typeof MARK_VOIDED>[0]);

  beforeEach(() => {
    Object.assign(sheetOf(J1), { id: "js_j1", peakSyncStatus: "SYNCED", peakDocumentNo: "EXP-TEST-0027", peakDocumentId: "peak-doc-27", syncedAt: new Date("2030-05-07T04:00:00Z"), lastPayloadHash: "h27" });
  });

  it("refused before, one document after — and the old number is still in the job's history", async () => {
    const before = await (await preview([J1, J2, J3])).json();
    expect(before.ok).toBe(false);
    expect(before.reasons.join(" ")).toContain("EXP-TEST-0027");

    authMock.mockResolvedValue({ user: { id: "admin_1", role: "ADMIN" } });
    expect((await markVoided("EXP-TEST-0027")).status).toBe(200);

    const after = await (await preview([J1, J2, J3])).json();
    expect(after).toMatchObject({ ok: true, total: 4169 });
    expect(db.audits.filter((a) => a.action === "jobsheet.peak_voided")).toEqual([
      expect.objectContaining({ entityId: "js_j1", actorId: "admin_1", detail: expect.objectContaining({ previousDocumentNo: "EXP-TEST-0027", previousDocumentId: "peak-doc-27" }) }),
    ]);
    // Voiding touched no payment record and called nothing.
    expect(db.pays).toHaveLength(0);
    expect(peak.create).not.toHaveBeenCalled();
  });

  it("a guide or an accountant cannot do it", async () => {
    for (const role of ["GUIDE", "ACCOUNTANT"]) {
      authMock.mockResolvedValue({ user: { id: "u_1", role } });
      expect((await markVoided("EXP-TEST-0027")).status).toBe(403);
    }
    expect(sheetOf(J1).peakDocumentNo).toBe("EXP-TEST-0027");
    expect(db.audits).toHaveLength(0);
  });
});
