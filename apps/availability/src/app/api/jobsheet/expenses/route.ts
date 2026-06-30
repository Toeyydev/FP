import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { notifyOps } from "@/lib/booking-import";
import { makeRef, thb, DEFAULT_EXPENSES, DEFAULT_GUIDE_FEE } from "@/lib/jobsheet";

const ops = (r?: string) => r === "OPERATOR" || r === "ADMIN";

// POST { guideId, date, slotIdx, expenses } — the assigned guide (or an operator)
// reports the expenses they paid on tour. Stored SEPARATELY on the sheet as
// `guideExpenses` so it never overwrites the operator's official set — the operator
// cross-checks and accepts. Operators are notified on each guide submission.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const role = session.user.role, myGuideId = session.user.guideId;
  const parsed = z.object({
    guideId: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotIdx: z.number().int().min(0),
    expenses: z.array(z.object({
      description: z.string().max(120),
      price: z.number().nullable(),
      pax: z.number().nullable(),
    })).max(40),
    note: z.string().max(500).optional(),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { guideId, date, slotIdx, expenses } = parsed.data;
  const note = parsed.data.note?.trim() || null;
  if (!ops(role) && myGuideId !== guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const now = new Date();
  const key = { guideId_date_slotIdx: { guideId, date, slotIdx } };
  const existing = await prisma.jobSheet.findUnique({ where: key, select: { id: true, tourId: true } });
  if (existing) {
    await prisma.jobSheet.update({ where: key, data: { guideExpenses: expenses, guideExpensesAt: now, guideExpensesNote: note } });
  } else {
    // No saved sheet yet — scaffold one that carries the guide's report.
    const a = await prisma.assignment.findUnique({ where: key, select: { tourId: true } });
    const ref = makeRef(date, (await prisma.jobSheet.count({ where: { date } })) + 1);
    await prisma.jobSheet.create({ data: { ref, guideId, date, slotIdx, tourId: a?.tourId ?? "", status: "Confirmed", bookings: [], expenses: DEFAULT_EXPENSES, guideFee: DEFAULT_GUIDE_FEE, guideExpenses: expenses, guideExpensesAt: now, guideExpensesNote: note, createdById: session.user.id ?? null } });
  }

  // Tell the operators a guide reported expenses to cross-check.
  try {
    const tourId = existing?.tourId || (await prisma.assignment.findUnique({ where: key, select: { tourId: true } }))?.tourId || "";
    const tour = tourId ? await prisma.tour.findUnique({ where: { id: tourId }, select: { name: true } }) : null;
    const total = expenses.reduce((s, e) => s + (Number(e.price) || 0) * (Number(e.pax) || 0), 0);
    const dl = new Date(`${date}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
    // No { date } — the tour is already past, and that option suppresses past-date alerts.
    await notifyOps(`${guideId} reported expenses for ${tour?.name ?? tourId} · ${dl} — ${thb(total)}. Cross-check on the job sheet.`, "Guide reported expenses", `${guideId} · ${dl} · ${thb(total)}`);
  } catch { /* notifying ops is best-effort */ }

  await audit({ actorId: session.user.id ?? null, actorRole: role ?? "GUIDE", action: "jobsheet.guide_expenses", entityType: "JobSheet", detail: { guideId, date, slotIdx, lines: expenses.length } });
  return NextResponse.json({ ok: true });
}
