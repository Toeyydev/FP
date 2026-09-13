import { vi, describe, it, expect, beforeEach } from "vitest";

// All data here is invented (fictional month and amounts) — this repo is public.
//
// Mocked at the seams only — the database, Drive, PEAK's network calls and auth. The
// loader, the claim transaction, the paid/failed writes and the document builder are
// the REAL ones, so these tests check the actual queries that lock the jobs and point
// every one of them at the same document.

type Row = Record<string, any>;
type Where = Record<string, any>;

const db = vi.hoisted(() => ({
  users: [] as Row[], sheets: [] as Row[], assigns: [] as Row[], pays: [] as Row[], payrolls: [] as Row[], docs: [] as Row[],
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
      const r = { id: `id_${rows().length}`, createdAt: new Date(), ...data }; rows().push(r); return { ...r };
    }),
    update: vi.fn(async ({ where, data }: { where: Where; data: Row }) => {
      const r = rows().find((x) => matches(x, where)); if (!r) throw new Error("not found"); Object.assign(r, data); return { ...r };
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Where; data: Row }) => {
      const hit = rows().filter((x) => matches(x, where)); hit.forEach((r) => Object.assign(r, data)); return { count: hit.length };
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
  };
  client.$transaction = vi.fn(async (arg: any) => (typeof arg === "function" ? arg(client) : Promise.all(arg)));
  return client;
});

const authMock = vi.hoisted(() => vi.fn());
const peak = vi.hoisted(() => ({ create: vi.fn(), attach: vi.fn() }));
const drive = vi.hoisted(() => ({ save: vi.fn() }));

vi.mock("@prisma/client", () => ({ Prisma: { PrismaClientKnownRequestError: class extends Error { code = ""; } } }));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/roles", () => ({ isOps: (r?: string) => r === "OPERATOR" || r === "ADMIN" }));
vi.mock("@/lib/jobsheet-send", () => ({ sendPaymentNotice: vi.fn(async () => {}) }));
vi.mock("@/lib/google-drive", () => ({ googleDriveEnabled: true, folkpathsDriveToken: async () => "refresh-token", saveBufferToDrive: drive.save }));
vi.mock("@/lib/peak-api", () => ({
  peakEnabled: true,
  createExpenseAllInOne: peak.create,
  insertExpenseFile: peak.attach,
  sanitizePeakError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock("@/lib/peak-account-map", () => ({
  peakAccountMap: async () => ({ entrance: { code: "510104" }, transport: { code: "510104" }, meal: { code: "510104" }, other: { code: "510104" } }),
  guideFeeAccount: async () => ({ code: "510111" }),
  reviewRewardAccount: async () => ({ code: "510110" }),
}));

import { POST, PATCH } from "./route";
import { POST as PREVIEW } from "./preview/route";

const GUIDE = "G-TEST";
const FEE = (price: number) => ({ price, time: 1, whtPct: 3 });
const J1 = { date: "2030-05-06", slotIdx: 0 };
const J2 = { date: "2030-05-06", slotIdx: 1 };
const J3 = { date: "2030-05-12", slotIdx: 0 };
const OTHER = { date: "2030-05-20", slotIdx: 0 }; // unpaid, not selected

function seed() {
  db.users = [{ guideId: GUIDE, peakContactId: "contact-guide-a", fullName: "Guide A", displayName: "Guide A" }];
  const sheet = (j: typeof J1, ref: string, price: number, expenses: Row[] = []) =>
    ({ guideId: GUIDE, ...j, tourId: "T-001", ref, expenses, guideFee: FEE(price), origin: "NORMAL", createdAt: new Date("2030-05-01"), peakDocumentNo: null, peakDocumentId: null });
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
}

const payForm = (jobs: { date: string; slotIdx: number }[], over: Record<string, string> = {}) => {
  const fd = new FormData();
  fd.append("guideId", GUIDE);
  fd.append("jobs", JSON.stringify(jobs));
  fd.append("paymentDate", over.paymentDate ?? "2030-05-13");
  fd.append("paymentMethodId", over.paymentMethodId ?? "pm-test");
  fd.append("paymentMethodName", "Test bank account");
  fd.append("file", new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }), "slip.png");
  return POST(new Request("https://ops.folkpaths.com/api/pay/peak-document", { method: "POST", body: fd }) as unknown as Parameters<typeof POST>[0]);
};
const resolve = (body: unknown) =>
  PATCH(new Request("https://ops.folkpaths.com/api/pay/peak-document", { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } }) as unknown as Parameters<typeof PATCH>[0]);

