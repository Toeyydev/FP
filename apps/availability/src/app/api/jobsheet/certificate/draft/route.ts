import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { denied } from "@/lib/certificates/denied";
import type { Expense } from "@/lib/jobsheet";
import { buildPayload, certifiableRows, duplicateIdentities, ineligibleRows, payloadHash } from "@/lib/certificates/payload";
import { renderCertificateHtml } from "@/lib/certificates/document";
import { pdfRendererAvailable, renderPdf } from "@/lib/certificates/pdf";
import { defaultSource, isExpenseSource, sourceRefusal, type ExpenseSource } from "@/lib/certificates/source";

export const dynamic = "force-dynamic";

// A draft of the certificate, as a PDF, before anything exists.
//
// The point is to let somebody read the document they are about to put their name to.
// Describing it on a screen is not the same thing: the wording, the rows, the total and
// the sentence about where the figures came from are what will be printed, and the only
// honest preview of a printed page is the printed page.
//
// So it is the SAME renderer and the same template as the real document, with one
// difference that cannot be missed — a watermark on every page. The failure this is
// built against is a draft being filed as though it were the real thing, which no amount
// of "it says draft in the corner" prevents once it is out of the tab it was opened in.
//
// This endpoint changes nothing. It creates no ExpenseCertificate, writes no audit row,
// uploads nothing to Drive, edits no job sheet, links no waiver and calls no accounting
// system. It reads the job sheet as it is stored on the server and renders it. Every
// figure comes from the database, never from the request — a preview built from numbers
// the browser supplied would be a preview of nothing.

const query = z.object({
  guideId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  slotIdx: z.coerce.number().int().min(0),
  source: z.string().optional(),
});

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!isAdmin(session?.user?.role)) {
    await denied(session, "certificate.draft");
    return NextResponse.json({ error: "forbidden", reasons: ["Only an admin can preview a certificate in lieu of a receipt"] }, { status: 403 });
  }
  const parsed = query.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: "bad-query" }, { status: 400 });
  const { guideId, date, slotIdx } = parsed.data;

  const sheet = await prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } } });
  if (!sheet) return NextResponse.json({ error: "not-found", reasons: ["ไม่พบใบงานนี้"] }, { status: 404 });

  // The source is the one thing the caller chooses, and it is an enum — a name, a time
  // or a person's identity arriving from a browser would be a claim about somebody, made
  // by whoever could type a URL.
  const asked = parsed.data.source;
  if (asked !== undefined && !isExpenseSource(asked)) {
    return NextResponse.json({ error: "bad-query", reasons: ["ที่มาของรายการไม่ถูกต้อง"] }, { status: 400 });
  }
  const source: ExpenseSource = asked ?? defaultSource(sheet);
  const badSource = sourceRefusal(source, sheet);
  if (badSource) return NextResponse.json({ error: "not-allowed", reasons: [badSource] }, { status: 409 });

  // A draft may be read without the guide having filed anything — that is the case it
  // exists for. What it still needs is rows it can speak for, and rows it can tell apart.
  const expenses = (sheet.expenses as unknown as Expense[]) ?? [];
  const rows = certifiableRows(expenses);
  const blockers = [...ineligibleRows(expenses), ...duplicateIdentities(rows, expenses)];
  if (!rows.length) {
    blockers.push("ไม่มีรายการใดในใบงานนี้ที่ต้องใช้ใบรับรองแทนใบเสร็จ — ทุกแถวมีใบเสร็จแล้ว หรือไม่ใช่เงินที่ไกด์สำรองจ่าย");
  }
  if (blockers.length) return NextResponse.json({ error: "not-allowed", reasons: blockers }, { status: 409 });

  if (!pdfRendererAvailable()) {
    return NextResponse.json({ error: "no-renderer", reasons: ["ระบบสร้าง PDF ยังไม่พร้อมใช้งานบนเครื่องนี้"] }, { status: 503 });
  }

  const guide = await prisma.user.findFirst({ where: { guideId: sheet.guideId }, select: { fullName: true, displayName: true } });
  // Who WOULD be recorded, taken from the session. A draft says what will happen, not
  // that it has: there is no recording time, because nothing has been recorded.
  const recordedBy = source === "ADMIN_RECORDED"
    ? {
        id: session!.user!.id ?? "",
        name: (session!.user!.name || (session!.user as { displayName?: string }).displayName || session!.user!.id || "").toString(),
        role: session!.user!.role ?? "",
        at: "",
      }
    : null;

  const payload = buildPayload(
    { jobRef: sheet.ref, tourDate: sheet.date, slotIdx: sheet.slotIdx, guideId: sheet.guideId,
      guideName: (guide?.fullName || guide?.displayName || sheet.guideId).trim(),
      // The fact, not a function of the chosen source: it is what decides which
      // admin-recorded sentence is true.
      guideReportedAt: sheet.guideExpensesAt },
    rows, null, { source, recordedBy },
  );

  const html = renderCertificateHtml({
    // A draft has no number of its own. Showing one would be showing a reference that
    // will not exist if this is never issued, or will differ if it is.
    certificateNo: `(ร่าง) ${sheet.ref ?? `${sheet.date}-${sheet.slotIdx}`}`,
    payload,
    payloadHash: payloadHash(payload),
    attestedByName: "", attestedByRole: "", attestedAt: "", auditRef: "",
    draft: true,
  });

  const bytes = await renderPdf(html);
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-length": String(bytes.length),
      // Opens in a tab to be read, rather than landing in a downloads folder where a
      // draft is one rename away from looking like a filed document.
      "content-disposition": `inline; filename="draft-certificate.pdf"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
