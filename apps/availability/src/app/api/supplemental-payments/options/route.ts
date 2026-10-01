import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { canViewFinance } from "@/lib/roles";
import { mappedCategories } from "@/lib/supplemental-payments/service";
import { whtPolicies } from "@/lib/supplemental-payments/policy";

export const dynamic = "force-dynamic";

// GET — what the Add Supplemental Payment form offers: the guides; and, for ?guideId=, that
// guide's jobs (by Job No.), the payments already made to them (to name the one this was
// left out of), and the accounts with a PEAK mapping. Read-only.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const guideId = req.nextUrl.searchParams.get("guideId") || "";
  const guides = await prisma.user.findMany({ where: { guideId: { not: null }, role: "GUIDE" }, select: { guideId: true, displayName: true }, orderBy: { guideId: "asc" } });
  // The withholding rate per type from configured policy (null = none configured: the
  // operator must enter one). Never a rate borrowed from the guide fee.
  const whtPolicy = whtPolicies();
  if (!guideId) return NextResponse.json({ guides, whtPolicy, categories: await mappedCategories(prisma) });
  const [sheets, payments, categories] = await Promise.all([
    prisma.jobSheet.findMany({ where: { guideId, ref: { not: null } }, orderBy: [{ date: "desc" }, { slotIdx: "desc" }], take: 200, select: { ref: true, date: true, slotIdx: true } }),
    prisma.guidePayment.findMany({ where: { guideId, status: "RECORDED" }, orderBy: { paymentDate: "desc" }, take: 100, select: { id: true, paymentNo: true, paymentDate: true, amountTransferred: true, kind: true } }),
    mappedCategories(prisma),
  ]);
  return NextResponse.json({
    guides, whtPolicy, categories,
    jobs: sheets.map((s) => ({ jobNo: s.ref!, date: s.date, slotIdx: s.slotIdx })),
    payments: payments.map((p) => ({ id: p.id, paymentNo: p.paymentNo, paymentDate: p.paymentDate, amountTransferred: Number(p.amountTransferred), kind: p.kind })),
  });
}
