import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// Advance settlement, Phase 1C, against a real database: returns (link, verify, allocate,
// void), over-returns, the two-step refund (RECORDED → APPROVED → PAID, or VOIDED), PEAK
// safety and job-scoped visibility. Services and routes are the real ones. No network: any
// outbound fetch fails the test. All data invented — this repo is public.

const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => authMock);
vi.mock("@/lib/push", async (orig) => ({ ...(await orig<typeof import("@/lib/push")>()), sendPushToUser: vi.fn(async () => 0) }));
vi.mock("@/lib/line", async (orig) => ({ ...(await orig<typeof import("@/lib/line")>()), lineEnabled: false, linePush: vi.fn(async () => true), linePushFlex: vi.fn(async () => true) }));
vi.mock("@/lib/email", async (orig) => ({ ...(await orig<typeof import("@/lib/email")>()), sendEmail: vi.fn(async () => true) }));
vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in this test"); }));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireTestDatabase, resetDatabase, seedGuide } from "@/test/db";
import {
  allocateReceipt, approveRefund, linkReceipt, payRefund, recordReceipt, recordRefund, rejectReceipt, reverseEntry, verifyReceipt, voidReceipt, voidRefund,
} from "@/lib/advances/service";
import { returnSummary } from "@/lib/advances/returns";
import { summariesFor } from "@/lib/advances/summaries";
import { jobAdvanceView } from "@/lib/advances/job-view";
import { POST as VERIFY } from "@/app/api/advances/returns/[id]/verify/route";
import { POST as ALLOCATE } from "@/app/api/advances/returns/[id]/allocate/route";
import { POST as VOID_RETURN } from "@/app/api/advances/returns/[id]/void/route";
import { POST as RECORD_REFUND } from "@/app/api/advances/returns/[id]/refunds/route";
import { POST as APPROVE_REFUND } from "@/app/api/advances/refunds/[id]/approve/route";
import { POST as PAY_REFUND } from "@/app/api/advances/refunds/[id]/pay/route";
import { POST as VOID_REFUND } from "@/app/api/advances/refunds/[id]/void/route";
import { POST as LINK_RETURN } from "@/app/api/advances/returns/[id]/link/route";
import { POST as SETTLE } from "@/app/api/advances/[id]/settle-expenses/route";
import { POST as REVERSE_ADVANCE } from "@/app/api/advances/[id]/reverse/route";

const G = "G-914", G2 = "G-915";
const DATE = "2099-08-01", DATE2 = "2099-08-02";
let opA = { actorId: "", actorRole: "OPERATOR" }, opB = { actorId: "", actorRole: "ADMIN" };
let seq = 0;

