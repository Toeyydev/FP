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
    },
  });

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
    certificates: certificates.map((c) => ({
      ...c,
      label: LABEL[c.status as CertificateState] ?? c.status,
      labelTh: LABEL_TH[c.status as CertificateState] ?? c.status,
      isEvidence: c.status === "LINKED",
    })),
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
