import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { advanceFrozenBody, advanceWritesFrozen } from "@/lib/advances/freeze";
import { canViewFinance, isOps } from "@/lib/roles";
import { issueAdvance } from "@/lib/advances/service";
import { advanceStatus, fromSatang, outstandingSatang } from "@/lib/advances/rules";
import { bangkokToday } from "@/lib/payments-v2/rules";
import { advanceBody } from "@/lib/advances/request-schema";

export const dynamic = "force-dynamic";

// GET ?guideId=&status=open — the advances and what each one still owes.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const guideId = req.nextUrl.searchParams.get("guideId") ?? "";
  const only = req.nextUrl.searchParams.get("status") ?? "";
  const rows = await prisma.guideAdvance.findMany({
    where: { ...(guideId ? { guideId } : {}) },
    orderBy: [{ advanceDate: "desc" }, { advanceNo: "desc" }],
    take: 500,
    select: {
      id: true, advanceNo: true, guideId: true, jobNo: true, advanceDate: true, accountingPeriod: true,
      amountSatang: true, settledSatang: true, purpose: true, method: true, txRef: true, slipUrl: true,
      reversedAt: true, reversalReason: true, peakDocumentNo: true,
    },
  });
  const advances = rows
    .map((r) => ({
      ...r, amount: fromSatang(r.amountSatang), settled: fromSatang(r.settledSatang),
      outstanding: fromSatang(outstandingSatang(r)), status: advanceStatus(r),
    }))
    .filter((r) => (only === "open" ? r.status === "OPEN" || r.status === "PARTIALLY_SETTLED" : true));
  return NextResponse.json({ advances });
}

// POST — record money the company transferred to a guide. Operators only: money going
// out to a guide is the company's to record, never the guide's.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (advanceWritesFrozen()) return NextResponse.json(advanceFrozenBody, { status: 503 });
  const parsed = advanceBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body", reasons: parsed.error.issues.map((i) => i.message) }, { status: 400 });

  const result = await issueAdvance(prisma, {
    ...parsed.data, today: bangkokToday(),
    actor: { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null },
  });
  if (!result.ok) return NextResponse.json({ error: "not-allowed", reasons: result.reasons, detail: result.reasons.join("\n") }, { status: result.status });
  return NextResponse.json({ ok: true, advance: result.advance });
}
