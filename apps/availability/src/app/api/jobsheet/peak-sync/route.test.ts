import { vi, describe, it, expect, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  jobSheet: { findUnique: vi.fn(), update: vi.fn() },
  user: { findFirst: vi.fn() },
}));
const authMock = vi.hoisted(() => vi.fn());
const createExpenseMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/roles", () => ({ isOps: (r?: string) => r === "OPERATOR" || r === "ADMIN" }));
vi.mock("@/lib/peak-api", () => ({
  createExpenseAllInOne: createExpenseMock,
  peakEnabled: true,
  sanitizePeakError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
// The account chart the operator configured. Mocked at the DB seam only — the
// readiness rules and the payload builder are the REAL pure ones, so these tests
// exercise the gate that actually runs in production.
vi.mock("@/lib/peak-account-map", () => ({
  peakAccountMap: async () => ({ entrance: { code: "510104" }, transport: { code: "510104" }, meal: { code: "510104" } }),
  guideFeeAccount: async () => ({ code: "510111" }),
}));

import { POST } from "./route";
import { peakPayloadHash } from "@/lib/peak-sync";
import { audit } from "@/lib/audit";

const post = (body: unknown) => POST(new Request("https://ops.folkpaths.com/api/jobsheet/peak-sync", {
  method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
}) as unknown as Parameters<typeof POST>[0]);

const JOB = { guideId: "G-007", date: "2026-09-12", slotIdx: 0 };

const sheet = (over: Record<string, unknown> = {}) => ({
  id: "js_1", ref: "FOLK-BKK-20260912-01", origin: "NORMAL",
  expenses: [
    { description: "Grand Palace", price: 500, pax: 2, expenseType: "entrance", paidBy: "guide" },
    { description: "Ferry (Inc. Guide)", price: 30, pax: 3, expenseType: "transport", paidBy: "guide" },
  ],
  guideFee: { price: 1200, time: 1, whtPct: 3 },
  approvalStatus: "APPROVED",
  bookings: [],
  accountingDate: null, documentDate: null,
  peakSyncStatus: null, peakDocumentId: null, peakDocumentNo: null,
  syncedAt: null, syncError: null, lastPayloadHash: null,
  ...over,
});

/** The data of the update call that set a given status. */
const updateWith = (status: string) =>
  prismaMock.jobSheet.update.mock.calls.map((c) => c[0].data).find((d) => d.peakSyncStatus === status);

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "op_1", role: "OPERATOR" } });
  prismaMock.jobSheet.findUnique.mockResolvedValue(sheet());
  prismaMock.jobSheet.update.mockResolvedValue({});
  prismaMock.user.findFirst.mockResolvedValue({ peakContactId: "ct-778" });
  createExpenseMock.mockResolvedValue({ ok: true, code: "EXP-20260900007", id: "peak-doc-1" });
});

