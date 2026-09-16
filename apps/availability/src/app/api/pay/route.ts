import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { financialHistoryBlockers } from "@/lib/payments-v2/history";
import { computeTotals, DEFAULT_GUIDE_FEE, type Expense, type GuideFee } from "@/lib/jobsheet";
import { hasHistoricalJobSheet, historicalDeleteConflict, isRestrictViolation } from "@/lib/historical-guard";
import { paymentDocumentLocks } from "@/lib/peak-payment-server";
import { normalizeExpRef, recordExpBlockers } from "@/lib/record-exp";

function ops(role?: string) { return role === "OPERATOR" || role === "ADMIN"; }
const USE_RECORD_PAYMENT = "A job becomes paid only through a recorded payment (FOLK-PMT-…): open Payments → Record payment, with the transfer date, the amount and the slip.";

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

// POST { guideId, status, peakRef?, (date,slotIdx) | jobs[] } — operator sets a tour's
// (or a batch of tours') payment state. The PEAK ref applies to the WHOLE batch — one
// transfer covering several tours — so each tour carries the ref of its own payment.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const job = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotIdx: z.number().int().min(0) });
  const parsed = z.object({
    guideId: z.string().min(1),
    status: z.enum(["PENDING", "APPROVED", "PAID", "CANCELLED"]),
    peakRef: z.string().max(60).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    slotIdx: z.number().int().min(0).optional(),
    jobs: z.array(job).max(60).optional(),
  }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { guideId, status, peakRef } = parsed.data;
  // Payments v2: nothing marks a job paid here. A payment is recorded — with its date,
  // amount, slip and reconciliation — by lib/payments-v2, and that is what pays a job.
  if (status === "PAID") return NextResponse.json({ error: "use-record-payment", reasons: [USE_RECORD_PAYMENT], detail: USE_RECORD_PAYMENT }, { status: 409 });
  const list = parsed.data.jobs?.length ? parsed.data.jobs : (parsed.data.date && parsed.data.slotIdx != null ? [{ date: parsed.data.date, slotIdx: parsed.data.slotIdx }] : []);
  if (!list.length) return NextResponse.json({ error: "no-jobs" }, { status: 400 });
  // A job paid — or being paid — in a combined PEAK payment document changes only
  // through that document, or its cost is settled twice. See lib/peak-payment-server.
  const locks = await paymentDocumentLocks(list.map((j) => ({ guideId, ...j })));
  if (locks.length) return NextResponse.json({ error: "payment-document-lock", reasons: locks, detail: locks.join("\n") }, { status: 409 });
  // A job paid by a recorded payment goes back to unpaid by reversing that payment — with
  // a reason, keeping the record. Only jobs marked paid before Payments v2 are undone here.
  //
  // Asked of GuidePaymentJob, which owns "this job is paid by this payment" — never of
  // TourPayment.guidePaymentId, which is only a cache of it and could be missing or stale.
  const held = await prisma.guidePaymentJob.findMany({
    where: { OR: list.map((j) => ({ guideId, date: j.date, slotIdx: j.slotIdx })), active: true },
    select: { date: true, slotIdx: true, jobNo: true, paymentId: true },
  });
  if (held.length) {
    const payments = await prisma.guidePayment.findMany({ where: { id: { in: [...new Set(held.map((h) => h.paymentId))] } }, select: { id: true, paymentNo: true } });
    const nameOf = (id: string) => payments.find((p) => p.id === id)?.paymentNo ?? "a recorded payment";
    const reasons = held.map((h) => `${h.jobNo || `${h.date} slot ${h.slotIdx}`} is paid by ${nameOf(h.paymentId)} — reverse that payment (with a reason) instead; the record stays.`);
    return NextResponse.json({ error: "reverse-the-payment", reasons, detail: reasons.join("\n") }, { status: 409 });
  }
  const ref = peakRef?.trim() || null;
  const now = new Date();
  const uid = session!.user!.id ?? null;
  for (const j of list) {
    const a = await prisma.assignment.findUnique({ where: { guideId_date_slotIdx: { guideId, date: j.date, slotIdx: j.slotIdx } } });
    // PAID is refused above: only a recorded payment pays a job. What is left here is
    // approving, cancelling, or putting a legacy paid job back to pending — which clears
    // the paid date and the PEAK ref that belonged to that payment.
    const data = {
      status,
      approvedBy: status !== "PENDING" ? uid : null,
      approvedAt: status === "APPROVED" ? now : null,
      paidAt: null,
      peakRef: null,
    };
    await prisma.tourPayment.upsert({
      where: { guideId_date_slotIdx: { guideId, date: j.date, slotIdx: j.slotIdx } },
      create: { guideId, date: j.date, slotIdx: j.slotIdx, tourId: a?.tourId ?? "", ...data },
      update: data,
    });
  }
  await audit({ actorId: uid, actorRole: session!.user!.role ?? null, action: `pay.${status.toLowerCase()}`, entityType: "Assignment", detail: { guideId, count: list.length, peakRef: ref } });
  return NextResponse.json({ ok: true, count: list.length });
}

