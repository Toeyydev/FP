import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { canViewFinance } from "@/lib/roles";
import { SLOT_TIMES } from "@/lib/slots";
import { type Expense } from "@/lib/jobsheet";
import { bangkokToday, jobFigures } from "@/lib/payments-v2/rules";
import { loadJobFacts } from "@/lib/payments-v2/service";

export const dynamic = "force-dynamic";

// GET ?period=YYYY-MM[&guideId=] — the jobs a guide payment could pay this month, and for
// each one the canonical reason it cannot go in. The facts come from lib/payments-v2
// (loadJobFacts + jobFigures); this route only shapes them for the screen. Eligibility here
// is guidance: POST /api/guide-payments validates again and is the authority.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const period = req.nextUrl.searchParams.get("period") ?? "";
  const onlyGuide = req.nextUrl.searchParams.get("guideId") ?? "";
  if (!/^\d{4}-\d{2}$/.test(period)) return NextResponse.json({ error: "bad-query" }, { status: 400 });

  const today = bangkokToday();
  const monthEnd = `${period}-31`;
  const cap = today < monthEnd ? today : monthEnd; // a tour that has not run yet is not payable
  const where = { date: { gte: `${period}-01`, lte: cap }, ...(onlyGuide ? { guideId: onlyGuide } : {}) };
  const [assigns, sheets, guides, tours] = await Promise.all([
    prisma.assignment.findMany({ where, select: { guideId: true, date: true, slotIdx: true, tourId: true } }),
    prisma.jobSheet.findMany({ where, select: { guideId: true, date: true, slotIdx: true, tourId: true, ref: true, expenses: true, guideFee: true, accountingDate: true, approvalStatus: true } }),
    prisma.user.findMany({ where: { guideId: { not: null } }, select: { guideId: true, displayName: true } }),
    prisma.tour.findMany({ select: { id: true, name: true } }),
  ]);
  const keyOf = (x: { guideId: string; date: string; slotIdx: number }) => `${x.guideId}|${x.date}|${x.slotIdx}`;
  const byGuide = new Map<string, { date: string; slotIdx: number }[]>();
  for (const x of [...assigns, ...sheets]) {
    const list = byGuide.get(x.guideId) ?? [];
    if (!list.some((j) => j.date === x.date && j.slotIdx === x.slotIdx)) list.push({ date: x.date, slotIdx: x.slotIdx });
    byGuide.set(x.guideId, list);
  }

  const rows: unknown[] = [];
  for (const [guideId, jobs] of byGuide) {
    const { facts } = await loadJobFacts(prisma, guideId, jobs);
    for (const f of facts) {
      const sheet = sheets.find((s) => keyOf(s) === `${guideId}|${f.date}|${f.slotIdx}`);
      const figures = jobFigures((f.sheet?.expenses as Expense[]) ?? [], f.sheet?.guideFee);
      // Written once, from canonical facts. The service refuses the same cases on record.
      const heldBy = f.payment?.peakPaymentRef ?? null;
      const blocked = f.activePaymentNo ? `Paid by ${f.activePaymentNo}`
        : f.paidByPayroll ? "Paid by the guide's monthly payroll"
        : f.payment?.status === "PAID" ? "Marked paid before payments were recorded"
        : heldBy ? `In combined PEAK document ${f.document?.peakDocumentNo ?? heldBy} — record its payment there`
        : !f.sheet ? "No job sheet"
        : !f.sheet.ref ? "The job sheet has no Job No."
        : f.sheet.approvalStatus !== "APPROVED" ? "Job sheet not approved"
        : !(figures.payable > 0) ? "Nothing to pay"
        : null;
      rows.push({
        guideId, guide: guides.find((g) => g.guideId === guideId)?.displayName ?? guideId,
        jobNo: f.sheet?.ref ?? null, date: f.date, slotIdx: f.slotIdx, time: SLOT_TIMES[f.slotIdx] ?? "",
        tour: tours.find((t) => t.id === (sheet?.tourId ?? ""))?.name ?? sheet?.tourId ?? "",
        accountingDate: (f.sheet?.accountingDate ?? "").trim() || f.date,
        accountingMonth: ((f.sheet?.accountingDate ?? "").trim() || f.date).slice(0, 7),
        feeGross: figures.feeGross, wht: figures.wht, reimbursement: figures.reimbursement, reviewReward: figures.reviewReward,
        payable: figures.payable,
        // Adjustments belong to a payment, not to a job: a candidate carries none, so the
        // amount due is its payable until the operator adds one on the payment.
        adjustments: [] as { type: string; amount: number }[],
        amountDue: figures.payable,
        readiness: !f.sheet ? "no-sheet" : f.sheet.approvalStatus === "APPROVED" ? "approved" : "not-approved",
        paymentStatus: f.activePaymentNo ? "paid" : f.payment?.status === "PAID" ? "legacy-paid" : f.paidByPayroll ? "payroll-paid" : "unpaid",
        paidBy: f.activePaymentNo ?? null,
        eligible: !blocked, blockedReason: blocked,
      });
    }
  }
  rows.sort((a, b) => {
    const x = a as { guide: string; date: string; slotIdx: number }, y = b as { guide: string; date: string; slotIdx: number };
    return x.guide.localeCompare(y.guide) || x.date.localeCompare(y.date) || x.slotIdx - y.slotIdx;
  });
  return NextResponse.json({ period, today, rows });
}
