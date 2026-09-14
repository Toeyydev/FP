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
  users: [] as Row[], sheets: [] as Row[], assigns: [] as Row[], pays: [] as Row[], payrolls: [] as Row[], docs: [] as Row[], tours: [] as Row[],
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
    tour: table(() => db.tours),
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
vi.mock("@/lib/roles", () => ({ isOps: (r?: string) => r === "OPERATOR" || r === "ADMIN", canViewFinance: (r?: string) => ["OPERATOR", "ADMIN", "ACCOUNTANT"].includes(r ?? "") }));
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
import { GET as PAYMENTS } from "../../payments/route";
import { NextRequest } from "next/server";

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
  db.tours = [{ id: "T-001", name: "Test Temple Tour" }];
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
    db.sheets.push({ guideId: GUIDE, ...J4, tourId: "T-001", ref: "FOLK-BKK-20300521-01", expenses: [], guideFee: FEE(1200), origin: "NORMAL", createdAt: new Date("2030-05-01"), peakDocumentNo: null, peakDocumentId: null });
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

  it("the post refuses the same set before any write — no slip, no PEAK call, no payment record", async () => {
    const res = await payForm([J1, J2, J3, J4, OTHER], { paymentDate: "2030-05-28" });
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
      const res = await payForm([J2, J4], { paymentDate: "2030-05-28" });
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
