import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { SLOT_TIMES } from "@/lib/slots";

// GET — the signed-in guide's upcoming confirmed tours (today onward).
export async function GET() {
  const session = await auth();
  const guideId = session?.user?.guideId;
  if (!guideId) return NextResponse.json({ items: [] });

  // "Today" in Bangkok (UTC+7) so a tour earlier today still shows.
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

  const rows = await prisma.assignment.findMany({
    where: { guideId, date: { gte: today } },
    include: { tour: true },
    orderBy: [{ date: "asc" }, { slotIdx: "asc" }],
    take: 200,
  });

  return NextResponse.json({
    items: rows.map((a) => ({
      date: a.date, slotIdx: a.slotIdx, time: SLOT_TIMES[a.slotIdx] ?? "",
      tourId: a.tourId, tourName: a.tour?.name ?? a.tourId, pax: a.pax, note: a.note,
    })),
  });
}

// POST { date, slotIdx, reason } — guide cancels their own tour (urgent). The
// assignment is freed and every operator is notified with the reason.
export async function POST(req: NextRequest) {
  const session = await auth();
  const guideId = session?.user?.guideId;
  if (!guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotIdx: z.number().int().min(0), reason: z.string().max(300).optional() }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { date, slotIdx, reason } = parsed.data;

  const a = await prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } }, include: { tour: true } });
  if (!a) return NextResponse.json({ error: "not-found" }, { status: 404 });

  await prisma.assignment.delete({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } });

  const ops = await prisma.user.findMany({ where: { role: { in: ["OPERATOR", "ADMIN"] }, state: "ACTIVE" }, select: { id: true } });
  const who = session!.user!.name ?? "";
  const msg = `⚠️ ${guideId} ${who} CANCELLED their tour: ${a.tour?.name ?? a.tourId} · ${date} ${SLOT_TIMES[slotIdx] ?? ""}${reason ? `\nReason: ${reason}` : ""}`;
  if (ops.length) await prisma.notification.createMany({ data: ops.map((o) => ({ userId: o.id, kind: "cancel", message: msg })) });
  await audit({ actorId: session!.user!.id ?? null, action: "tour.cancelled", entityType: "Assignment", detail: { guideId, date, slotIdx, reason } });

  return NextResponse.json({ ok: true });
}
