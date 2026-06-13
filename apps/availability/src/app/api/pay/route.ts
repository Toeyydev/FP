import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { computeTotals, DEFAULT_GUIDE_FEE, type Expense, type GuideFee } from "@/lib/jobsheet";

function ops(role?: string) { return role === "OPERATOR" || role === "ADMIN"; }
const r2 = (n: number) => Math.round(n * 100) / 100;
const bkkToday = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

// Live pay breakdown for one assignment, from its job sheet (net guide fee after
// WHT + reimbursable expenses). Falls back to the standard guide fee if no sheet.
function breakdownOf(sheet: { expenses: unknown; guideFee: unknown } | undefined) {
  if (!sheet) return computeTotals([], DEFAULT_GUIDE_FEE);
  return computeTotals((sheet.expenses as Expense[]) ?? [], (sheet.guideFee as GuideFee) ?? DEFAULT_GUIDE_FEE);
}

// GET — guide: their own tours' pay + status. operator (?view=ops): all tours
// needing action across guides.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const isOps = ops(session.user.role);
  const opsView = isOps && req.nextUrl.searchParams.get("view") === "ops";

  // Only tours that have actually happened (≤ today) count as pay — never future.
  const dateFilter = { date: { lte: bkkToday() } };
  const where = opsView ? dateFilter : { guideId: session.user.guideId ?? "__none__", ...dateFilter };
  const sheetWhere = opsView ? dateFilter : { guideId: session.user.guideId ?? "__none__", ...dateFilter };
  const [assigns, sheets, payments, guides] = await Promise.all([
    prisma.assignment.findMany({ where, include: { tour: true }, orderBy: [{ date: "desc" }, { slotIdx: "asc" }], take: 400 }),
    prisma.jobSheet.findMany({ where: sheetWhere, select: { guideId: true, date: true, slotIdx: true, expenses: true, guideFee: true } }),
    prisma.tourPayment.findMany({ where: opsView ? {} : { guideId: session.user.guideId ?? "__none__" } }),
    opsView ? prisma.user.findMany({ where: { guideId: { not: null } }, select: { guideId: true, displayName: true } }) : Promise.resolve([]),
  ]);
  const sheetOf = new Map(sheets.map((s) => [`${s.guideId}|${s.date}|${s.slotIdx}`, s]));
  const payOf = new Map(payments.map((p) => [`${p.guideId}|${p.date}|${p.slotIdx}`, p]));
  const gName = (gid: string) => guides.find((g) => g.guideId === gid)?.displayName ?? gid;

  const rows = assigns.map((a) => {
    const k = `${a.guideId}|${a.date}|${a.slotIdx}`;
    const t = breakdownOf(sheetOf.get(k));
    return {
      guideId: a.guideId, guide: opsView ? gName(a.guideId) : undefined,
      date: a.date, slotIdx: a.slotIdx, tour: a.tour?.name ?? a.tourId, pax: a.pax ?? null,
      fee: r2(t.netGuideFee), expenses: r2(t.totalExpenses),
      amount: r2(t.grandTotal), status: payOf.get(k)?.status ?? "PENDING",
    };
  });
  const totals = { pending: 0, approved: 0, paid: 0 };
  for (const r of rows) { if (r.status === "PAID") totals.paid += r.amount; else if (r.status === "APPROVED") totals.approved += r.amount; else if (r.status === "CANCELLED") continue; else totals.pending += r.amount; }
  return NextResponse.json({ rows, totals: { pending: r2(totals.pending), approved: r2(totals.approved), paid: r2(totals.paid) } });
}

// POST { guideId, date, slotIdx, status } — operator sets a tour's payment state.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({ guideId: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotIdx: z.number().int().min(0), status: z.enum(["PENDING", "APPROVED", "PAID", "CANCELLED"]) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { guideId, date, slotIdx, status } = parsed.data;
  const a = await prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } });
  if (!a) return NextResponse.json({ error: "not-found" }, { status: 404 });
  const now = new Date();
  await prisma.tourPayment.upsert({
    where: { guideId_date_slotIdx: { guideId, date, slotIdx } },
    create: { guideId, date, slotIdx, tourId: a.tourId, status, approvedBy: status !== "PENDING" ? session!.user!.id : null, approvedAt: status === "APPROVED" ? now : null, paidAt: status === "PAID" ? now : null },
    update: { status, approvedBy: status !== "PENDING" ? session!.user!.id : null, approvedAt: status === "APPROVED" ? now : null, paidAt: status === "PAID" ? now : null },
  });
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: `pay.${status.toLowerCase()}`, entityType: "Assignment", detail: { guideId, date, slotIdx } });
  return NextResponse.json({ ok: true });
}

// DELETE { guideId, date, slotIdx } — remove a payment entry entirely: deletes the
// tour's payment record AND its assignment (so it leaves the pay list + schedule).
// The job sheet is kept as the financial record. Operator/admin only.
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({ guideId: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotIdx: z.number().int().min(0) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { guideId, date, slotIdx } = parsed.data;
  const where = { guideId, date, slotIdx };
  await prisma.$transaction([
    prisma.tourPayment.deleteMany({ where }),
    prisma.jobSheet.deleteMany({ where }), // also clears it from the monthly payroll
    prisma.assignment.deleteMany({ where }),
  ]);
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "pay.deleted", entityType: "Assignment", detail: { guideId, date, slotIdx } });
  return NextResponse.json({ ok: true });
}