const payOf = (j: { date: string; slotIdx: number }) => db.pays.find((p) => p.date === j.date && p.slotIdx === j.slotIdx);

beforeEach(() => {
  vi.clearAllMocks();
  seed();
  authMock.mockResolvedValue({ user: { id: "op_1", role: "OPERATOR" } });
  drive.save.mockResolvedValue({ id: "file-1", link: "https://drive.example/slip-1" });
  peak.create.mockResolvedValue({ ok: true, code: "EXP-TEST-0042", id: "peak-doc-42", link: "https://peak.example/42" });
  peak.attach.mockResolvedValue({ ok: true, desc: "Success" });
});

describe("POST /api/pay/peak-document — three jobs, one transfer", () => {
  it("creates exactly one PEAK document and marks every selected job paid against it", async () => {
    const res = await payForm([J1, J2, J3]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, paymentRef: "FOLK-PAY-203005-01", documentNo: "EXP-TEST-0042", total: 4169 });

    expect(peak.create).toHaveBeenCalledTimes(1);
    const expense = peak.create.mock.calls[0][0];
    expect(expense.reference).toBe("FOLK-PAY-203005-01");
    expect(expense.contact).toEqual({ id: "contact-guide-a" });
    expect(expense.paidPayments).toEqual({ paymentDate: "20300513", payments: [{ paymentMethod: { id: "pm-test" }, amount: 4169 }] });
    expect(expense.products.map((p: Row) => [p.description, p.accountCode, p.price, p.withHoldingTaxAmount])).toEqual([
      ["Guide fee - FOLK-BKK-20300506-01", "510111", 1200, 36],
      ["Guide fee - FOLK-BKK-20300506-02", "510111", 1200, 36],
      ["Guide fee - FOLK-BKK-20300512-01", "510111", 1800, 54],
      ["Reimbursement / Other Tour Cost - FOLK-BKK-20300512-01", "510104", 95, 0],
    ]);
  });

  it("stores the same payment ref and PEAK document on every selected row, and touches no other", async () => {
    await payForm([J1, J2, J3]);
    for (const j of [J1, J2, J3]) {
      expect(payOf(j)).toMatchObject({
        status: "PAID", peakPaymentRef: "FOLK-PAY-203005-01", peakDocumentId: "peak-doc-42",
        peakRef: "EXP-TEST-0042", eslipUrl: "https://drive.example/slip-1",
      });
    }
    expect(payOf(OTHER)).toBeUndefined();
    expect(db.docs).toHaveLength(1);
  });

  it("records the payment date the operator selected, not the moment they pressed Pay", async () => {
    await payForm([J1, J2, J3], { paymentDate: "2030-05-14" });
    // The same date PEAK receives. Noon in Bangkok, so it reads as the 14th anywhere.
    for (const j of [J1, J2, J3]) expect(payOf(j)!.paidAt.toISOString()).toBe("2030-05-14T05:00:00.000Z");
    expect(peak.create.mock.calls[0][0].paidPayments.paymentDate).toBe("20300514");
    expect(db.docs[0]).toMatchObject({ status: "POSTED", total: 4169, peakDocumentNo: "EXP-TEST-0042", attachmentStatus: "ATTACHED" });
  });

  it("attaches the one slip to the one document", async () => {
    await payForm([J1, J2, J3]);
    expect(drive.save).toHaveBeenCalledTimes(1);
    expect(peak.attach).toHaveBeenCalledTimes(1);
    expect(peak.attach.mock.calls[0][0]).toMatchObject({ transactionId: "peak-doc-42", transactionCode: "EXP-TEST-0042", fileType: "image" });
  });
});