async function advance(over: Record<string, unknown> = {}) {
  seq++;
  return prisma.guideAdvance.create({ data: {
    guideId: G, date: DATE, slotIdx: 0, amount: 1000, paidAt: new Date("2099-07-31T03:00:00Z"), method: "bank", txRef: `TX-EX-${seq}`,
    advanceNo: `FOLK-ADV-209908-${String(seq).padStart(3, "0")}`, advanceDate: "2099-07-31", amountSatang: 100_000, accountingPeriod: "2099-07", ...over,
  } });
}
async function sheet(over: Record<string, unknown> = {}) {
  return prisma.jobSheet.create({ data: { ref: `FOLK-TEST-RET-${++seq}`, guideId: G, date: DATE, slotIdx: 0, tourId: "T-900", status: "Confirmed", bookings: [{ name: "Guest Example Person", bookingNo: "GYGEXAMPLE9", bookedPax: 2 }] as never, expenses: [], guideFee: { price: 1000, time: 1, whtPct: 3 }, ...over } });
}
/** A return claimed by the guide (CLAIMED), optionally for an advance / job. */
async function claim(amount: number, over: { advanceId?: string; jobSheetId?: string; guideId?: string; bankRef?: string } = {}) {
  const r = await recordReceipt(prisma, { guideId: over.guideId ?? G, receivedDate: "2099-08-03", amount, byGuide: true, today: "2099-12-31", bankRef: over.bankRef ?? null, note: "transfer from Guest Example Person (example)", advanceId: over.advanceId ?? null, jobSheetId: over.jobSheetId ?? null, actor: { actorId: null, actorRole: "GUIDE" } });
  if (!r.ok) throw new Error(r.reasons.join(";"));
  return r.receipt.id;
}
const verify = (id: string, bankRef = `BANK-EX-${++seq}`, actor = opA) => verifyReceipt(prisma, { receiptId: id, bankRef, actor });
const allocate = (id: string, advanceId: string, amount: number, key = `alloc-${++seq}-example`) => allocateReceipt(prisma, { receiptId: id, allocations: [{ advanceId, amount }], requestKey: key, actor: opA });
const summary = async (advanceId: string) => (await summariesFor(prisma, [await prisma.guideAdvance.findUniqueOrThrow({ where: { id: advanceId } })])).get(advanceId)!;
async function rsum(id: string) {
  const r = await prisma.guideAdvanceReceipt.findUniqueOrThrow({ where: { id } });
  return returnSummary(r, await prisma.guideAdvanceEntry.findMany({ where: { receiptId: id } }), await prisma.guideAdvanceRefund.findMany({ where: { receiptId: id } }));
}
const call = async (handler: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>, id: string, body: unknown, role: string, userId: string, guideId?: string) => {
  authMock.auth.mockResolvedValue({ user: { id: userId, role, ...(guideId ? { guideId } : {}) } });
  const r = await handler(new NextRequest("http://test.local/x", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
  return { status: r.status, body: await r.json() };
};

beforeAll(() => { requireTestDatabase(); });
beforeEach(async () => {
  vi.clearAllMocks();
  delete process.env.ADVANCE_WRITES_FROZEN;
  await resetDatabase();
  await seedGuide(G);
  await seedGuide(G2);
  const a = await prisma.user.create({ data: { email: "op-a@example.test", displayName: "Op A", role: "OPERATOR", state: "ACTIVE" } });
  const b = await prisma.user.create({ data: { email: "op-b@example.test", displayName: "Op B", role: "ADMIN", state: "ACTIVE" } });
  opA = { actorId: a.id, actorRole: "OPERATOR" }; opB = { actorId: b.id, actorRole: "ADMIN" };
});

describe("1–5 · linking and verifying a return", () => {
  it("4 · a claim names its advance and job as structured fields — not in the note — and nothing is allocated", async () => {
    const a = await advance(); const s = await sheet();
    const id = await claim(300, { advanceId: a.id });
    const r = await prisma.guideAdvanceReceipt.findUniqueOrThrow({ where: { id } });
    expect(r).toMatchObject({ status: "CLAIMED", advanceId: a.id, jobSheetId: s.id, allocatedSatang: 0, note: "transfer from Guest Example Person (example)" });
    expect(await prisma.guideAdvanceEntry.count()).toBe(0);
  });
  it("4 · a link to another guide's advance, a reversed advance, or a mismatched job is refused", async () => {
    const other = await advance({ guideId: G2 }), reversed = await advance({ slotIdx: 1, reversedAt: new Date() }), a = await advance();
    const s2 = await sheet({ date: DATE2 });
    await expect(claim(100, { advanceId: other.id })).rejects.toThrow(/belongs to another guide/);
    await expect(claim(100, { advanceId: reversed.id })).rejects.toThrow(/was reversed/);
    await expect(claim(100, { advanceId: a.id, jobSheetId: s2.id })).rejects.toThrow(/not the job/);
    const unlinked = await claim(100);
    expect(await linkReceipt(prisma, { receiptId: unlinked, advanceId: a.id, jobSheetId: null, actor: opA })).toEqual({ ok: true });
    expect((await prisma.guideAdvanceReceipt.findUniqueOrThrow({ where: { id: unlinked } })).advanceId).toBe(a.id);
  });
  it("1, 2 · CLAIMED → VERIFIED with a bank reference; invalid verifications are refused", async () => {
    const a = await advance();
    const id = await claim(300, { advanceId: a.id });
    expect((await verifyReceipt(prisma, { receiptId: id, bankRef: "", actor: opA })).ok).toBe(false);
    expect((await verifyReceipt(prisma, { receiptId: id, bankRef: "ab", actor: opA })).ok).toBe(false);
    expect(await verify(id, "BANK-EX-0001")).toEqual({ ok: true });
    expect((await prisma.guideAdvanceReceipt.findUniqueOrThrow({ where: { id } })).status).toBe("VERIFIED");
    expect((await verify(id, "BANK-EX-0002")).ok).toBe(false); // already verified
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "advance.return_verified" } });
    expect(audit.detail).toMatchObject({ amount: 300, advanceId: a.id, verifiedBy: opA.actorId, bankRef: "BANK-EX-0001" });
    // the same bank reference on another return of the guide
    const id2 = await claim(50);
    expect((await verify(id2, "BANK-EX-0001")).ok).toBe(false);
  });
  it("3 · a return cannot be allocated to another guide's advance", async () => {
    const other = await advance({ guideId: G2 });
    const id = await claim(300); await verify(id);
    const r = await allocate(id, other.id, 300);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join(" ")).toMatch(/another guide/);
  });
  it("5 · job-scoped visibility: another job of the same guide does not see this job's pending return", async () => {
    const a = await advance(), b = await advance({ date: DATE2 });
    const sa = await sheet(), sb = await sheet({ date: DATE2 });
    const forA = await claim(300, { advanceId: a.id });
    const vA = await jobAdvanceView(prisma, { guideId: G, date: DATE, slotIdx: 0, expenses: [] });
    const vB = await jobAdvanceView(prisma, { guideId: G, date: DATE2, slotIdx: 0, expenses: [] });
    expect(vA.returns.map((r) => r.id)).toEqual([forA]);
    expect(vB.returns).toEqual([]);
    void sa; void sb; void b;
  });
});

