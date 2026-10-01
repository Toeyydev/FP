import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { canViewFinance } from "@/lib/roles";

const ops = (r?: string) => r === "OPERATOR" || r === "ADMIN";
const PERIOD = /^\d{4}-\d{2}$/;

// GET ?period=YYYY-MM — bonuses/adjustments for the month (with guide names).
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const period = req.nextUrl.searchParams.get("period") || "";
  if (!PERIOD.test(period)) return NextResponse.json({ error: "bad-period" }, { status: 400 });
  const [bonuses, guides] = await Promise.all([
    prisma.bonus.findMany({ where: { period }, orderBy: { createdAt: "desc" }, include: { supplementals: { where: { voidedAt: null }, select: { id: true } } } }),
    prisma.user.findMany({ where: { guideId: { not: null } }, select: { guideId: true, displayName: true } }),
  ]);
  const gName = (gid: string) => guides.find((g) => g.guideId === gid)?.displayName ?? gid;
  // An earlier bonus is settled either by its old slip, or by the supplemental payment it
  // was converted into; one with neither is still owed and may be converted.
  const rows = bonuses.map((b) => ({ id: b.id, guideId: b.guideId, guide: gName(b.guideId), amount: b.amount, reason: b.reason ?? "", ref: b.ref ?? "", eslipUrl: b.eslipUrl ?? null, period: b.period, convertedTo: b.supplementals[0]?.id ?? null }));
  const total = rows.reduce((s, b) => s + b.amount, 0);
  return NextResponse.json({ period, rows, total: Math.round(total * 100) / 100 });
}

// Writes are closed (owner decision 2026-10-01). A bonus is now a supplemental payment:
// it has a status, withholding, an account, a PEAK reference and its own transfer
// (lib/supplemental-payments). The rows already here stay readable as history, unchanged.
const readOnly = async (req: NextRequest) => {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  void req;
  return NextResponse.json({ error: "read-only", reasons: ["Bonuses are now paid as supplemental payments — use Add Supplemental Payment. Earlier bonuses stay here as history."] }, { status: 410 });
};
export const POST = readOnly;
export const PATCH = readOnly;
export const DELETE = readOnly;
