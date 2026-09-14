import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { computeTotals, DEFAULT_GUIDE_FEE, type Expense, type GuideFee } from "@/lib/jobsheet";
import { guidePayoutTotal } from "@/lib/peak-sync";
import { canViewFinance } from "@/lib/roles";
import { type Slip } from "@/lib/payments/slips";
import { coveredByPayrollRun } from "@/lib/payment-coverage";
import { paymentDocumentLocksInMonth } from "@/lib/peak-payment-server";
import { combinedPaymentBlock, type CombinedBlock } from "@/lib/combined-payment";
import { documentStatus } from "@/lib/peak-payment-document";
import { hasHistoricalJobSheet, historicalDeleteConflict, isRestrictViolation } from "@/lib/historical-guard";

function ops(role?: string) { return role === "OPERATOR" || role === "ADMIN"; }
const thisMonth = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
const bkkToday = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

// GET ?period=YYYY-MM — payroll per guide for the month, computed live from job
// sheets (net fee after WHT + reimbursable expenses), joined with paid status.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const period = /^\d{4}-\d{2}$/.test(req.nextUrl.searchParams.get("period") || "") ? req.nextUrl.searchParams.get("period")! : thisMonth();

  // Cap the month at today so future (not-yet-done) tours don't count as earned.
  const monthEnd = `${period}-31`;
  const cap = bkkToday() < monthEnd ? bkkToday() : monthEnd;
  const [assigns, sheets, statuses, guides, tours, tourPays] = await Promise.all([
    prisma.assignment.findMany({ where: { date: { gte: `${period}-01`, lte: cap } }, select: { guideId: true, date: true, slotIdx: true, tourId: true, createdAt: true } }),
    prisma.jobSheet.findMany({ where: { date: { gte: `${period}-01`, lte: `${period}-31` } }, select: { guideId: true, date: true, slotIdx: true, tourId: true, ref: true, expenses: true, guideFee: true, createdAt: true, origin: true, peakDocumentNo: true, peakDocumentId: true, approvalStatus: true } }),
    prisma.payrollStatus.findMany({ where: { period } }),
    prisma.user.findMany({ where: { guideId: { not: null } }, select: { guideId: true, displayName: true } }),
    prisma.tour.findMany({ select: { id: true, name: true } }),
    prisma.tourPayment.findMany({ where: { date: { gte: `${period}-01`, lte: `${period}-31` } }, select: { guideId: true, date: true, slotIdx: true, status: true, peakRef: true, paidAt: true, eslipUrl: true, slips: true, peakPaymentRef: true } }),
  ]);

  const gName = (gid: string) => guides.find((g) => g.guideId === gid)?.displayName ?? gid;
  const tName = (id: string) => tours.find((t) => t.id === id)?.name ?? id;
  const statusOf = (gid: string) => statuses.find((s) => s.guideId === gid);
  const sheetOf = new Map(sheets.map((s) => [`${s.guideId}|${s.date}|${s.slotIdx}`, s]));
  const payStatusOf = new Map(tourPays.map((p) => [`${p.guideId}|${p.date}|${p.slotIdx}`, p.status]));
  const peakRefOf = new Map(tourPays.map((p) => [`${p.guideId}|${p.date}|${p.slotIdx}`, p.peakRef]));
  const paidAtOf = new Map(tourPays.map((p) => [`${p.guideId}|${p.date}|${p.slotIdx}`, p.paidAt]));
  const eslipUrlOf = new Map(tourPays.map((p) => [`${p.guideId}|${p.date}|${p.slotIdx}`, p.eslipUrl]));
  const slipsOf = new Map(tourPays.map((p) => [`${p.guideId}|${p.date}|${p.slotIdx}`, (Array.isArray(p.slips) ? p.slips : null) as Slip[] | null]));
  // The combined PEAK payment document a job was paid in (or is waiting on).
  const payRefOf = new Map(tourPays.map((p) => [`${p.guideId}|${p.date}|${p.slotIdx}`, p.peakPaymentRef]));
  const tourPayOf = new Map(tourPays.map((p) => [`${p.guideId}|${p.date}|${p.slotIdx}`, p]));
  // Every combined PEAK document this month's jobs are locked to — created and awaiting
  // payment, paid, or waiting on someone to check PEAK.
  const docRefs = [...new Set(tourPays.map((p) => p.peakPaymentRef).filter((r): r is string => !!r))];
  const paymentDocs = docRefs.length
    ? await prisma.guidePaymentDocument.findMany({
        where: { paymentRef: { in: docRefs } },
        select: { paymentRef: true, guideId: true, status: true, error: true, total: true, jobs: true, lines: true, paymentDate: true, paymentMethodName: true, peakDocumentNo: true, peakDocumentLink: true, slipUrl: true, attachmentStatus: true, attachmentError: true, createdAt: true, updatedAt: true },
      })
    : [];
  const docOf = new Map(paymentDocs.map((d) => [d.paymentRef, d]));
  // Whether the job can go into "Pay N jobs together · one ref" — the same rule the
  // preview and the post refuse with, so the count on this page is the count the
  // server will accept. A job whose sheet already posted its own PEAK document stays
  // listed, but is not offered.
  const combinedOf = (k: string, s: (typeof sheets)[number] | undefined, covered: boolean, date: string) => {
    const tp = tourPayOf.get(k);
    const combinedBlock: CombinedBlock | null = combinedPaymentBlock({ sheet: s ?? null, payment: tp ? { ...tp, document: tp.peakPaymentRef ? docOf.get(tp.peakPaymentRef) ?? null : null } : null, coveredByPayroll: covered, period: date.slice(0, 7) });
    return { combinable: !combinedBlock, combinedBlock, sheetPeakDocumentNo: (s?.peakDocumentNo ?? "").trim() || null };
  };
  const r2 = (n: number) => Math.round(n * 100) / 100;
  // An auto-created sheet can have an empty guideFee ({}); ?? won't catch that, so a
  // missing price must fall back to the standard fee or the guide shows ฿0 unpaid.
  const gfOf = (gf: unknown): GuideFee => (gf && typeof gf === "object" && (gf as GuideFee).price != null ? (gf as GuideFee) : DEFAULT_GUIDE_FEE);
  // A whole-month "paid" covers a tour only if BOTH: the tour had already happened by
  // the payment date (a payment can't cover a tour that runs later — the paid-before-
  // tour bug), AND its record existed when the payment was made (a tour re-imported
  // after the payment correctly shows unpaid again, not silently swept into "Paid").
  const coveredByMonth = (gid: string, tourDate: string, recordCreatedAt: Date) =>
    coveredByPayrollRun(statusOf(gid), tourDate, recordCreatedAt);

  type Job = { date: string; slotIdx: number; tour: string; ref: string | null; amount: number; paid: boolean; payStatus: string; peakRef: string | null; paidAt: Date | null; eslipUrl: string | null; slips: Slip[] | null; peakPaymentRef: string | null; fee: number; expenses: number; combinable: boolean; combinedBlock: CombinedBlock | null; sheetPeakDocumentNo: string | null };
  // Every tour the guide was assigned counts — using its saved job sheet if there
  // is one, otherwise the standard guide fee (no sheet = base pay, no expenses).
  const byGuide: Record<string, { guideId: string; guide: string; tours: number; netFee: number; expenses: number; payout: number; jobs: Job[] }> = {};
  for (const a of assigns) {
    const k = `${a.guideId}|${a.date}|${a.slotIdx}`;
    const s = sheetOf.get(k);
    const t = s
      ? computeTotals((s.expenses as unknown as Expense[]) ?? [], gfOf(s.guideFee))
      : computeTotals([], DEFAULT_GUIDE_FEE);
    // What we actually transfer: expenses the company already settled (advance or
    // paid direct) are excluded, untagged rows are not — see lib/peak-sync.
    const p = s
      ? guidePayoutTotal((s.expenses as unknown as Expense[]) ?? [], gfOf(s.guideFee))
      : guidePayoutTotal([], DEFAULT_GUIDE_FEE);
    const g = (byGuide[a.guideId] ??= { guideId: a.guideId, guide: gName(a.guideId), tours: 0, netFee: 0, expenses: 0, payout: 0, jobs: [] });
    g.tours += 1; g.netFee += t.netGuideFee; g.expenses += p.payoutExpenses; g.payout += p.payout;
    const covered = coveredByMonth(a.guideId, a.date, a.createdAt);
    const ps = payStatusOf.get(k) ?? "PENDING";
    g.jobs.push({ date: a.date, slotIdx: a.slotIdx, tour: tName(a.tourId), ref: s?.ref ?? null, amount: r2(p.payout), paid: covered || ps === "PAID", payStatus: covered ? "PAID" : ps, peakRef: peakRefOf.get(k) ?? null, paidAt: paidAtOf.get(k) ?? null, eslipUrl: eslipUrlOf.get(k) ?? (covered ? statusOf(a.guideId)?.eslipUrl ?? null : null), slips: slipsOf.get(k) ?? null, peakPaymentRef: payRefOf.get(k) ?? null, fee: r2(t.netGuideFee), expenses: r2(p.payoutExpenses), ...combinedOf(k, s, covered, a.date) });
  }

  // Imported / orphan job sheets — a sheet exists but no assignment row (e.g. a
  // manually-imported past tour, or one created from a no-show review). It's still
  // real work the guide is owed, so include it on Payments.
  const assignKeys = new Set(assigns.map((a) => `${a.guideId}|${a.date}|${a.slotIdx}`));
  for (const s of sheets) {
    const k = `${s.guideId}|${s.date}|${s.slotIdx}`;
    if (assignKeys.has(k)) continue;       // already counted via its assignment
    if (s.date > cap) continue;            // future tour, not yet earned
    const t = computeTotals((s.expenses as unknown as Expense[]) ?? [], gfOf(s.guideFee));
    const p = guidePayoutTotal((s.expenses as unknown as Expense[]) ?? [], gfOf(s.guideFee));
    const g = (byGuide[s.guideId] ??= { guideId: s.guideId, guide: gName(s.guideId), tours: 0, netFee: 0, expenses: 0, payout: 0, jobs: [] });
    g.tours += 1; g.netFee += t.netGuideFee; g.expenses += p.payoutExpenses; g.payout += p.payout;
    const covered = coveredByMonth(s.guideId, s.date, s.createdAt);
    const ps = payStatusOf.get(k) ?? "PENDING";
    g.jobs.push({ date: s.date, slotIdx: s.slotIdx, tour: tName(s.tourId), ref: s.ref ?? null, amount: r2(p.payout), paid: covered || ps === "PAID", payStatus: covered ? "PAID" : ps, peakRef: peakRefOf.get(k) ?? null, paidAt: paidAtOf.get(k) ?? null, eslipUrl: eslipUrlOf.get(k) ?? (covered ? statusOf(s.guideId)?.eslipUrl ?? null : null), slips: slipsOf.get(k) ?? null, peakPaymentRef: payRefOf.get(k) ?? null, fee: r2(t.netGuideFee), expenses: r2(p.payoutExpenses), ...combinedOf(k, s, covered, s.date) });
  }

  const rows = Object.values(byGuide)
    .map((g) => ({ ...g, netFee: r2(g.netFee), expenses: r2(g.expenses), payout: r2(g.payout), jobs: g.jobs.sort((a, b) => a.date.localeCompare(b.date) || a.slotIdx - b.slotIdx), status: statusOf(g.guideId)?.status ?? "pending", paidAt: statusOf(g.guideId)?.paidAt ?? null, eslipUrl: statusOf(g.guideId)?.eslipUrl ?? null, peakRef: statusOf(g.guideId)?.peakRef ?? null }))
    .sort((a, b) => a.guide.localeCompare(b.guide));

  const totals = rows.reduce((s, r) => ({ tours: s.tours + r.tours, netFee: s.netFee + r.netFee, expenses: s.expenses + r.expenses, payout: s.payout + r.payout }), { tours: 0, netFee: 0, expenses: 0, payout: 0 });
  // The documents, with their state read the two-stage way and their figures as created
  // (gross, withholding, line count) so the page can show what awaits payment.
  const docsOut = paymentDocs.map(({ lines, ...d }) => {
    const traces = (Array.isArray(lines) ? lines : []) as { price?: number; wht?: number }[];
    const gross = Math.round(traces.reduce((a, t) => a + (Number(t.price) || 0), 0) * 100) / 100;
    const wht = Math.round(traces.reduce((a, t) => a + (Number(t.wht) || 0), 0) * 100) / 100;
    return { ...d, status: documentStatus(d.status) ?? d.status, gross, wht, lineCount: traces.length };
  });
  return NextResponse.json({ period, rows, totals, paymentDocs: docsOut });
}