describe("6–14 · allocation and over-return", () => {
  it("6, 11 · a VERIFIED return allocates (partially), the advance's Returned updates, the receipt status stays VERIFIED", async () => {
    const a = await advance();
    const id = await claim(500, { advanceId: a.id }); await verify(id);
    expect((await allocate(id, a.id, 200)).ok).toBe(true);
    expect(await summary(a.id)).toMatchObject({ returned: 20_000, outstanding: 80_000 });
    expect(await rsum(id)).toMatchObject({ amount: 50_000, allocated: 20_000, unallocated: 30_000, status: "VERIFIED", ok: true });
  });
  it("7, 8 · CLAIMED, REJECTED and VOIDED returns cannot allocate", async () => {
    const a = await advance();
    const claimed = await claim(100);
    expect((await allocate(claimed, a.id, 100)).ok).toBe(false);
    const rejected = await claim(100); await rejectReceipt(prisma, { receiptId: rejected, reason: "never arrived (example)", actor: opA });
    expect((await allocate(rejected, a.id, 100)).ok).toBe(false);
    const voided = await claim(100); await voidReceipt(prisma, { receiptId: voided, reason: "entered twice (example)", actor: opA });
    expect((await allocate(voided, a.id, 100)).ok).toBe(false);
  });
  it("9, 10 · capped by the advance's outstanding and by the return's unallocated", async () => {
    const a = await advance({ amountSatang: 30_000, amount: 300 });
    const id = await claim(500); await verify(id);
    const over = await allocate(id, a.id, 400);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reasons.join(" ")).toMatch(/only 300 is outstanding/);
    const b = await advance({ slotIdx: 1, amountSatang: 100_000 });
    const small = await claim(100); await verify(small);
    const tooMuch = await allocate(small, b.id, 200);
    expect(tooMuch.ok).toBe(false);
  });
  it("12–14 · over-return: ฿500 against ฿300 owed → ฿300 allocated, ฿200 unallocated and visible; nothing carried; a second advance only by an explicit allocation", async () => {
    const a = await advance({ amountSatang: 30_000, amount: 300 });
    const b = await advance({ slotIdx: 1 });
    const id = await claim(500, { advanceId: a.id }); await verify(id);
    expect((await allocate(id, a.id, 300)).ok).toBe(true);
    expect(await summary(a.id)).toMatchObject({ returned: 30_000, outstanding: 0, status: "SETTLED" });
    expect(await rsum(id)).toMatchObject({ amount: 50_000, allocated: 30_000, unallocated: 20_000, available: 20_000 });
    expect(await summary(b.id)).toMatchObject({ returned: 0 }); // never carried by itself
    expect((await allocate(id, b.id, 200)).ok).toBe(true);    // only when an operator says so
    expect(await summary(b.id)).toMatchObject({ returned: 20_000 });
    expect(await rsum(id)).toMatchObject({ unallocated: 0 });
  });
});

