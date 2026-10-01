import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// Advance settlement, Phase 1D, against a real database: the ACCOUNTANT's least-privilege view
// of advance refunds (owner policy 2026-10-01). They read a refund-review packet with every
// piece of evidence needed to approve, and may approve — nothing else. Operator routes and the
// operational job sheet stay closed to them. All data invented — this repo is public.

const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in this test"); }));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import { allocateReceipt, recordReceipt, recordRefund, verifyReceipt } from "@/lib/advances/service";
import { refundReviews } from "@/lib/advances/refund-review";
import { GET as LIST_REFUNDS } from "@/app/api/advances/refunds/route";
import { POST as APPROVE_REFUND } from "@/app/api/advances/refunds/[id]/approve/route";
import { POST as ISSUE_ADVANCE } from "@/app/api/advances/route";
import { POST as JOB_ADVANCE } from "@/app/api/jobsheet/advance/route";
import { PUT as SAVE_SHEET } from "@/app/api/jobsheet/route";
import { POST as CATEGORIES } from "@/app/api/advances/[id]/categories/route";
import { POST as LINK_RETURN } from "@/app/api/advances/returns/[id]/link/route";
import { POST as REJECT_RETURN } from "@/app/api/advances/returns/[id]/reject/route";

const G = "G-917", DATE = "2099-11-01";
let admin = { actorId: "", actorRole: "ADMIN" };
let acctId = "";