// PATCH { guideId, jobs[], peakRef, confirmShared? } — record the EXP number of a PEAK
// document someone made by hand on jobs that are ALREADY PAID (lib/record-exp). Only the
// ref changes: paid state, paid date and slip stay as they are, nobody is notified, and
// nothing is sent to PEAK. A number already recorded for another guide is confirmed first.
export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const job = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotIdx: z.number().int().min(0) });
  const parsed = z.object({ guideId: z.string().min(1), jobs: z.array(job).min(1).max(60), peakRef: z.string().max(60), confirmShared: z.boolean().optional() })
    .safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { guideId, jobs } = parsed.data;
  const peakRef = normalizeExpRef(parsed.data.peakRef);
  if (!peakRef) return NextResponse.json({ error: "bad-ref", reasons: ["Enter the PEAK document number, as it appears in PEAK (EXP- and the number)"] }, { status: 400 });

  const or = jobs.map((j) => ({ guideId, date: j.date, slotIdx: j.slotIdx }));
  const [pays, sheets] = await Promise.all([
    prisma.tourPayment.findMany({ where: { OR: or }, select: { date: true, slotIdx: true, status: true, peakRef: true, peakPaymentRef: true } }),
    prisma.jobSheet.findMany({ where: { OR: or }, select: { date: true, slotIdx: true, ref: true, peakDocumentNo: true, peakSyncStatus: true } }),
  ]);
  const at = <T extends { date: string; slotIdx: number }>(list: T[], j: { date: string; slotIdx: number }) => list.find((x) => x.date === j.date && x.slotIdx === j.slotIdx) ?? null;
  const reasons = recordExpBlockers(jobs.map((j) => ({ ref: at(sheets, j)?.ref || `${j.date} slot ${j.slotIdx}`, payment: at(pays, j), sheet: at(sheets, j) })), peakRef);
  if (reasons.length) return NextResponse.json({ error: "not-allowed", reasons }, { status: 409 });

  // The same number on another guide's jobs is usually a typo — or one person under two
  // guide codes. Say who, and let the operator confirm.
  if (!parsed.data.confirmShared) {
    const [otherPays, otherSheets] = await Promise.all([
      prisma.tourPayment.findMany({ where: { peakRef: { equals: peakRef, mode: "insensitive" }, guideId: { not: guideId } }, select: { guideId: true, date: true } }),
      prisma.jobSheet.findMany({ where: { peakDocumentNo: { equals: peakRef, mode: "insensitive" }, guideId: { not: guideId } }, select: { guideId: true, date: true } }),
    ]);
    const others = [...new Set([...otherPays, ...otherSheets].map((x) => x.guideId))];
    if (others.length) return NextResponse.json({ error: "ref-used-elsewhere", guides: others, reasons: [`${peakRef} is already recorded for ${others.join(", ")}`] }, { status: 409 });
  }

  // Only the ref changes: paid date, slips and status stay, nobody is notified. The
  // conditions repeat the checks above so a change in between is not overwritten.
  const updated = await prisma.tourPayment.updateMany({ where: { AND: [{ OR: or }, { OR: [{ peakRef: null }, { peakRef: "" }, { peakRef: { equals: peakRef, mode: "insensitive" } }] }], status: "PAID", peakPaymentRef: null }, data: { peakRef } });
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "pay.peak_ref_recorded", entityType: "TourPayment", detail: { guideId, jobs, peakRef, count: updated.count, confirmShared: !!parsed.data.confirmShared } });
  return NextResponse.json({ ok: true, count: updated.count, peakRef });
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
  const locks = await paymentDocumentLocks([where]);
  if (locks.length) return NextResponse.json({ error: "payment-document-lock", reasons: locks, detail: locks.join("\n") }, { status: 409 });
  // Financial history is never deleted with a job: a payment, slip, batch, PEAK document
  // or advance on it means this is reversed or voided, not erased (lib/payments-v2/history).
  const history = await financialHistoryBlockers(prisma, [where]);
  if (history.length) return NextResponse.json({ error: "financial-history", reasons: history, detail: history.join("\n") }, { status: 409 });
  if (await hasHistoricalJobSheet(where)) {
    const c = historicalDeleteConflict();
    return NextResponse.json(c.body, { status: c.status });
  }
  await prisma.$transaction([
    prisma.tourPayment.deleteMany({ where }),
    prisma.jobSheet.deleteMany({ where }), // also clears it from the monthly payroll
    prisma.assignment.deleteMany({ where }),
  ]);
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "pay.deleted", entityType: "Assignment", detail: { guideId, date, slotIdx } });
  return NextResponse.json({ ok: true });
}