describe("15–23 · the refund of an over-return: RECORDED → APPROVED → PAID, or VOIDED", () => {
  async function overReturn() {
    const a = await advance({ amountSatang: 30_000, amount: 300 });
    const id = await claim(500, { advanceId: a.id }); await verify(id);
    await allocate(id, a.id, 300);
    return { a, id };
  }
  it("15–19, 16 · RECORDED (≤ what is free) → APPROVED by another person → PAID; only PAID reduces the balance; the advance's Returned is untouched", async () => {
    const { a, id } = await overReturn();
    expect((await recordRefund(prisma, { receiptId: id, amount: 250, reason: "guide sent too much (example)", actor: opA })).ok).toBe(false); // > 200 free
    const rec = await recordRefund(prisma, { receiptId: id, amount: 200, reason: "guide sent too much (example)", actor: opA });
    expect(rec.ok).toBe(true);
    const fid = rec.ok ? rec.refund.id : "";
    expect(await rsum(id)).toMatchObject({ unallocated: 20_000, refunded: 0, pendingRefunds: 20_000, available: 0 }); // RECORDED: no money moved
    expect((await approveRefund(prisma, { refundId: fid, actor: opA })).ok).toBe(false); // the recorder cannot approve
    expect(await approveRefund(prisma, { refundId: fid, actor: opB })).toEqual({ ok: true });
    expect(await rsum(id)).toMatchObject({ refunded: 0, unallocated: 20_000 }); // APPROVED: still no money moved
    expect((await payRefund(prisma, { refundId: fid, paidAt: "2026-09-30T04:00:00Z", bankRef: "", actor: opA })).ok).toBe(false);
    expect(await payRefund(prisma, { refundId: fid, paidAt: "2026-09-30T04:00:00Z", bankRef: "REFUND-EX-0001", actor: opA })).toEqual({ ok: true, replayed: false });
    expect(await rsum(id)).toMatchObject({ amount: 50_000, allocated: 30_000, refunded: 20_000, unallocated: 0, ok: true });
    expect((await prisma.guideAdvanceReceipt.findUniqueOrThrow({ where: { id } })).refundedSatang).toBe(20_000);
    expect(await summary(a.id)).toMatchObject({ returned: 30_000, outstanding: 0, status: "SETTLED" }); // §16
  });
  it("a refund can only be paid once approved; recording does not approve or pay", async () => {
    const { id } = await overReturn();
    const rec = await recordRefund(prisma, { receiptId: id, amount: 200, reason: "guide sent too much (example)", actor: opA });
    const fid = rec.ok ? rec.refund.id : "";
    expect((await prisma.guideAdvanceRefund.findUniqueOrThrow({ where: { id: fid } }))).toMatchObject({ status: "RECORDED", approvedById: null, paidAt: null });
    expect((await payRefund(prisma, { refundId: fid, paidAt: "2026-09-30T04:00:00Z", bankRef: "REFUND-EX-0002", actor: opB })).ok).toBe(false);
  });
  it("20 · the same bank reference cannot pay two refunds of a guide", async () => {
    const { id } = await overReturn();
    const one = await recordRefund(prisma, { receiptId: id, amount: 100, reason: "first half back (example)", actor: opA });
    const two = await recordRefund(prisma, { receiptId: id, amount: 100, reason: "second half back (example)", actor: opA });
    for (const f of [one, two]) if (f.ok) await approveRefund(prisma, { refundId: f.refund.id, actor: opB });
    expect((await payRefund(prisma, { refundId: one.ok ? one.refund.id : "", paidAt: "2026-09-30T04:00:00Z", bankRef: "REFUND-EX-SAME", actor: opA })).ok).toBe(true);
    const dup = await payRefund(prisma, { refundId: two.ok ? two.refund.id : "", paidAt: "2026-09-30T04:00:00Z", bankRef: "REFUND-EX-SAME", actor: opA });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.reasons[0]).toMatch(/already recorded/);
  });
  it("21–23 · void a RECORDED or APPROVED refund with a reason; a PAID refund is refused", async () => {
    const { id } = await overReturn();
    const r1 = await recordRefund(prisma, { receiptId: id, amount: 50, reason: "wrong amount (example)", actor: opA });
    expect(await voidRefund(prisma, { refundId: r1.ok ? r1.refund.id : "", reason: "recorded by mistake (example)", actor: opA })).toEqual({ ok: true });
    const r2 = await recordRefund(prisma, { receiptId: id, amount: 50, reason: "wrong amount (example)", actor: opA });
    await approveRefund(prisma, { refundId: r2.ok ? r2.refund.id : "", actor: opB });
    expect(await voidRefund(prisma, { refundId: r2.ok ? r2.refund.id : "", reason: "guide will collect cash (example)", actor: opA })).toEqual({ ok: true });
    const r3 = await recordRefund(prisma, { receiptId: id, amount: 200, reason: "guide sent too much (example)", actor: opA });
    const f3 = r3.ok ? r3.refund.id : "";
    await approveRefund(prisma, { refundId: f3, actor: opB });
    await payRefund(prisma, { refundId: f3, paidAt: "2026-09-30T04:00:00Z", bankRef: "REFUND-EX-0003", actor: opA });
    const v = await voidRefund(prisma, { refundId: f3, reason: "try to undo (example)", actor: opA });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reasons[0]).toMatch(/paid refund cannot be voided/);
    expect(await rsum(id)).toMatchObject({ refunded: 20_000, unallocated: 0 });
  });
});

