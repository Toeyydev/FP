import { certificateStatuses } from "@/lib/certificates/evidence";
import { checkEvidenceBeforePaying } from "@/lib/certificates/gate";
import type { Expense as SheetExpense } from "@/lib/jobsheet";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { isOps } from "@/lib/roles";
import { peakEnabled } from "@/lib/peak-api";
import { buildGuidePaymentDocument, PaymentDocumentNotPostable, type MissingCategoryRow } from "@/lib/peak-payment-document";
import { loadPaymentContext } from "@/lib/peak-payment-server";
import { transferFigures } from "@/lib/payment-transfer";

export const dynamic = "force-dynamic";

const bodyZ = z.object({
  guideId: z.string().min(1),
  jobs: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotIdx: z.number().int().min(0) })).min(1).max(60),
  // Accepted for older callers and ignored: the document is created before any payment exists.
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // Jobs already paid, put into one PEAK document afterwards (lib/combined-payment paidJobPeakBlock).
  alreadyPaid: z.boolean().optional(),
});

// POST { guideId, jobs } — the unpaid PEAK expense document "Create PEAK document" would
// create, line by line, or every reason it cannot. Writes nothing, calls no PEAK
// endpoint, uploads nothing: the operator sees the document before it exists.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = bodyZ.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { guideId, jobs } = parsed.data;
  const alreadyPaid = !!parsed.data.alreadyPaid;

  const reasons: string[] = [];
  if (!peakEnabled) reasons.push("PEAK is not connected");
  const loaded = await loadPaymentContext(guideId, jobs, { alreadyPaid });
  if (!loaded.ok) reasons.push(...loaded.reasons);
  const { ctx } = loaded;

  // Build even when a job was refused, over every job whose rows could still go into
  // this document — the payable ones and any only waiting on approval — so every row to
  // fix (a missing category above all) is listed at once, not one refusal per click.
  // Pure: this builds a payload in memory and sends it nowhere.
  const candidates = loaded.ok ? ctx.jobs : [...ctx.jobs, ...ctx.awaitingApproval];
  let missingCategories: MissingCategoryRow[] = [];
  let evidenceGaps: MissingCategoryRow[] = [];
  try {
    if (!candidates.length) return NextResponse.json({ ok: false, reasons, missingCategories, evidenceGaps });
    const doc = buildGuidePaymentDocument({
      guideId, peakContactId: ctx.peakContactId,
      // The number is assigned when the document is created. It changes no line.
      paymentRef: "FOLK-PAY-(assigned when created)",
      jobs: candidates, accounts: ctx.accounts,
      // A row whose receipt was waived against a certificate is only evidenced while
      // that certificate is in force (lib/certificates/evidence).
      certificates: await certificateStatuses(candidates.map((j) => (j.expenses ?? []) as SheetExpense[])),
    });
    // The same verifier the payment uses, asked of the same folder. Only reported here —
    // a preview does not stop anybody — but reported from the file as it is right now,
    // so the figures a person is about to act on are not resting on a document that has
    // already changed. It refuses in step with the rest once receipts are enforced.
    const evidence = await checkEvidenceBeforePaying(
      candidates.map((j) => (j.expenses ?? []) as SheetExpense[]),
      { actorId: session?.user?.id ?? null, actorRole: session?.user?.role ?? null },
      {}, "preview",
    );
    // Refused whatever the flag says. This is not the receipts rule — every reason here
    // is about a document a row ALREADY names, which the system has just found is not
    // what it was. Rows with no certificate are reported through evidenceGaps as before.
    if (!evidence.ok) {
      return NextResponse.json({ ok: false, reasons: [...reasons, ...evidence.reasons], missingCategories, evidenceGaps: doc.evidenceGaps, staleCertificates: evidence.stale });
    }
    if (reasons.length) return NextResponse.json({ ok: false, reasons, missingCategories, evidenceGaps: doc.evidenceGaps });
    return NextResponse.json({
      ok: true, lines: doc.traces, gross: doc.gross, wht: doc.wht, total: doc.total, jobs: doc.jobs, issuedDate: doc.issuedDate,
      // What the operator checks before pressing Create: the whole figure, the part
      // withholding is taken on, the tax, the guide's own money coming back, and what
      // the bank will actually send.
      figures: transferFigures({ lines: doc.traces, total: doc.total }),
      // The tax split by the pay it was taken on, summed across the jobs — the screen
      // must never show one tax against the fee alone.
      whtByKind: doc.traces.reduce(
        (acc, t) => {
          const w = Number(t.wht) || 0;
          if (t.kind === "REVIEW_REWARD") acc.review = Math.round((acc.review + w) * 100) / 100;
          else acc.fee = Math.round((acc.fee + w) * 100) / 100;
          return acc;
        },
        { fee: 0, review: 0 },
      ),
      // …and the rows behind which there is no receipt, which are inside those figures
      // only while REIMBURSEMENT_EVIDENCE_REQUIRED is off.
      evidenceGaps: doc.evidenceGaps,
      ...(alreadyPaid ? { alreadyPaid, paidDate: ctx.paidDate, hasSlip: !!ctx.slipLink } : {}),
    });
  } catch (e) {
    if (!(e instanceof PaymentDocumentNotPostable)) throw e;
    missingCategories = e.missingCategories;
    evidenceGaps = e.evidenceGaps;
    return NextResponse.json({ ok: false, reasons: [...new Set([...reasons, ...e.reasons])], missingCategories, evidenceGaps });
  }
}
