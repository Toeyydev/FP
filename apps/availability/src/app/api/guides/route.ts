import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

function ops(role?: string) { return role === "OPERATOR" || role === "ADMIN"; }

// GET — operator guide directory: each active guide with languages, tour count,
// average rating, and current-week leave.
export async function GET() {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

  const [guides, assigns, ratings, leaves] = await Promise.all([
    prisma.user.findMany({ where: { role: "GUIDE", state: "ACTIVE", guideId: { not: null } }, select: { guideId: true, displayName: true, languages: true } }),
    prisma.assignment.groupBy({ by: ["guideId"], _count: { _all: true } }),
    prisma.guideRating.groupBy({ by: ["guideId"], _avg: { stars: true }, _count: { _all: true } }),
    prisma.leaveRequest.findMany({ where: { status: "APPROVED", toDate: { gte: today } }, select: { guideId: true, fromDate: true, toDate: true } }),
  ]);
  const tours = new Map(assigns.map((a) => [a.guideId, a._count._all]));
  const rate = new Map(ratings.map((r) => [r.guideId, { avg: r._avg.stars, n: r._count._all }]));
  const leaveOf = (gid: string) => leaves.find((l) => l.guideId === gid);

  const rows = guides.map((g) => {
    const r = rate.get(g.guideId!);
    const l = leaveOf(g.guideId!);
    return { guideId: g.guideId, name: g.displayName, languages: g.languages ?? "", tours: tours.get(g.guideId!) ?? 0, rating: r?.avg ? Math.round(r.avg * 10) / 10 : null, ratingCount: r?.n ?? 0, leave: l ? `${l.fromDate}${l.toDate !== l.fromDate ? `–${l.toDate}` : ""}` : null };
  }).sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1) || b.tours - a.tours);
  return NextResponse.json({ rows });
}

// POST { guideId, date, slotIdx, stars, note? } — operator rates a tour's guide.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({ guideId: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotIdx: z.number().int().min(0), stars: z.number().int().min(1).max(5), note: z.string().max(300).optional() }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { guideId, date, slotIdx, stars, note } = parsed.data;
  const a = await prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } });
  if (!a) return NextResponse.json({ error: "not-found" }, { status: 404 });
  await prisma.guideRating.upsert({
    where: { guideId_date_slotIdx: { guideId, date, slotIdx } },
    create: { guideId, date, slotIdx, tourId: a.tourId, stars, note: note ?? null, ratedBy: session!.user!.id },
    update: { stars, note: note ?? null, ratedBy: session!.user!.id },
  });
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "guide.rated", entityType: "Assignment", detail: { guideId, date, slotIdx, stars } });
  return NextResponse.json({ ok: true });
}