describe("24–31 · voiding returns, PEAK safety, reversing an allocation", () => {
  it("24, 25 · a CLAIMED or VERIFIED-unallocated return voids with a reason", async () => {
    const c = await claim(100);
    expect((await voidReceipt(prisma, { receiptId: c, reason: "", actor: opA })).ok).toBe(false);
    expect(await voidReceipt(prisma, { receiptId: c, reason: "entered twice (example)", actor: opA })).toEqual({ ok: true });
    expect(await prisma.guideAdvanceReceipt.findUniqueOrThrow({ where: { id: c } })).toMatchObject({ status: "VOIDED", voidedById: opA.actorId, voidReason: "entered twice (example)" });
    const v = await claim(100); await verify(v);
    expect(await voidReceipt(prisma, { receiptId: v, reason: "wrong guide (example)", actor: opA })).toEqual({ ok: true });
  });
  it("26, 27 · an allocated return, or one with a refund, cannot be voided", async () => {
    const a = await advance({ amountSatang: 30_000, amount: 300 });
    const id = await claim(500); await verify(id); await allocate(id, a.id, 300);
    expect((await voidReceipt(prisma, { receiptId: id, reason: "try (example)", actor: opA })).ok).toBe(false);
    const id2 = await claim(100); await verify(id2);
    await recordRefund(prisma, { receiptId: id2, amount: 100, reason: "send it all back (example)", actor: opA });
    const r = await voidReceipt(prisma, { receiptId: id2, reason: "try (example)", actor: opA });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons[0]).toMatch(/refund/);
  });
  it("28 · voiding a verified return cancels its pending PEAK item in the same transaction", async () => {
    const id = await claim(100); await verify(id);
    expect((await prisma.advancePeakSync.findUniqueOrThrow({ where: { id: `RETURN:${id}` } })).status).toBe("PENDING"); // queued by the trigger
    expect(await voidReceipt(prisma, { receiptId: id, reason: "entered twice (example)", actor: opA })).toEqual({ ok: true });
    expect((await prisma.advancePeakSync.findUniqueOrThrow({ where: { id: `RETURN:${id}` } })).status).toBe("CANCELLED");
  });
  it("29 · sending, posted or hand-linked in PEAK → the void is refused with a 409, never a 500, nothing changed", async () => {
    for (const status of ["SENDING", "POSTED"]) {
      const id = await claim(100); await verify(id);
      await prisma.advancePeakSync.update({ where: { id: `RETURN:${id}` }, data: { status, documentNo: status === "POSTED" ? "JV-EX-0009" : null } });
      const r = await call(VOID_RETURN, id, { reason: "try (example)" }, "OPERATOR", opA.actorId);
      expect(r.status, status).toBe(409);
      expect(r.body.reasons[0], status).toMatch(/in PEAK/);
      expect((await prisma.guideAdvanceReceipt.findUniqueOrThrow({ where: { id } })).status).toBe("VERIFIED");
    }
    const id = await claim(100);
    await prisma.advancePeakDocumentLink.create({ data: { kind: "RETURN", sourceId: id, documentType: "DAILY_JOURNAL", documentNo: "JV-EX-0010", note: "entered by hand (example)" } as never });
    const r = await call(VOID_RETURN, id, { reason: "try (example)" }, "OPERATOR", opA.actorId);
    expect(r.status).toBe(409);
    expect(r.body.reasons[0]).toMatch(/JV-EX-0010/);
  });
  it("30 · reversing an allocation: contra entry, history kept, the return's unallocated and the advance's outstanding come back", async () => {
    const a = await advance();
    const id = await claim(300); await verify(id); await allocate(id, a.id, 300);
    const entry = await prisma.guideAdvanceEntry.findFirstOrThrow({ where: { type: "RETURN_ALLOCATION" } });
    expect(await reverseEntry(prisma, { entryId: entry.id, reason: "allocated to the wrong job (example)", actor: opA })).toMatchObject({ ok: true });
    expect(await rsum(id)).toMatchObject({ allocated: 0, unallocated: 30_000, ok: true });
    expect(await summary(a.id)).toMatchObject({ returned: 0, outstanding: 100_000, driftSatang: 0 });
    expect(await prisma.guideAdvanceEntry.count({ where: { receiptId: id } })).toBe(2);
  });
  it("31 · an allocation whose return is in PEAK cannot be reversed here — 409 naming it", async () => {
    const a = await advance();
    const id = await claim(300); await verify(id); await allocate(id, a.id, 300);
    await prisma.advancePeakSync.update({ where: { id: `RETURN:${id}` }, data: { status: "POSTED", documentNo: "JV-EX-0011" } });
    const entry = await prisma.guideAdvanceEntry.findFirstOrThrow({ where: { type: "RETURN_ALLOCATION" } });
    const r = await reverseEntry(prisma, { entryId: entry.id, reason: "try (example)", actor: opA });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(409); expect(r.reasons[0]).toMatch(/JV-EX-0011/); }
  });
});

describe("32–33 · returnSummary", () => {
  it("32 · unallocated = amount − live allocations − PAID refunds (RECORDED/APPROVED do not count)", () => {
    const s = returnSummary({ amountSatang: 50_000, status: "VERIFIED" }, [
      { id: "e1", type: "RETURN_ALLOCATION", amountSatang: 30_000 }, { id: "e2", type: "RETURN_ALLOCATION", amountSatang: 5_000 }, { id: "e3", type: "REVERSAL", amountSatang: -5_000, reversesEntryId: "e2" },
    ], [{ status: "PAID", amountSatang: 10_000 }, { status: "APPROVED", amountSatang: 4_000 }, { status: "RECORDED", amountSatang: 1_000 }, { status: "VOIDED", amountSatang: 9_000 }]);
    expect(s).toMatchObject({ amount: 50_000, allocated: 30_000, refunded: 10_000, pendingRefunds: 5_000, unallocated: 10_000, available: 5_000, ok: true });
  });
  it("33 · a return whose books do not add up blocks allocation and refunds — reported, not clamped", async () => {
    const a = await advance();
    const id = await claim(300); await verify(id);
    await prisma.$executeRawUnsafe(`UPDATE "GuideAdvanceReceipt" SET "allocatedSatang" = 10000 WHERE id = '${id}'`);
    expect((await rsum(id)).problems).toContain("ALLOCATED_COUNTER_DRIFT");
    const al = await allocate(id, a.id, 100);
    expect(al.ok).toBe(false);
    if (!al.ok) expect(al.reasons[0]).toMatch(/books are checked/);
    const rf = await recordRefund(prisma, { receiptId: id, amount: 100, reason: "send some back (example)", actor: opA });
    expect(rf.ok).toBe(false);
    expect(returnSummary({ amountSatang: 10_000, status: "VERIFIED" }, [{ id: "x", type: "RETURN_ALLOCATION", amountSatang: 12_000 }], [])).toMatchObject({ unallocated: -2_000, ok: false, problems: ["NEGATIVE_UNALLOCATED"] });
  });
});