const as = (role: string, id: string, guideId?: string) => authMock.auth.mockResolvedValue({ user: { id, role, ...(guideId ? { guideId } : {}) } });
const post = (body: unknown) => new NextRequest("http://test.local/x", { method: "POST", body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

/** An advance of ฿1,000 on the job, ฿600 used; the guide sent ฿600 back; ฿400 allocated, ฿200 excess; a ฿200 refund recorded by the admin. */
async function scenario() {
  const sheet = await prisma.jobSheet.create({ data: { ref: "FOLK-TEST-ACC-01", guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", approvalStatus: "APPROVED",
    bookings: [{ name: "Guest Example Person", bookingNo: "GYGEXAMPLE7", bookedPax: 2 }] as never, expenses: [], guideFee: { price: 1000, time: 1, whtPct: 3 }, operatorNote: "operational note (example)" } });
  const adv = await prisma.guideAdvance.create({ data: { guideId: G, date: DATE, slotIdx: 0, amount: 1000, paidAt: new Date("2099-10-31T03:00:00Z"), method: "bank", txRef: "TX-EX-ACC",
    advanceNo: "FOLK-ADV-209911-001", advanceDate: "2099-10-31", amountSatang: 100_000, settledSatang: 60_000, accountingPeriod: "2099-10", slipUrl: "https://example.test/advance-slip", allowedCategories: ["entrance"] } });
  await prisma.guideAdvanceEntry.create({ data: { advanceId: adv.id, type: "EXPENSE_SETTLEMENT", amountSatang: 60_000, idempotencyKey: "acc-settle-example", requestKey: "acc-settle-example", effectiveDate: DATE, accountingPeriod: "2099-11", sourceType: "JOB_SHEET", sourceId: sheet.id, jobNo: sheet.ref } });
  const r = await recordReceipt(prisma, { guideId: G, receivedDate: "2099-11-02", amount: 600, byGuide: true, today: "2099-12-31", bankRef: null, note: null, advanceId: adv.id, jobSheetId: null, actor: { actorId: null, actorRole: "GUIDE" } });
  if (!r.ok) throw new Error(r.reasons.join(";"));
  await prisma.guideAdvanceReceipt.update({ where: { id: r.receipt.id }, data: { slipUrl: "https://example.test/return-slip" } });
  expect((await verifyReceipt(prisma, { receiptId: r.receipt.id, bankRef: "BANK-EX-ACC", actor: admin })).ok).toBe(true);
  expect((await allocateReceipt(prisma, { receiptId: r.receipt.id, allocations: [{ advanceId: adv.id, amount: 400 }], requestKey: "acc-alloc-example", actor: admin })).ok).toBe(true);
  const f = await recordRefund(prisma, { receiptId: r.receipt.id, amount: 200, reason: "guide sent too much (example)", actor: admin });
  if (!f.ok) throw new Error(f.reasons.join(";"));
  return { sheet, adv, receiptId: r.receipt.id, refundId: f.refund.id };
}

beforeAll(() => { requireTestDatabase(); });
beforeEach(async () => {
  vi.clearAllMocks();
  delete process.env.ADVANCE_WRITES_FROZEN;
  await resetDatabase();
  await seedGuide(G);
  const a = await prisma.user.create({ data: { email: "admin-acc@example.test", displayName: "Admin Example", role: "ADMIN", state: "ACTIVE" } });
  const c = await prisma.user.create({ data: { email: "acct-acc@example.test", displayName: "Accountant Example", role: "ACCOUNTANT", state: "ACTIVE" } });
  admin = { actorId: a.id, actorRole: "ADMIN" }; acctId = c.id;
});

describe("the accountant's refund review", () => {
  it("1–2 · the packet carries the evidence to approve — and no guest, expense or operational data", async () => {
    const { refundId } = await scenario();
    as("ACCOUNTANT", acctId);
    const res = await LIST_REFUNDS(new NextRequest("http://test.local/api/advances/refunds"));
    expect(res.status).toBe(200);
    const { refunds } = await res.json();
    expect(refunds).toHaveLength(1);
    const f = refunds[0];
    expect(f).toMatchObject({
      id: refundId, status: "RECORDED", amount: 200, reason: "guide sent too much (example)", recordedBy: "Admin Example",
      guide: { guideId: G }, job: { ref: "FOLK-TEST-ACC-01", date: DATE },
      receipt: { status: "VERIFIED", amount: 600, allocated: 400, refunded: 0, unallocated: 200, bankRef: "BANK-EX-ACC", slipUrl: "https://example.test/return-slip" },
    });
    expect(f.advances).toEqual([expect.objectContaining({ advanceNo: "FOLK-ADV-209911-001", issued: 1000, used: 600, returned: 400, outstanding: 0, status: "SETTLED", allocatedFromThisReturn: 400, slipUrl: "https://example.test/advance-slip" })]);
    expect(f.history).toEqual([expect.objectContaining({ action: "Recorded", by: "Admin Example", role: "ADMIN" })]);
    expect(f.receipt).toHaveProperty("peak");
    const text = JSON.stringify(refunds);
    for (const leak of ["Guest Example Person", "GYGEXAMPLE7", "operational note", "expenses", "bookings"]) expect(text).not.toContain(leak);
  });
  it("3 · the accountant approves; the history then names them", async () => {
    const { refundId } = await scenario();
    as("ACCOUNTANT", acctId);
    expect((await APPROVE_REFUND(post({}), ctx(refundId))).status).toBe(200);
    const [f] = await refundReviews(prisma);
    expect(f).toMatchObject({ status: "APPROVED", approvedBy: "Accountant Example" });
    expect(f.history.map((h) => [h.action, h.role])).toEqual([["Recorded", "ADMIN"], ["Approved", "ACCOUNTANT"]]);
  });
  it("the review list: finance roles only — a guide gets 403", async () => {
    await scenario();
    as("GUIDE", "guide-user", G);
    expect((await LIST_REFUNDS(new NextRequest("http://test.local/api/advances/refunds"))).status).toBe(403);
    as("OPERATOR", admin.actorId);
    expect((await LIST_REFUNDS(new NextRequest("http://test.local/api/advances/refunds"))).status).toBe(200);
  });
  it("4, 7 · the accountant cannot save the job sheet, record or edit an advance, link or reject a return (403)", async () => {
    const { adv, receiptId } = await scenario();
    as("ACCOUNTANT", acctId);
    const save = await SAVE_SHEET(new NextRequest("http://test.local/x", { method: "PUT", body: JSON.stringify({ guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [], expenses: [], guideFee: { price: 1, time: 1, whtPct: 3 } }) }));
    expect(save.status).toBe(403);
    expect((await ISSUE_ADVANCE(post({ guideId: G, advanceDate: "2099-10-31", amount: 100, bankRef: "TX-ACC-TRY", date: DATE, slotIdx: 0 }))).status).toBe(403);
    const fd = new FormData();
    for (const [k, v] of Object.entries({ kind: "advance", guideId: G, date: DATE, slotIdx: "0", amount: "100", method: "bank", txRef: "TX-ACC-TRY" })) fd.append(k, v);
    fd.append("file", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "slip.png");
    expect((await JOB_ADVANCE(new NextRequest("http://test.local/x", { method: "POST", body: fd }))).status).toBe(403);
    expect((await CATEGORIES(post({ allowedCategories: ["entrance", "meal"] }), ctx(adv.id))).status).toBe(403);
    expect((await LINK_RETURN(post({ advanceId: adv.id }), ctx(receiptId))).status).toBe(403);
    expect((await REJECT_RETURN(post({ reason: "accountant try (example)" }), ctx(receiptId))).status).toBe(403);
    expect(await prisma.guideAdvance.count()).toBe(1);
  });
});
