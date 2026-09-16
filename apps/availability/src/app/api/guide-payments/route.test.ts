import { vi, describe, it, expect, beforeEach } from "vitest";
import { memoryDb } from "@/lib/payments-v2/testing/memory-db";

// Record payment over HTTP: the reconciliation, the refusals, and what reaches the guide.
// Fictional data — this repo is public.
const mem = vi.hoisted(() => ({ current: null as ReturnType<typeof import("@/lib/payments-v2/testing/memory-db").memoryDb> | null }));
const noticeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ get prisma() { return mem.current!.db; } }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "op_1", role: "OPERATOR" } })) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/jobsheet-send", () => ({ sendPaymentNotice: noticeMock }));
vi.mock("@/lib/google-drive", () => ({ googleDriveEnabled: true, folkpathsDriveToken: vi.fn(async () => "rt"), saveBufferToDrive: vi.fn(async () => ({ id: "file_1", link: "https://drive.test/slip" })) }));

import { NextRequest } from "next/server";
import { GET, POST } from "./route";
import { POST as PREVIEW } from "./preview/route";

const G = "G-TEST";
const JOB = { jobNo: "FOLK-BKK-20260702-02", date: "2026-07-02", slotIdx: 2 };
const sheet = {
  guideId: G, date: JOB.date, slotIdx: JOB.slotIdx, ref: JOB.jobNo, tourId: "T-TEST", approvalStatus: "APPROVED", accountingDate: null,
  expenses: [{ description: "Water", price: 10, pax: 7, paidBy: "guide" }, { description: "Bus", price: 13, pax: 7, paidBy: "guide" }],
  guideFee: { price: 1500, time: 1, whtPct: 3 }, createdAt: new Date("2026-07-01T00:00:00Z"), peakDocumentNo: null, peakDocumentId: null, peakSyncStatus: null,
};
const body = (over: object = {}) => ({ guideId: G, jobs: [JOB], paymentDate: "2026-07-20", amountTransferred: 1616, noSlipReason: "Cash paid in person, slip to follow", ...over });
const post = (payload: object, file?: Blob) => {
  const fd = new FormData();
  fd.append("payload", JSON.stringify(payload));
  if (file) fd.append("file", file, "slip.jpg");
  return POST(new NextRequest("https://ops.folkpaths.com/api/guide-payments", { method: "POST", body: fd }));
};
const preview = (payload: object) => PREVIEW(new NextRequest("https://ops.folkpaths.com/api/guide-payments/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }));

beforeEach(() => { vi.clearAllMocks(); mem.current = memoryDb({ jobSheet: [sheet], user: [{ guideId: G, displayName: "Guide T", fullName: null }] }); });

describe("POST /api/guide-payments", () => {
  it("records the transfer, pays the job and tells the guide once", async () => {
    const res = await post(body());
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.payment.paymentNo).toBe("FOLK-PMT-202607-001");
    expect(d.reconciliation).toMatchObject({ jobTotal: 1616, amountTransferred: 1616, balanced: true });
    expect(mem.current!.tables.tourPayment[0]).toMatchObject({ status: "PAID", guidePaymentId: mem.current!.tables.guidePayment[0].id });
    expect(noticeMock).toHaveBeenCalledTimes(1);
  });

  it("files the slip in Drive as evidence of that transfer", async () => {
    const res = await post(body({ noSlipReason: null }), new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }));
    expect(res.status).toBe(200);
    expect(mem.current!.tables.guidePayment[0]).toMatchObject({ slipUrl: "https://drive.test/slip", evidenceId: mem.current!.tables.paymentEvidence[0].id });
    expect(mem.current!.tables.paymentEvidence[0]).toMatchObject({ guideId: G, googleDriveFileId: "file_1" });
  });

  it("refuses a transfer that does not reconcile, and writes nothing", async () => {
    const res = await post(body({ amountTransferred: 1500 }));
    expect(res.status).toBe(409);
    const d = await res.json();
    expect(d.error).toBe("not-recordable");
    expect(d.reasons.join(" ")).toContain("but 1500.00 was transferred");
    expect(mem.current!.tables.guidePayment).toHaveLength(0);
    expect(noticeMock).not.toHaveBeenCalled();
  });

  it("refuses a short job reference and a payment with no evidence or reason", async () => {
    const short = await (await post(body({ jobs: [{ ...JOB, jobNo: "0702-02" }] }))).json();
    expect(short.reasons.join(" ")).toContain("full Job No.");
    const noEvidence = await (await post(body({ noSlipReason: null }))).json();
    expect(noEvidence.reasons.join(" ")).toContain("Attach the bank slip");
    expect(mem.current!.tables.guidePayment).toHaveLength(0);
  });

  it("an adjustment reconciles the difference: 1,616 − 70 = 1,546", async () => {
    const res = await post(body({ amountTransferred: 1546, adjustments: [{ type: "ADVANCE_SETTLEMENT", amount: -70, description: "Unspent advance" }] }));
    expect(res.status).toBe(200);
    expect(mem.current!.tables.guidePayment[0]).toMatchObject({ jobTotal: 1616, adjustmentTotal: -70, amountTransferred: 1546 });
    expect(mem.current!.tables.guidePaymentAdjustment[0]).toMatchObject({ type: "ADVANCE_SETTLEMENT", amount: -70 });
  });
});

describe("POST /api/guide-payments/preview", () => {
  it("returns the reconciliation and the refusals without writing", async () => {
    const res = await preview(body({ amountTransferred: 1500 }));
    const d = await res.json();
    expect(d.ok).toBe(false);
    expect(d.reconciliation).toMatchObject({ jobTotal: 1616, amountTransferred: 1500, balanced: false });
    expect(mem.current!.tables.guidePayment).toHaveLength(0);
  });
});

describe("GET /api/guide-payments", () => {
  it("lists what was recorded for that guide and month", async () => {
    await post(body());
    const res = await GET(new NextRequest(`https://ops.folkpaths.com/api/guide-payments?guideId=${G}&period=2026-07`));
    const d = await res.json();
    expect(d.payments).toHaveLength(1);
    expect(d.payments[0]).toMatchObject({ paymentNo: "FOLK-PMT-202607-001", status: "RECORDED", amountTransferred: 1616 });
    expect(d.payments[0].jobs[0]).toMatchObject({ jobNo: JOB.jobNo, payable: 1616 });
  });
});
