import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

const ops = (r?: string) => r === "OPERATOR" || r === "ADMIN";
const PERIOD = /^\d{4}-\d{2}$/;

// GET ?period=YYYY-MM — bonuses/adjustments for the month (with guide names).
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const period = req.nextUrl.searchParams.get("period") || "";
  if (!PERIOD.test(period)) return NextResponse.json({ error: "bad-period" }, { status: 400 });
  const [bonuses, guides] = await Promise.all([
    prisma.bonus.findMany({ where: { period }, orderBy: { createdAt: "desc" } }),
    prisma.user.findMany({ where: { guideId: { not: null } }, select: { guideId: true, displayName: true } }),
  ]);
  const gName = (gid: string) => guides.find((g) => g.guideId === gid)?.displayName ?? gid;
  const rows = bonuses.map((b) => ({ id: b.id, guideId: b.guideId, guide: gName(b.guideId), amount: b.amount, reason: b.reason ?? "", eslipUrl: b.eslipUrl ?? null }));
  const total = rows.reduce((s, b) => s + b.amount, 0);
  return NextResponse.json({ period, rows, total: Math.round(total * 100) / 100 });
}

// POST { period, guideId, amount, reason? } — add a bonus.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({
    period: z.string().regex(PERIOD), guideId: z.string().min(1),
    amount: z.number().positive().max(1000000), reason: z.string().max(200).optional(),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const d = parsed.data;
  const b = await prisma.bonus.create({ data: { period: d.period, guideId: d.guideId, amount: d.amount, reason: d.reason?.trim() || null, createdById: session!.user!.id ?? null } });
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "bonus.added", entityType: "Bonus", entityId: b.id, detail: { period: d.period, guideId: d.guideId, amount: d.amount } });
  return NextResponse.json({ ok: true });
}

// DELETE { id } — remove a bonus.
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const id = String(body?.id || "");
  if (!id) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  await prisma.bonus.deleteMany({ where: { id } });
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "bonus.removed", entityType: "Bonus", entityId: id });
  return NextResponse.json({ ok: true });
}