describe("POST /api/pay/peak-document — nothing is paid unless PEAK succeeds", () => {
  it("releases the jobs, unpaid, when PEAK refuses", async () => {
    peak.create.mockResolvedValue({ ok: false, desc: "Invalid accountCode" });
    const res = await payForm([J1, J2, J3]);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("peak-refused");
    for (const j of [J1, J2, J3]) expect(payOf(j)).toMatchObject({ status: "PENDING", peakPaymentRef: null, peakDocumentId: null });
    expect(db.docs[0]).toMatchObject({ status: "FAILED", error: "Invalid accountCode" });
    // Released means payable again.
    peak.create.mockResolvedValue({ ok: true, code: "EXP-TEST-0043", id: "peak-doc-43" });
    expect((await payForm([J1, J2, J3])).status).toBe(200);
  });

  it("keeps the jobs locked when PEAK may have created the document — a second press posts nothing", async () => {
    peak.create.mockResolvedValue({ ok: false, uncertain: true, desc: "PEAK did not respond within 30s" });
    const res = await payForm([J1, J2, J3]);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("peak-uncertain");
    for (const j of [J1, J2, J3]) expect(payOf(j)).toMatchObject({ status: "PENDING", peakPaymentRef: "FOLK-PAY-203005-01" });

    const again = await payForm([J1, J2, J3]);
    expect(again.status).toBe(409);
    expect((await again.json()).reasons.join(" ")).toContain("has not confirmed");
    expect(peak.create).toHaveBeenCalledTimes(1);
  });

  it("refuses a job whose sheet already posted its own PEAK document, before calling PEAK", async () => {
    db.sheets.find((s) => s.date === J3.date && s.slotIdx === J3.slotIdx)!.peakDocumentNo = "EXP-TEST-0001";
    const res = await payForm([J1, J2, J3]);
    expect(res.status).toBe(409);
    expect((await res.json()).reasons.join(" ")).toContain("EXP-TEST-0001");
    expect(drive.save).not.toHaveBeenCalled();
    expect(peak.create).not.toHaveBeenCalled();
    expect(db.docs).toHaveLength(0);
  });
});

describe("a billed expense with no Paid By stops the payment before PEAK", () => {
  const unset = () => {
    const j3 = db.sheets.find((s) => s.date === J3.date && s.slotIdx === J3.slotIdx)!;
    j3.expenses = [{ description: "Offering flowers", price: 95, pax: 1, expenseType: "other" }]; // Paid By missing
  };

  it("the preview refuses, naming the job sheet and row", async () => {
    unset();
    const res = await PREVIEW(new Request("https://ops.folkpaths.com/api/pay/peak-document/preview", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ guideId: GUIDE, paymentDate: "2030-05-13", jobs: [J1, J2, J3] }),
    }) as unknown as Parameters<typeof PREVIEW>[0]);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reasons.join(" ")).toContain('FOLK-BKK-20300512-01 row 1 "Offering flowers": Paid By is not set');
  });

  it("the real POST refuses with 409 — no slip upload, no PEAK document, no payment record, nothing paid", async () => {
    unset();
    const res = await payForm([J1, J2, J3]);
    expect(res.status).toBe(409);
    expect((await res.json()).reasons.join(" ")).toContain('FOLK-BKK-20300512-01 row 1 "Offering flowers": Paid By is not set');
    expect(drive.save).not.toHaveBeenCalled();
    expect(peak.create).not.toHaveBeenCalled();
    expect(peak.attach).not.toHaveBeenCalled();
    expect(db.docs).toHaveLength(0);
    expect(db.pays.filter((p) => p.status === "PAID" || p.peakPaymentRef)).toHaveLength(0);
  });
});

describe("PATCH /api/pay/peak-document — settling an unconfirmed payment", () => {
  it("records a document found in PEAK and marks all its jobs paid", async () => {
    peak.create.mockResolvedValue({ ok: false, uncertain: true, desc: "timeout" });
    await payForm([J1, J2, J3]);
    db.docs[0].createdAt = new Date(Date.now() - 10 * 60_000); // past the in-flight window

    const res = await resolve({ paymentRef: "FOLK-PAY-203005-01", resolution: "found", documentNo: "EXP-TEST-0044" });
    expect(res.status).toBe(200);
    for (const j of [J1, J2, J3]) expect(payOf(j)).toMatchObject({ status: "PAID", peakRef: "EXP-TEST-0044", peakPaymentRef: "FOLK-PAY-203005-01" });
    expect(db.docs[0].status).toBe("POSTED");
  });

  it("will not resolve a payment that may still be in flight", async () => {
    peak.create.mockImplementation(() => new Promise(() => {})); // never answers
    void payForm([J1, J2, J3]);
    await vi.waitFor(() => expect(db.docs[0]?.status).toBe("POSTING"));
    const res = await resolve({ paymentRef: "FOLK-PAY-203005-01", resolution: "not-found" });
    expect(res.status).toBe(409);
  });
});
