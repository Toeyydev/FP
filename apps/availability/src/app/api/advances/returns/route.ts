import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { advanceFrozenBody, advanceWritesFrozen } from "@/lib/advances/freeze";
import { canViewFinance, isOps } from "@/lib/roles";
import { recordReceipt } from "@/lib/advances/service";
import { fromSatang, unallocatedSatang } from "@/lib/advances/rules";
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
  return NextResponse.json({
    receipts: rows.map((r) => ({
      id: r.id, receiptNo: r.receiptNo, guideId: r.guideId, receivedDate: r.receivedDate, status: r.status,
      amount: fromSatang(r.amountSatang), allocated: fromSatang(r.allocatedSatang), unallocated: fromSatang(unallocatedSatang(r)),
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
  if (advanceWritesFrozen()) return NextResponse.json(advanceFrozenBody, { status: 503 });
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
