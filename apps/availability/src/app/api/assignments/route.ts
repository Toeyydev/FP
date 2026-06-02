import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { SLOT_COUNT } from "@/lib/slots";
import { dayOf } from "@/lib/dates";

const monthRe = /^\d{4}-\d{2}$/;
const dateRe = /^\d{4}-\d{2}-\d{2}$/;

export type Job = { tour: string; pax: number | null; note: string | null };

// GET /api/assignments?month=YYYY-MM
// Guides see only their own; operators see all.
// Shape: { [guideId]: { [dayOfMonth]: { [slotIdx]: Job } } }
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const month = req.nextUrl.searchParams.get("month") ?? "";
  if (!monthRe.test(month)) return NextResponse.json({ error: "bad month" }, { status: 400 });

  const isOperator = session.user.role === "OPERATOR";
  const rows = await prisma.assignment.findMany({
    where: {
      date: { startsWith: month },
      ...(isOperator ? {} : { guideId: session.user.guideId ?? "__none__" }),
    },
    select: { guideId: true, date: true, slotIdx: true, tourId: true, pax: true, note: true },
  });

  const out: Record<string, Record<number, Record<number, Job>>> = {};
  for (const r of rows) {
    const byDay = (out[r.guideId] ??= {});
    const byIdx = (byDay[dayOf(r.date)] ??= {});
    byIdx[r.slotIdx] = { tour: r.tourId, pax: r.pax, note: r.note };
  }
  return NextResponse.json(out);
}

// POST /api/assignments  { guideId, date, slotIdx, tourId, pax?, note? }  — operator only
const postSchema = z.object({
  guideId: z.string().min(1),
  date: z.string().regex(dateRe),
  slotIdx: z.number().int().min(0).max(SLOT_COUNT - 1),
  tourId: z.string().min(1),
  pax: z.number().int().min(0).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

function isOps(role?: string) {
  return role === "OPERATOR" || role === "ADMIN";
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) {
    return NextResponse.json({ error: "operators only" }, { status: 403 });
  }
  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad body" }, { status: 400 });
  const { guideId, date, slotIdx, tourId, pax, note } = parsed.data;

  if (await prisma.blockedDate.findUnique({ where: { date } })) {
    return NextResponse.json({ error: "date-blocked" }, { status: 409 });
  }

  // Validate FK targets exist for clean errors.
  const [guide, tour] = await Promise.all([
    prisma.user.findUnique({ where: { guideId } }),
    prisma.tour.findUnique({ where: { id: tourId } }),
  ]);
  if (!guide) return NextResponse.json({ error: "unknown guide" }, { status: 400 });
  if (!tour) return NextResponse.json({ error: "unknown tour" }, { status: 400 });

  await prisma.assignment.upsert({
    where: { guideId_date_slotIdx: { guideId, date, slotIdx } },
    create: { guideId, date, slotIdx, tourId, pax: pax ?? null, note: note ?? null },
    update: { tourId, pax: pax ?? null, note: note ?? null },
  });
  return NextResponse.json({ ok: true });
}

// DELETE /api/assignments  { guideId, date, slotIdx }  — operator only
const delSchema = z.object({
  guideId: z.string().min(1),
  date: z.string().regex(dateRe),
  slotIdx: z.number().int().min(0).max(SLOT_COUNT - 1),
});

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) {
    return NextResponse.json({ error: "operators only" }, { status: 403 });
  }
  const parsed = delSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad body" }, { status: 400 });
  const { guideId, date, slotIdx } = parsed.data;

  await prisma.assignment.deleteMany({ where: { guideId, date, slotIdx } });
  return NextResponse.json({ ok: true });
}
