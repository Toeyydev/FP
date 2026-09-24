import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import type { Expense } from "@/lib/jobsheet";
import { certifiableRows, duplicateIdentities, ineligibleRows } from "@/lib/certificates/payload";
import { LABEL, LABEL_TH, type CertificateState } from "@/lib/certificates/state";
import { CertificateRefused, createCertificate, type Actor } from "@/lib/certificates/service";
import { denied } from "@/lib/certificates/denied";
import { certificatePeakView } from "@/lib/certificates/peak-link";
import { attachEnabled } from "@/lib/certificates/peak-attach";
import { computeTotals, DEFAULT_GUIDE_FEE, type GuideFee } from "@/lib/jobsheet";
import { guidePayoutTotal } from "@/lib/peak-sync";

export const dynamic = "force-dynamic";

// Certificates in lieu of receipts, for one job sheet.
//
// GET  — what the sheet has, and what a new certificate would cover
// POST — issue a draft, ready for someone to certify
//
// The attester's identity is never in a request body. It is read from the session, here
// and at every later step, so a browser cannot name somebody else as the approver.

const key = z.object({
  guideId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  slotIdx: z.coerce.number().int().min(0),
});

const actorOf = (s: { user?: { id?: string | null; name?: string | null; displayName?: string | null; role?: string | null } } | null): Actor => ({
  id: s?.user?.id ?? "",
  name: (s?.user?.name || s?.user?.displayName || s?.user?.id || "").toString(),
  role: s?.user?.role ?? "",
});

export async function GET(req: NextRequest) {
  const session = await auth();
  // ADMIN, not canViewFinance. This response carries certificate numbers, hashes, Drive
  // links and the attester's name — the whole of what the rule says only an admin sees.
  // An operator who can edit the sheet still gets 403 here.
  if (!isAdmin(session?.user?.role)) {
    await denied(session, "certificate.list", { guideId: req.nextUrl.searchParams.get("guideId") });
    return NextResponse.json({ error: "forbidden", reasons: ["Only an admin can see certificates in lieu of receipts"] }, { status: 403 });
  }
  const parsed = key.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: "bad-query" }, { status: 400 });

  const sheet = await prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: parsed.data } });
  if (!sheet) return NextResponse.json({ error: "not-found" }, { status: 404 });

  const expenses = (sheet.expenses as unknown as Expense[]) ?? [];
  const rows = certifiableRows(expenses);
  const certificates = await prisma.expenseCertificate.findMany({
    where: { jobSheetId: sheet.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, certificateNo: true, status: true, totalSatang: true, payloadHash: true, pdfHash: true,
      driveUrl: true, attestedByName: true, attestedByRole: true, attestedAt: true, uploadedAt: true, linkedAt: true,
      voidedAt: true, voidReason: true, coveredRows: true, createdAt: true,
      guideId: true, tourDate: true, slotIdx: true,
      peakPaymentRef: true, peakDocumentNo: true, peakDocumentId: true, peakDocumentLink: true,
      peakDocumentSource: true, peakPaidDate: true, peakLinkedAt: true,
      attachments: {
        select: { id: true, state: true, requestEncoding: true, peakResCode: true, peakResDesc: true,
          attemptedAt: true, resolvedById: true, resolvedAt: true, resolutionNote: true, peakDocumentNo: true, fileName: true },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  // Which PEAK document each certificate accompanies. Recorded when the EXP was created;
  // resolved live in the meantime, so a certificate issued first still reads correctly.
  const peak = await Promise.all(certificates.map((c) => certificatePeakView(c)));

  // Why a new one could not be issued right now, in the operator's words.
  const blockers: string[] = [];
  if (!sheet.guideExpensesAt) blockers.push("The guide has not filed an expense report from their own account for this job yet.");
  blockers.push(...ineligibleRows(expenses), ...duplicateIdentities(rows, expenses));
  if (certificates.some((c) => c.status !== "VOID")) blockers.push("This job sheet already has a certificate. Withdraw it first if it needs replacing.");

  return NextResponse.json({
    ok: true,
    jobRef: sheet.ref,
    guideReportedAt: sheet.guideExpensesAt,
    rowsNeedingCertificate: rows,
    totalSatang: rows.reduce((t, r) => t + r.amountSatang, 0),
    canIssue: rows.length > 0 && blockers.length === 0,
    blockers,
    certificates: certificates.map((c, i) => ({
      ...c,
      label: LABEL[c.status as CertificateState] ?? c.status,
      labelTh: LABEL_TH[c.status as CertificateState] ?? c.status,
      isEvidence: c.status === "LINKED",
      peak: peak[i],
    })),
    attachEnabled: attachEnabled(),
    // What the whole job is worth, so an admin can reconcile the certificate against the
    // EXP without leaving the page.
    //
    // Deliberately NOT part of the certificate and labelled as such on screen. The
    // certificate covers unreceipted reimbursement only; these are the fee, the review
    // reward and the withholding that share its EXP and must never appear on its PDF.
    reconciliation: (() => {
      const fee = (sheet.guideFee as unknown as GuideFee) ?? DEFAULT_GUIDE_FEE;
      const t = computeTotals(expenses, fee);
      return {
        guideFeeGross: t.gross,
        reviewReward: t.reviewReward,
        whtBase: t.whtBase,
        whtOnFee: t.whtOnFee,
        whtOnReview: t.whtOnReview,
        wht: t.wht,
        reimbursementTotal: t.totalExpenses - t.reviewReward,
        netTransfer: guidePayoutTotal(expenses, fee).payout,
        certificateCoversSatang: rows.reduce((s, r) => s + r.amountSatang, 0),
      };
    })(),
  });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isAdmin(session?.user?.role)) {
    await denied(session, "certificate.issue", {});
    return NextResponse.json({ error: "forbidden", reasons: ["Only an admin can issue a certificate in lieu of a receipt"] }, { status: 403 });
  }
  const parsed = key.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body", reasons: parsed.error.issues.map((i) => i.message) }, { status: 400 });

  try {
    const cert = await createCertificate(parsed.data, actorOf(session));
    return NextResponse.json({ ok: true, certificate: { id: cert.id, certificateNo: cert.certificateNo, status: cert.status, totalSatang: cert.totalSatang, payloadHash: cert.payloadHash } });
  } catch (e) {
    if (e instanceof CertificateRefused) return NextResponse.json({ error: "not-allowed", reasons: e.reasons, detail: e.reasons.join("\n") }, { status: e.status });
    throw e;
  }
}
