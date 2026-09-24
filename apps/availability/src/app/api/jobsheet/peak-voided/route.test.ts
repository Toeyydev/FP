import { vi, describe, it, expect, beforeEach } from "vitest";

// All data here is invented (fictional refs, ids and document numbers) — this repo is public.

type Row = Record<string, any>;
const db = vi.hoisted(() => ({ sheet: null as Row | null, audits: [] as Row[] }));
const prismaMock = vi.hoisted(() => {
  const client: Row = {
    jobSheet: {
      findUnique: vi.fn(async () => (db.sheet ? { ...db.sheet } : null)),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const s = db.sheet;
        const hit = !!s && s.id === where.id && (s.peakDocumentNo ?? null) === (where.peakDocumentNo ?? null) && (s.peakDocumentId ?? null) === (where.peakDocumentId ?? null);
        if (hit) Object.assign(s!, data);
        return { count: hit ? 1 : 0 };
      }),
    },
    auditLog: { create: vi.fn(async ({ data }: { data: Row }) => { db.audits.push({ ...data, createdAt: new Date() }); return data; }) },
  };
  client.$transaction = vi.fn(async (fn: (tx: Row) => unknown) => {
    // All or nothing, like the database: a throw inside restores the sheet and the log.
    const before = { sheet: db.sheet ? { ...db.sheet } : null, audits: [...db.audits] };
    try { return await fn(client); } catch (e) { db.sheet = before.sheet; db.audits = before.audits; throw e; }
  });
  return client;
});
const authMock = vi.hoisted(() => vi.fn());
const peakApi = vi.hoisted(() => ({ createExpenseAllInOne: vi.fn(), insertExpenseFile: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/roles", () => ({ isAdmin: (r?: string) => r === "ADMIN", isOps: (r?: string) => r === "OPERATOR" || r === "ADMIN" }));
vi.mock("@/lib/peak-api", () => peakApi);

import { POST } from "./route";
import { combinedPaymentBlock } from "@/lib/combined-payment";
import { peakSyncEligibility } from "@/lib/peak-sync";

const post = (body: unknown) => POST(new Request("https://ops.folkpaths.com/api/jobsheet/peak-voided", {
  method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
}) as unknown as Parameters<typeof POST>[0]);

const JOB = { guideId: "G-TEST", date: "2030-08-28", slotIdx: 2 };
const VOID = { ...JOB, documentNo: "EXP-TEST-0026", confirmVoidedInPeak: true };
const SYNCED_AT = new Date("2030-09-14T11:12:33Z");
const EXPENSES = [{ description: "Water (Inc. Guide)", price: 10, pax: 4, expenseType: "meal", paidBy: "guide" }];

const seed = (over: Row = {}) => {
  db.sheet = {
    id: "js_test_1", ref: "FOLK-BKK-20300828-02", guideId: JOB.guideId, date: JOB.date, slotIdx: JOB.slotIdx,
    expenses: EXPENSES, guideFee: { price: 1500, time: 1, whtPct: 3 }, bookings: [{ name: "Guest A", bookingNo: "GYGTEST1", bookedPax: 2 }],
    approvalStatus: "APPROVED", status: "Confirmed", origin: "NORMAL", accountingDate: "2030-08-28", documentDate: "2030-08-28",
    peakSyncStatus: "SYNCED", peakDocumentNo: "EXP-TEST-0026", peakDocumentId: "peak-doc-26", syncedAt: SYNCED_AT, syncError: null, lastPayloadHash: "hash-at-sync",
    ...over,
  };
  db.audits = [];
};

beforeEach(() => {
  vi.clearAllMocks();
  seed();
  authMock.mockResolvedValue({ user: { id: "admin_1", role: "ADMIN" } });
});

describe("POST /api/jobsheet/peak-voided — who may", () => {
  it.each([["GUIDE"], ["ACCOUNTANT"], ["VIEWER"]])("refuses %s with 403 and changes nothing", async (role) => {
    authMock.mockResolvedValue({ user: { id: "u_1", role } });
    const before = { ...db.sheet };
    expect((await post(VOID)).status).toBe(403);
    expect(db.sheet).toEqual(before);
    expect(db.audits).toHaveLength(0);
  });

  it("refuses a request with no session", async () => {
    authMock.mockResolvedValue(null);
    expect((await post(VOID)).status).toBe(403);
    expect(db.sheet!.peakDocumentNo).toBe("EXP-TEST-0026");
  });

  it("allows an operator as well as an admin", async () => {
    authMock.mockResolvedValue({ user: { id: "op_1", role: "OPERATOR" } });
    expect((await post(VOID)).status).toBe(200);
  });
});

describe("POST /api/jobsheet/peak-voided — the operator must say it twice", () => {
  it("needs the explicit confirmation", async () => {
    expect((await post({ ...VOID, confirmVoidedInPeak: undefined })).status).toBe(400);
    expect((await post({ ...VOID, confirmVoidedInPeak: false })).status).toBe(400);
    expect((await post({ ...VOID, confirmVoidedInPeak: "yes" })).status).toBe(400);
    expect(db.sheet!.peakDocumentNo).toBe("EXP-TEST-0026");
    expect(db.audits).toHaveLength(0);
  });

  it("needs the document number the sheet actually holds", async () => {
    const res = await post({ ...VOID, documentNo: "EXP-TEST-0027" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "document-mismatch" });
    expect(db.sheet!.peakDocumentNo).toBe("EXP-TEST-0026");
    expect(db.audits).toHaveLength(0);
  });

  it("404s for a sheet that does not exist", async () => {
    db.sheet = null;
    expect((await post(VOID)).status).toBe(404);
  });

  it("waits while a sync is in flight", async () => {
    seed({ peakSyncStatus: "SYNCING" });
    expect((await post(VOID)).status).toBe(409);
    expect(db.audits).toHaveLength(0);
  });
});

describe("POST /api/jobsheet/peak-voided — recording the void", () => {
  it("clears only the sheet's PEAK document fields", async () => {
    const before = { ...db.sheet };
    const res = await post(VOID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, previousDocumentNo: "EXP-TEST-0026" });
    expect(db.sheet).toMatchObject({ peakSyncStatus: "VOIDED", peakDocumentNo: null, peakDocumentId: null, syncedAt: null, syncError: null, lastPayloadHash: null });
    // Everything else on the sheet is exactly as it was.
    const untouched = ["id", "ref", "guideId", "date", "slotIdx", "expenses", "guideFee", "bookings", "approvalStatus", "status", "origin", "accountingDate", "documentDate"];
    for (const k of untouched) expect(db.sheet![k]).toEqual(before[k]);
    expect(Object.keys(prismaMock.jobSheet.updateMany.mock.calls[0][0].data).sort()).toEqual(["lastPayloadHash", "peakDocumentId", "peakDocumentNo", "peakSyncStatus", "syncError", "syncedAt"]);
  });

  it("keeps the old document traceable: one audit entry with the number, id, sync time, fingerprint, who and when", async () => {
    await post({ ...VOID, reason: "Voided in PEAK so the month can be paid as one document" });
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({
      actorId: "admin_1", actorRole: "ADMIN", action: "jobsheet.peak_voided", entityType: "JobSheet", entityId: "js_test_1",
      detail: {
        ref: "FOLK-BKK-20300828-02", guideId: "G-TEST", date: "2030-08-28", slotIdx: 2,
        status: "VOIDED_EXTERNALLY_IN_PEAK", confirmedVoidedInPeak: true,
        previousDocumentNo: "EXP-TEST-0026", previousDocumentId: "peak-doc-26", previousSyncStatus: "SYNCED",
        previousSyncedAt: SYNCED_AT.toISOString(), previousPayloadHash: "hash-at-sync",
        reason: "Voided in PEAK so the month can be paid as one document",
      },
    });
    expect(db.audits[0].createdAt).toBeInstanceOf(Date);
  });

  it("a repeated request is refused and writes nothing more", async () => {
    expect((await post(VOID)).status).toBe(200);
    const res = await post(VOID);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "not-in-peak" });
    expect(db.audits).toHaveLength(1);
    expect(db.sheet!.peakSyncStatus).toBe("VOIDED");
  });

  it("a sync landing between the read and the write leaves the new document and writes no audit", async () => {
    prismaMock.jobSheet.findUnique.mockImplementationOnce(async () => {
      const read = { ...db.sheet };
      Object.assign(db.sheet!, { peakDocumentNo: "EXP-TEST-0040", peakDocumentId: "peak-doc-40" }); // someone re-synced
      return read;
    });
    const res = await post(VOID);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "changed" });
    expect(db.sheet).toMatchObject({ peakDocumentNo: "EXP-TEST-0040", peakDocumentId: "peak-doc-40" });
    expect(db.audits).toHaveLength(0);
  });

  it("if the audit entry cannot be written, the document stays on the sheet", async () => {
    prismaMock.auditLog.create.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(post(VOID)).rejects.toThrow("database unavailable");
    expect(db.sheet).toMatchObject({ peakDocumentNo: "EXP-TEST-0026", peakDocumentId: "peak-doc-26", peakSyncStatus: "SYNCED" });
  });

  it("never calls PEAK", async () => {
    await post(VOID);
    expect(peakApi.createExpenseAllInOne).not.toHaveBeenCalled();
    expect(peakApi.insertExpenseFile).not.toHaveBeenCalled();
  });

  it("afterwards the job is eligible again under the normal rules — for a combined payment and for a sync", async () => {
    const blockedBefore = combinedPaymentBlock({ sheet: db.sheet, payment: null, coveredByPayroll: false, period: "2030-08" });
    expect(blockedBefore?.code).toBe("in-peak-from-sheet");
    await post(VOID);
    expect(combinedPaymentBlock({ sheet: db.sheet, payment: null, coveredByPayroll: false, period: "2030-08" })).toBeNull();
    // Still subject to the rules: unapproved would block it again.
    expect(combinedPaymentBlock({ sheet: { ...db.sheet, approvalStatus: null }, payment: null, coveredByPayroll: false, period: "2030-08" })?.code).toBe("not-approved");
    const state = { peakSyncStatus: db.sheet!.peakSyncStatus, peakDocumentId: db.sheet!.peakDocumentId, peakDocumentNo: db.sheet!.peakDocumentNo, syncedAt: db.sheet!.syncedAt, syncError: db.sheet!.syncError, lastPayloadHash: db.sheet!.lastPayloadHash };
    const el = peakSyncEligibility({
      expenses: EXPENSES as never, guideFee: db.sheet!.guideFee, approved: true, peakContactId: "contact-test", accountingDate: "2030-08-28",
      origin: "NORMAL", accounts: { meal: { code: "510104" } } as never, jobRef: db.sheet!.ref, bookings: [], state,
    });
    expect(el).toMatchObject({ status: "READY", canSync: true });
  });
});