describe("34–40 · roles, audit, and what never happens", () => {
  it("34 · a guide cannot verify, allocate, void, or record / approve / pay / void a refund", async () => {
    const a = await advance();
    const id = await claim(300); await verify(id);
    const rec = await recordRefund(prisma, { receiptId: id, amount: 100, reason: "send some back (example)", actor: opA });
    const fid = rec.ok ? rec.refund.id : "";
    for (const [h, target, body] of [[VERIFY, id, { bankRef: "BANK-EX-G" }], [ALLOCATE, id, { requestKey: "guide-try-1", allocations: [{ advanceId: a.id, amount: 100 }] }], [VOID_RETURN, id, { reason: "try (example)" }],
      [RECORD_REFUND, id, { amount: 50, reason: "try it (example)" }], [APPROVE_REFUND, fid, {}], [PAY_REFUND, fid, { paidAt: "2026-09-30T04:00:00Z", bankRef: "REFUND-EX-G" }], [VOID_REFUND, fid, { reason: "try (example)" }]] as const) {
      expect((await call(h as never, target, body, "GUIDE", "u-guide", G)).status).toBe(403);
    }
  });
  it("35 · operators and admins act through the routes; while ADVANCE_WRITES_FROZEN=1 every write answers 503", async () => {
    const a = await advance();
    const id = await claim(300, { advanceId: a.id });
    expect((await call(VERIFY, id, { bankRef: "BANK-EX-OP" }, "OPERATOR", opA.actorId)).status).toBe(200);
    expect((await call(ALLOCATE, id, { requestKey: "op-alloc-0001", allocations: [{ advanceId: a.id, amount: 300 }] }, "ADMIN", opB.actorId)).status).toBe(200);
    process.env.ADVANCE_WRITES_FROZEN = "1";
    const id2 = await claim(100).catch(() => "");
    expect(id2).not.toBe(""); // the service itself is not frozen — the routes are
    expect((await call(VERIFY, id2, { bankRef: "BANK-EX-FRZ" }, "OPERATOR", opA.actorId)).status).toBe(503);
    expect((await call(RECORD_REFUND, id2, { amount: 10, reason: "frozen test (example)" }, "OPERATOR", opA.actorId)).status).toBe(503);
    delete process.env.ADVANCE_WRITES_FROZEN;
  });
  it("36 · the return and refund audit entries carry no guest name or booking ref", async () => {
    const a = await advance({ amountSatang: 30_000, amount: 300 });
    const id = await claim(500, { advanceId: a.id }); await verify(id); await allocate(id, a.id, 300);
    const rec = await recordRefund(prisma, { receiptId: id, amount: 200, reason: "guide sent too much (example)", actor: opA });
    await approveRefund(prisma, { refundId: rec.ok ? rec.refund.id : "", actor: opB });
    await payRefund(prisma, { refundId: rec.ok ? rec.refund.id : "", paidAt: "2026-09-30T04:00:00Z", bankRef: "REFUND-EX-0004", actor: opA });
    const audits = await prisma.auditLog.findMany({ where: { action: { startsWith: "advance." } } });
    expect(audits.map((x) => x.action).sort()).toEqual(expect.arrayContaining(["advance.return_claimed", "advance.return_verified", "advance.return_allocated", "advance.refund_recorded", "advance.refund_approved", "advance.refund_paid"]));
    expect(JSON.stringify(audits.map((x) => x.detail))).not.toMatch(/Guest Example Person|GYGEXAMPLE9/);
  });
  it("38–40 · no guide payment, no supplemental payment, no PEAK posting, no network — and an untouched advance/return stays byte-identical", async () => {
    const bystanderAdv = await advance({ guideId: G2 });
    const bystanderRet = await claim(70, { guideId: G2 });
    const before = JSON.stringify([await prisma.guideAdvance.findUniqueOrThrow({ where: { id: bystanderAdv.id } }), await prisma.guideAdvanceReceipt.findUniqueOrThrow({ where: { id: bystanderRet } })]);
    const a = await advance({ amountSatang: 30_000, amount: 300 });
    const id = await claim(500, { advanceId: a.id }); await verify(id); await allocate(id, a.id, 300);
    const rec = await recordRefund(prisma, { receiptId: id, amount: 200, reason: "guide sent too much (example)", actor: opA });
    await approveRefund(prisma, { refundId: rec.ok ? rec.refund.id : "", actor: opB });
    await payRefund(prisma, { refundId: rec.ok ? rec.refund.id : "", paidAt: "2026-09-30T04:00:00Z", bankRef: "REFUND-EX-0005", actor: opA });
    expect(await prisma.guidePayment.count()).toBe(0);
    expect(await prisma.supplementalPayment.count()).toBe(0);
    expect(await prisma.advancePeakSync.count({ where: { status: { in: ["SENDING", "UNCERTAIN", "POSTED"] } } })).toBe(0);
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
    expect(JSON.stringify([await prisma.guideAdvance.findUniqueOrThrow({ where: { id: bystanderAdv.id } }), await prisma.guideAdvanceReceipt.findUniqueOrThrow({ where: { id: bystanderRet } })])).toBe(before);
  });
});

