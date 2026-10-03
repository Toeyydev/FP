import { accountingWriteRefusal } from "@/lib/advances/write-guard";
import { NextRequest, NextResponse } from "next/server";
import { advanceSyncStates } from "@/lib/advances/peak-sync";
import { peakLinksFor } from "@/lib/advances/peak-link";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { canViewFinance, isOps } from "@/lib/roles";
import { recordReceipt } from "@/lib/advances/service";
import { fromSatang } from "@/lib/advances/rules";
import { returnSummary } from "@/lib/advances/returns";
import { bangkokToday } from "@/lib/payments-v2/rules";
import { receiptBody } from "@/lib/advances/request-schema";

export const dynamic = "force-dynamic";

// GET ?guideId=&status= — money guides have sent back, and how much of each is still
// waiting to be put against an advance.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const guideId = req.nextUrl.searchParams.get("guideId") ?? "";
  const status = req.nextUrl.searchParams.get("status") ?? "";
  const rows = await prisma.guideAdvanceReceipt.findMany({
    where: { ...(guideId ? { guideId } : {}), ...(status ? { status } : {}) },
    orderBy: [{ receivedDate: "desc" }, { receiptNo: "desc" }],
    take: 500,
  });
  const sync = await advanceSyncStates(prisma, rows.map(r => `RETURN:${r.id}`));
  // Each return's balance from its own records (lib/advances/returns returnSummary).
  const [allocs, refunds] = await Promise.all([
    prisma.guideAdvanceEntry.findMany({ where: { receiptId: { in: rows.map((r) => r.id) } }, select: { id: true, receiptId: true, type: true, amountSatang: true, reversesEntryId: true } }),
    prisma.guideAdvanceRefund.findMany({ where: { receiptId: { in: rows.map((r) => r.id) } }, orderBy: { createdAt: "asc" }, select: { id: true, refundNo: true, receiptId: true, amountSatang: true, status: true, reason: true, recordedById: true, approvedById: true, paidAt: true, bankRef: true, voidReason: true } }),
  ]);
  const links = await peakLinksFor(prisma, "RETURN", rows.map((r) => r.id));
  return NextResponse.json({
    receipts: rows.map((r) => ({
      peakSync: sync.get(`RETURN:${r.id}`) ?? null, peakLink: links.get(r.id) ?? null, id: r.id, receiptNo: r.receiptNo, guideId: r.guideId, receivedDate: r.receivedDate, status: r.status,
      ...(() => {
        const s = returnSummary(r, allocs.filter((e) => e.receiptId === r.id), refunds.filter((f) => f.receiptId === r.id));
        return { amount: fromSatang(s.amount), allocated: fromSatang(s.allocated), refunded: fromSatang(s.refunded), pendingRefunds: fromSatang(s.pendingRefunds), unallocated: fromSatang(s.unallocated), available: fromSatang(s.available), problems: s.problems };
      })(),
      advanceId: r.advanceId, jobSheetId: r.jobSheetId, voidedAt: r.voidedAt, voidReason: r.voidReason,
      refunds: refunds.filter((f) => f.receiptId === r.id).map((f) => ({ ...f, amount: fromSatang(f.amountSatang) })),
      bankRef: r.bankRef, bankAccount: r.bankAccount, slipUrl: r.slipUrl, note: r.note,
      claimedAt: r.claimedAt, verifiedAt: r.verifiedAt, rejectedReason: r.rejectedReason,
    })),
  });
}

// POST — a return. An operator records one they have seen in the bank (VERIFIED); the
// job's own guide may only CLAIM one, which settles nothing until an operator checks it.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  { const refused = await accountingWriteRefusal(prisma); if (refused) return NextResponse.json(refused.body, { status: refused.status }); }
  const parsed = receiptBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body", reasons: parsed.error.issues.map((i) => i.message) }, { status: 400 });

  const ops = isOps(session.user.role);
  const ownGuide = session.user.guideId && session.user.guideId === parsed.data.guideId;
  if (!ops && !ownGuide) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const result = await recordReceipt(prisma, {
    ...parsed.data, byGuide: !ops, today: bangkokToday(),
    actor: { actorId: session.user.id ?? null, actorRole: session.user.role ?? null },
  });
  if (!result.ok) return NextResponse.json({ error: "not-allowed", reasons: result.reasons, detail: result.reasons.join("\n") }, { status: result.status });
  return NextResponse.json({ ok: true, receipt: result.receipt });
}
