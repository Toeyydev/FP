import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { submitTourReport } from "@/lib/guide-lifecycle";

// GET ?date&slotIdx — the bookings for the signed-in guide's own tour (for the
// no-show checklist in the report). Guide-only; returns [] if not assigned.
export async function GET(req: NextRequest) {
  const session = await auth();
  const guideId = session?.user?.guideId;
  if (!guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const date = req.nextUrl.searchParams.get("date") || "";
  const slotIdx = Number(req.nextUrl.searchParams.get("slotIdx") ?? "-1");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(slotIdx >= 0)) return NextResponse.json({ error: "bad-query" }, { status: 400 });
  const a = await prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } }, select: { id: true } });
  if (!a) return NextResponse.json({ bookings: [] });
  const bookings = await prisma.booking.findMany({ where: { date, slotIdx, status: { in: ["PENDING", "OFFERED", "ASSIGNED"] } }, select: { id: true, customerName: true, confirmationCode: true, externalRef: true, pax: true, noShow: true, noShowPax: true } });
  return NextResponse.json({ bookings: bookings.map((b) => ({ id: b.id, name: b.customerName || b.confirmationCode || b.externalRef || "Guest", ref: b.externalRef || b.confirmationCode || "", pax: b.pax ?? 0, noShow: b.noShow, noShowPax: b.noShowPax })) });
}

// POST { date, slotIdx, bookedPax, noShow, leftEarly, comments? } — guide submits
// the end-of-tour report for their assignment. Also records the COMPLETE check-in.
// Attendance is recorded for quality/disputes — it does NOT change payout.
export async function POST(req: NextRequest) {
  const session = await auth();
  const guideId = session?.user?.guideId;
  if (!guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    slotIdx: z.number().int().min(0),
    bookedPax: z.number().int().min(0).max(100).optional(),
    noShow: z.number().int().min(0).max(100).default(0),
    // Per-booking no-show counts from the checklist: { id, pax } where pax is how many
    // of that booking's guests didn't arrive (0 = all came, whole pax = fully absent).
    noShowCounts: z.array(z.object({ id: z.string(), pax: z.number().int().min(0).max(100) })).max(100).optional(),
    leftEarly: z.number().int().min(0).max(100).default(0),
    comments: z.string().max(1000).optional(),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });

  const r = await submitTourReport({ ...parsed.data, guideId, actorId: session.user?.id ?? null });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true });
}