describe("POST /api/jobsheet/peak-sync — refusals", () => {
  it("is operators only", async () => {
    authMock.mockResolvedValue({ user: { id: "g_1", role: "GUIDE" } });
    expect((await post(JOB)).status).toBe(403);
    expect(createExpenseMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed body", async () => {
    expect((await post({ guideId: "G-007", date: "12/09/2026", slotIdx: 0 })).status).toBe(400);
    expect((await post({ guideId: "", date: "2026-09-12", slotIdx: 0 })).status).toBe(400);
    expect(createExpenseMock).not.toHaveBeenCalled();
  });

  it("404s for a sheet that was never saved", async () => {
    prismaMock.jobSheet.findUnique.mockResolvedValue(null);
    expect((await post(JOB)).status).toBe(404);
    expect(createExpenseMock).not.toHaveBeenCalled();
  });

  it("refuses an unapproved sheet and names the reason", async () => {
    prismaMock.jobSheet.findUnique.mockResolvedValue(sheet({ approvalStatus: null }));
    const res = await post(JOB);
    expect(res.status).toBe(409);
    expect((await res.json()).reasons).toContain("Job sheet is not approved");
    expect(createExpenseMock).not.toHaveBeenCalled();
  });

  it("refuses a guide with no PEAK contact — never posts under a name", async () => {
    prismaMock.user.findFirst.mockResolvedValue({ peakContactId: null });
    const res = await post(JOB);
    expect(res.status).toBe(409);
    expect((await res.json()).reasons).toContain("Guide is not mapped to a PEAK Contact");
    expect(createExpenseMock).not.toHaveBeenCalled();
  });

  // The fingerprint of a sheet in its posted state: same expenses, fee, date,
  // contact and accounts the endpoint will hash.
  const postedHash = () => peakPayloadHash({
    expenses: sheet().expenses as never, guideFee: sheet().guideFee as never,
    accountingDate: "2026-09-12", peakContactId: "ct-778",
    accounts: { entrance: { code: "510104" }, transport: { code: "510104" }, meal: { code: "510104" } },
  });

  it("refuses an unchanged sheet that already has a document — no second document", async () => {
    prismaMock.jobSheet.findUnique.mockResolvedValue(sheet({
      peakDocumentId: "peak-doc-1", peakSyncStatus: "SYNCED", lastPayloadHash: postedHash(),
    }));
    expect((await post(JOB)).status).toBe(409);
    expect(createExpenseMock).not.toHaveBeenCalled();
  });

  it("refuses to re-post a CHANGED sheet without an explicit confirmation", async () => {
    // PEAK cannot amend the first document, so an automatic re-post would leave two
    // documents for one job — the operator has to say so out loud.
    prismaMock.jobSheet.findUnique.mockResolvedValue(sheet({
      peakDocumentId: "peak-doc-1", peakDocumentNo: "EXP-1", peakSyncStatus: "SYNCED",
      lastPayloadHash: "a-hash-from-before-the-edit",
    }));
    const res = await post(JOB);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "changed-since-sync", documentNo: "EXP-1" });
    expect(createExpenseMock).not.toHaveBeenCalled();
  });

  it("posts a changed sheet once the operator confirms", async () => {
    prismaMock.jobSheet.findUnique.mockResolvedValue(sheet({
      peakDocumentId: "peak-doc-1", peakSyncStatus: "SYNCED", lastPayloadHash: "a-hash-from-before-the-edit",
    }));
    expect((await post({ ...JOB, confirmRepost: true })).status).toBe(200);
    expect(createExpenseMock).toHaveBeenCalledTimes(1);
  });

  it("refuses while another sync is in flight", async () => {
    prismaMock.jobSheet.findUnique.mockResolvedValue(sheet({ peakSyncStatus: "SYNCING" }));
    const res = await post(JOB);
    expect(res.status).toBe(409);
    expect((await res.json()).reasons).toContain("A sync is already in progress");
    expect(createExpenseMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/jobsheet/peak-sync — posting", () => {
  it("posts one line per expense row plus the guide fee, each on its own account", async () => {
    await post(JOB);
    const sent = createExpenseMock.mock.calls[0][0] as { products: { description: string; accountCode: string; price: number; withHoldingTaxAmount: number }[] };
    expect(sent.products.map((p) => [p.description, p.accountCode, p.price])).toEqual([
      ["Guide Fee — FOLK-BKK-20260912-01", "510111", 1200],
      ["Grand Palace", "510104", 1000],
      ["Ferry (Inc. Guide)", "510104", 90],
    ]);
    // Withholding tax belongs to the fee line alone.
    expect(sent.products[0].withHoldingTaxAmount).toBe(36);
    expect(sent.products.slice(1).every((p) => p.withHoldingTaxAmount === 0)).toBe(true);
  });

  it("never tells PEAK the expense was paid — the transfer has not happened yet", async () => {
    await post(JOB);
    expect(createExpenseMock.mock.calls[0][0]).not.toHaveProperty("paidPayments");
  });

  it("sends the contact id alone, so PEAK cannot fork the guide into a new supplier", async () => {
    await post(JOB);
    expect((createExpenseMock.mock.calls[0][0] as { contact: unknown }).contact).toEqual({ id: "ct-778" });
  });

  it("claims the sheet as SYNCING before the network call", async () => {
    const order: string[] = [];
    prismaMock.jobSheet.update.mockImplementation(async (a: { data: { peakSyncStatus?: string } }) => {
      order.push(`update:${a.data.peakSyncStatus}`); return {};
    });
    createExpenseMock.mockImplementation(async () => { order.push("post"); return { ok: true, code: "EXP-1", id: "d1" }; });
    await post(JOB);
    expect(order).toEqual(["update:SYNCING", "post", "update:SYNCED"]);
  });

  it("records the document number and a fingerprint of what was posted", async () => {
    const res = await post(JOB);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, documentNo: "EXP-20260900007", lines: 3 });
    const synced = updateWith("SYNCED")!;
    expect(synced.peakDocumentNo).toBe("EXP-20260900007");
    expect(synced.peakDocumentId).toBe("peak-doc-1");
    expect(synced.syncError).toBeNull();
    expect(typeof synced.lastPayloadHash).toBe("string");
    expect(synced.lastPayloadHash).not.toBe("");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "jobsheet.peak_synced" }));
  });
});

describe("POST /api/jobsheet/peak-sync — failures are never silent", () => {
  it("treats ok-without-a-document-number as a failure and records why", async () => {
    createExpenseMock.mockResolvedValue({ ok: true, code: "   " });
    const res = await post(JOB);
    expect(res.status).toBe(502);
    const failed = updateWith("FAILED")!;
    expect(failed.syncError).toBeTruthy();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "jobsheet.peak_sync_failed" }));
  });

  it("records PEAK's own refusal verbatim", async () => {
    createExpenseMock.mockResolvedValue({ ok: false, desc: "Invalid API Validate Data. (TimeStamp)" });
    const res = await post(JOB);
    expect(res.status).toBe(502);
    expect((await res.json()).reason).toBe("Invalid API Validate Data. (TimeStamp)");
    expect(updateWith("FAILED")!.syncError).toBe("Invalid API Validate Data. (TimeStamp)");
  });

  it("does not leave the sheet stuck on SYNCING when the call throws", async () => {
    createExpenseMock.mockRejectedValue(new Error("socket hang up"));
    const res = await post(JOB);
    expect(res.status).toBe(502);
    expect(updateWith("FAILED")!.syncError).toBe("socket hang up");
    // SYNCING was claimed, then cleared — never the last word.
    const statuses = prismaMock.jobSheet.update.mock.calls.map((c) => c[0].data.peakSyncStatus);
    expect(statuses[statuses.length - 1]).toBe("FAILED");
  });
});