describe("41–45 · concurrency and retries", () => {
  it("41 · double verify → exactly one succeeds", async () => {
    const id = await claim(100);
    const rs = await Promise.all([verify(id, "BANK-EX-D1"), verify(id, "BANK-EX-D2"), verify(id, "BANK-EX-D3")]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect((await prisma.auditLog.count({ where: { action: "advance.return_verified" } }))).toBe(1);
  });
  it("42 · double allocate with the same request → one entry (the retry replays)", async () => {
    const a = await advance();
    const id = await claim(300); await verify(id);
    const rs = await Promise.all([allocate(id, a.id, 300, "same-key-0001"), allocate(id, a.id, 300, "same-key-0001")]);
    expect(rs.filter((r) => r.ok).length).toBeGreaterThanOrEqual(1);
    expect(await prisma.guideAdvanceEntry.count({ where: { type: "RETURN_ALLOCATION" } })).toBe(1);
    expect(await rsum(id)).toMatchObject({ allocated: 30_000, ok: true });
  });
  it("43 · two allocations racing for the same remaining balance → only one lands; nothing goes negative", async () => {
    const a = await advance(), b = await advance({ slotIdx: 1 });
    const id = await claim(300); await verify(id);
    const rs = await Promise.all([allocate(id, a.id, 300, "race-a-0001"), allocate(id, b.id, 300, "race-b-0001")]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(await rsum(id)).toMatchObject({ allocated: 30_000, unallocated: 0, ok: true });
    expect((await summary(a.id)).driftSatang + (await summary(b.id)).driftSatang).toBe(0);
  });
  it("44 · two approvers at once → approved once", async () => {
    const id = await claim(300); await verify(id);
    const rec = await recordRefund(prisma, { receiptId: id, amount: 100, reason: "send some back (example)", actor: opA });
    const fid = rec.ok ? rec.refund.id : "";
    const opC = await prisma.user.create({ data: { email: "op-c@example.test", displayName: "Op C", role: "OPERATOR", state: "ACTIVE" } });
    const rs = await Promise.all([approveRefund(prisma, { refundId: fid, actor: opB }), approveRefund(prisma, { refundId: fid, actor: { actorId: opC.id, actorRole: "OPERATOR" } })]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { action: "advance.refund_approved" } })).toBe(1);
  });
  it("45 · paying a refund twice (retry, or two clicks) → paid once, the balance taken once", async () => {
    const id = await claim(300); await verify(id);
    const rec = await recordRefund(prisma, { receiptId: id, amount: 100, reason: "send some back (example)", actor: opA });
    const fid = rec.ok ? rec.refund.id : "";
    await approveRefund(prisma, { refundId: fid, actor: opB });
    const pay = () => payRefund(prisma, { refundId: fid, paidAt: "2026-09-30T04:00:00Z", bankRef: "REFUND-EX-RETRY", actor: opA });
    const rs = await Promise.all([pay(), pay()]);
    expect(rs.every((r) => r.ok)).toBe(true); // one pays, the other replays
    expect((await pay())).toEqual({ ok: true, replayed: true });
    expect(await rsum(id)).toMatchObject({ refunded: 10_000, unallocated: 20_000, ok: true });
    expect(await prisma.auditLog.count({ where: { action: "advance.refund_paid" } })).toBe(1);
  });
});

