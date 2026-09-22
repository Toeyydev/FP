import { NextRequest, NextResponse } from "next/server";
import { advanceSyncStates } from "@/lib/advances/peak-sync";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { canViewFinance } from "@/lib/roles";
import { advanceStatus, ENTRY_LABEL, fromSatang, type EntryType } from "@/lib/advances/rules";

export const dynamic = "force-dynamic";

// GET — one advance and every entry on its ledger, with what each entry points at, so an
// operator can see why the balance is what it is and correct the right thing.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  const advance = await prisma.guideAdvance.findUnique({ where: { id } });
  if (!advance) return NextResponse.json({ error: "not-found" }, { status: 404 });
  const entries = await prisma.guideAdvanceEntry.findMany({ where: { advanceId: id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const [payments, receipts] = await Promise.all([
    prisma.guidePayment.findMany({ where: { id: { in: entries.map((e) => e.paymentId).filter((x): x is string => !!x) } }, select: { id: true, paymentNo: true, status: true } }),
    prisma.guideAdvanceReceipt.findMany({ where: { id: { in: entries.map((e) => e.receiptId).filter((x): x is string => !!x) } }, select: { id: true, receiptNo: true } }),
  ]);
  const sync = await advanceSyncStates(prisma, entries.map(e => `EXPENSE:${e.id}`));
  return NextResponse.json({
    advance: {
      id: advance.id, advanceNo: advance.advanceNo, guideId: advance.guideId, jobNo: advance.jobNo, advanceDate: advance.advanceDate,
      amount: fromSatang(advance.amountSatang), settled: fromSatang(advance.settledSatang), outstanding: fromSatang(advance.amountSatang - advance.settledSatang),
      status: advanceStatus(advance), reversalReason: advance.reversalReason,
    },
    entries: entries.map((e) => {
      const payment = payments.find((p) => p.id === e.paymentId);
      return {
        peakSync: sync.get(`EXPENSE:${e.id}`) ?? null, id: e.id, type: e.type, label: ENTRY_LABEL[e.type as EntryType] ?? e.type, amount: fromSatang(e.amountSatang),
        effectiveDate: e.effectiveDate, jobNo: e.jobNo, reason: e.reason, createdAt: e.createdAt,
        paymentNo: payment?.paymentNo ?? null, paymentStatus: payment?.status ?? null,
        receiptNo: receipts.find((r) => r.id === e.receiptId)?.receiptNo ?? null,
        reversesEntryId: e.reversesEntryId, reversedByEntryId: e.reversedByEntryId,
        // What an operator may do with it here. A deduction is undone with its payment.
        canReverse: e.type !== "REVERSAL" && e.type !== "PAYMENT_DEDUCTION" && !e.reversedByEntryId,
      };
    }),
  });
}
