import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { linePush, lineEnabled } from "@/lib/line";
import { SLOT_TIMES } from "@/lib/slots";

function ops(role?: string) {
  return role === "OPERATOR" || role === "ADMIN";
}

// Build one guide's "mini job sheet" for a date as a LINE-friendly text block.
function buildSheet(dateLabel: string, jobs: { slotIdx: number; tourName: string; pax: number | null; note: string | null }[]) {
  const lines = jobs
    .sort((a, b) => a.slotIdx - b.slotIdx)
    .map((j) => {
      const time = SLOT_TIMES[j.slotIdx] ?? "";
      let s = `• ${time}  ${j.tourName}`;
      const extra: string[] = [];
      if (j.pax != null) extra.push(`👥 ${j.pax} pax`);
      if (j.note) extra.push(`📝 ${j.note}`);
      if (extra.length) s += `\n   ${extra.join(" · ")}`;
      return s;
    });
  return `📋 Folkpath job sheet — ${dateLabel}\n━━━━━━━━━━━━━━\n${lines.join("\n")}\n━━━━━━━━━━━━━━\n${jobs.length} job(s). Reply here if anything's unclear 🙏`;
}

// POST { date: "YYYY-MM-DD", guideId? }  — operator/admin only.
// Sends each assigned guide their personal job sheet for the day via LINE (if
// linked) and as an in-app notification (always, so nothing is missed).
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    guideId: z.string().min(1).optional(),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { date, guideId } = parsed.data;

  const assignments = await prisma.assignment.findMany({
    where: { date, ...(guideId ? { guideId } : {}) },
    include: { tour: true },
  });
  if (assignments.length === 0) return NextResponse.json({ ok: true, count: 0, lineSent: 0, lineSkipped: [] });

  // Group jobs per guide.
  const byGuide = new Map<string, { slotIdx: number; tourName: string; pax: number | null; note: string | null }[]>();
  for (const a of assignments) {
    const arr = byGuide.get(a.guideId) ?? [];
    arr.push({ slotIdx: a.slotIdx, tourName: a.tour?.name ?? a.tourId, pax: a.pax, note: a.note });
    byGuide.set(a.guideId, arr);
  }

  const guides = await prisma.user.findMany({
    where: { role: "GUIDE", guideId: { in: [...byGuide.keys()] } },
    select: { id: true, guideId: true, displayName: true, lineUserId: true },
  });

  const dateLabel = new Date(`${date}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

  let lineSent = 0;
  const lineSkipped: string[] = [];
  for (const g of guides) {
    const jobs = byGuide.get(g.guideId!) ?? [];
    const text = buildSheet(dateLabel, jobs);
    // Always drop it in the in-app bell.
    await prisma.notification.create({ data: { userId: g.id, kind: "jobsheet", message: text } });
    // Push to LINE if the guide has linked their account.
    if (lineEnabled && g.lineUserId) {
      await linePush(g.lineUserId, text);
      lineSent++;
    } else {
      lineSkipped.push(g.guideId!);
    }
  }

  await audit({
    actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null,
    action: "jobsheet.sent", entityType: "Assignment",
    detail: { date, guides: guides.length, lineSent, lineSkipped },
  });

  return NextResponse.json({ ok: true, count: guides.length, lineSent, lineSkipped });
}