describe("refund maker–checker with the ACCOUNTANT approving (owner decision 2026-10-01)", () => {
  let acct = { id: "" };
  async function overReturnByRoute() {
    const a = await advance({ amountSatang: 30_000, amount: 300 });
    const id = await claim(500, { advanceId: a.id }); await verify(id); await allocate(id, a.id, 300);
    return { a, id };
  }
  beforeEach(async () => {
    acct = await prisma.user.create({ data: { email: "acct@example.test", displayName: "Accountant Example", role: "ACCOUNTANT", state: "ACTIVE" } });
  });
  it("1, 9 · ADMIN records → ACCOUNTANT approves → ADMIN pays; the approval audit names the accountant and the role", async () => {
    const { id } = await overReturnByRoute();
    const rec = await call(RECORD_REFUND, id, { amount: 200, reason: "guide sent too much (example)" }, "ADMIN", opB.actorId);
    expect(rec.status, JSON.stringify(rec.body)).toBe(200);
    const fid = rec.body.refund.id as string;
    const appr = await call(APPROVE_REFUND, fid, {}, "ACCOUNTANT", acct.id);
    expect(appr.status, JSON.stringify(appr.body)).toBe(200);
    const pay = await call(PAY_REFUND, fid, { paidAt: "2026-09-30T04:00:00Z", bankRef: "REFUND-EX-ACCT" }, "ADMIN", opB.actorId);
    expect(pay.status, JSON.stringify(pay.body)).toBe(200);
    expect(await prisma.guideAdvanceRefund.findUniqueOrThrow({ where: { id: fid } })).toMatchObject({ status: "PAID", recordedById: opB.actorId, approvedById: acct.id, paidById: opB.actorId });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "advance.refund_approved" } });
    expect(audit).toMatchObject({ actorId: acct.id, actorRole: "ACCOUNTANT" });
    expect(await rsum(id)).toMatchObject({ refunded: 20_000, unallocated: 0 });
  });
  it("2 · the ADMIN who recorded a refund cannot approve it — and neither can an accountant who somehow recorded one", async () => {
    const { id } = await overReturnByRoute();
    const rec = await call(RECORD_REFUND, id, { amount: 100, reason: "guide sent too much (example)" }, "ADMIN", opB.actorId);
    const own = await call(APPROVE_REFUND, rec.body.refund.id, {}, "ADMIN", opB.actorId);
    expect(own.status).toBe(409);
    expect(own.body.reasons[0]).toMatch(/another person must approve/);
    // The rule is by person, not role: a refund recorded by this accountant's id is refused to them too.
    const r2 = await recordRefund(prisma, { receiptId: id, amount: 0.5, reason: "edge case of the rule (example)", actor: { actorId: acct.id, actorRole: "ACCOUNTANT" } });
    expect(r2.ok).toBe(true);
    expect((await call(APPROVE_REFUND, r2.ok ? r2.refund.id : "", {}, "ACCOUNTANT", acct.id)).status).toBe(409);
  });
  it("3–7 · an ACCOUNTANT cannot record, pay or void a refund, nor verify, allocate, link or void a return, settle expenses or reverse an advance", async () => {
    const { a, id } = await overReturnByRoute();
    const rec = await call(RECORD_REFUND, id, { amount: 100, reason: "guide sent too much (example)" }, "ADMIN", opB.actorId);
    const fid = rec.body.refund.id as string;
    const c = await claim(50);
    const s = await sheet();
    const forbidden = [
      [RECORD_REFUND, id, { amount: 50, reason: "accountant try (example)" }],
      [PAY_REFUND, fid, { paidAt: "2026-09-30T04:00:00Z", bankRef: "REFUND-EX-NOPE" }],
      [VOID_REFUND, fid, { reason: "accountant try (example)" }],
      [VERIFY, c, { bankRef: "BANK-EX-ACCT" }],
      [ALLOCATE, id, { requestKey: "acct-try-0001", allocations: [{ advanceId: a.id, amount: 10 }] }],
      [LINK_RETURN, c, { advanceId: a.id }],
      [VOID_RETURN, c, { reason: "accountant try (example)" }],
      [SETTLE, a.id, { jobSheetId: s.id, sheetVersion: s.updatedAt.toISOString(), lines: [{ index: 0, identity: "x" }] }],
      [REVERSE_ADVANCE, a.id, { reason: "accountant try (example)" }],
    ] as const;
    for (const [h, target, body] of forbidden) expect((await call(h as never, target, body, "ACCOUNTANT", acct.id)).status).toBe(403);
    expect(await prisma.guideAdvanceRefund.findUniqueOrThrow({ where: { id: fid } })).toMatchObject({ status: "RECORDED" });
  });
  it("8 · a GUIDE is denied every refund action, approval included", async () => {
    const { id } = await overReturnByRoute();
    const rec = await call(RECORD_REFUND, id, { amount: 100, reason: "guide sent too much (example)" }, "ADMIN", opB.actorId);
    const fid = rec.body.refund.id as string;
    for (const [h, target, body] of [[RECORD_REFUND, id, { amount: 10, reason: "guide try (example)" }], [APPROVE_REFUND, fid, {}], [PAY_REFUND, fid, { paidAt: "2026-09-30T04:00:00Z", bankRef: "REFUND-EX-G2" }], [VOID_REFUND, fid, { reason: "guide try (example)" }]] as const) {
      expect((await call(h as never, target, body, "GUIDE", "u-guide", G)).status).toBe(403);
    }
  });
  it("10 · an accountant and an admin approving at once → approved exactly once", async () => {
    const { id } = await overReturnByRoute();
    const rec = await recordRefund(prisma, { receiptId: id, amount: 100, reason: "guide sent too much (example)", actor: opA });
    const fid = rec.ok ? rec.refund.id : "";
    const rs = await Promise.all([
      approveRefund(prisma, { refundId: fid, actor: { actorId: acct.id, actorRole: "ACCOUNTANT" } }),
      approveRefund(prisma, { refundId: fid, actor: opB }),
      approveRefund(prisma, { refundId: fid, actor: { actorId: acct.id, actorRole: "ACCOUNTANT" } }),
    ]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { action: "advance.refund_approved" } })).toBe(1);
  });
});