// POST { period, guideId, status } — mark a guide's payroll paid / pending.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/), guideId: z.string().min(1), status: z.enum(["pending", "paid"]) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { period, guideId, status } = parsed.data;
  await prisma.payrollStatus.upsert({
    where: { guideId_period: { guideId, period } },
    create: { guideId, period, status, paidAt: status === "paid" ? new Date() : null },
    update: { status, paidAt: status === "paid" ? new Date() : null },
  });
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "payroll.marked", entityType: "PayrollStatus", detail: { period, guideId, status } });
  return NextResponse.json({ ok: true });
}

// PATCH { period, guideId, peakRef } — set the PEAK accounting ref for a guide's
// combined monthly payout (one bank transfer covering several job sheets).
export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/), guideId: z.string().min(1), peakRef: z.string().max(60) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { period, guideId } = parsed.data;
  const peakRef = parsed.data.peakRef.trim() || null;
  await prisma.payrollStatus.upsert({
    where: { guideId_period: { guideId, period } },
    create: { guideId, period, peakRef },
    update: { peakRef },
  });
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "payroll.peakref", entityType: "PayrollStatus", detail: { period, guideId, peakRef } });
  return NextResponse.json({ ok: true });
}

// DELETE { period, guideId } — remove a guide's pay for the month: deletes their
// job sheets (the pay source) + per-tour payments + paid status for that period,
// so the payroll row goes away. Tour assignments/history are kept. Operator only.
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/), guideId: z.string().min(1) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { period, guideId } = parsed.data;
  const where = { guideId, date: { gte: `${period}-01`, lte: `${period}-31` } };
  // Deleting a job PEAK holds a payment line for would leave that line pointing at nothing.
  const locks = await paymentDocumentLocksInMonth(guideId, period);
  if (locks.length) return NextResponse.json({ error: "payment-document-lock", reasons: locks, detail: locks.join("\n") }, { status: 409 });
  // Imported bookings for this guide's tours must go too, or the Bookings Inbox
  // re-creates the jobs on the next sync and the payroll row reappears (the same
  // "won't stay deleted" bug fixed for the per-job delete). Find the guide's slots
  // for the month, then take only the bookings they OWN: on a split slot (any
  // booking there tagged to a guide) that's just their tagged bookings — never the
  // co-guide's — mirroring the job-sheet split rule; on a normal slot the whole
  // slot is theirs. Snapshot into the audit trail first (they feed PEAK accounting).
  type SlotBooking = { id: string; source: string; externalRef: string | null; confirmationCode: string | null; customerName: string | null; pax: number | null; status: string; paymentStatus: string; date: string | null; slotIdx: number | null; assignedGuideId: string | null };
  const [aSlots, sSlots] = await Promise.all([
    prisma.assignment.findMany({ where, select: { date: true, slotIdx: true } }),
    prisma.jobSheet.findMany({ where, select: { date: true, slotIdx: true } }),
  ]);
  const slots = [...new Set([...aSlots, ...sSlots].map((s) => `${s.date}|${s.slotIdx}`))].map((k) => { const [d, si] = k.split("|"); return { date: d, slotIdx: Number(si) }; });
  const atSlots: SlotBooking[] = slots.length
    ? await prisma.booking.findMany({ where: { OR: slots }, select: { id: true, source: true, externalRef: true, confirmationCode: true, customerName: true, pax: true, status: true, paymentStatus: true, date: true, slotIdx: true, assignedGuideId: true } })
    : [];
  const bySlot = new Map<string, SlotBooking[]>();
  for (const b of atSlots) { const k = `${b.date}|${b.slotIdx}`; const a = bySlot.get(k) ?? []; a.push(b); bySlot.set(k, a); }
  const deletedBookings: SlotBooking[] = [];
  for (const list of bySlot.values()) {
    const split = list.some((b) => b.assignedGuideId);
    for (const b of list) if (!split || b.assignedGuideId === guideId) deletedBookings.push(b);
  }
  const doomedIds = deletedBookings.map((b) => b.id);
  if (await hasHistoricalJobSheet(where)) {
    const c = historicalDeleteConflict();
    return NextResponse.json(c.body, { status: c.status });
  }
  await prisma.$transaction([
    prisma.jobSheet.deleteMany({ where }),
    prisma.tourPayment.deleteMany({ where }),
    prisma.checkin.deleteMany({ where }),
    prisma.tourReport.deleteMany({ where }),
    prisma.guideRating.deleteMany({ where }),
    prisma.assignment.deleteMany({ where }),
    prisma.payrollStatus.deleteMany({ where: { guideId, period } }),
    ...(doomedIds.length ? [prisma.booking.deleteMany({ where: { id: { in: doomedIds } } })] : []),
  ]);
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "payroll.deleted", entityType: "PayrollStatus", detail: { period, guideId, deletedBookings } });
  return NextResponse.json({ ok: true });
}
