import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { isOps } from "@/lib/roles";
import { peakEnabled } from "@/lib/peak-api";
import { buildGuidePaymentDocument, PaymentDocumentNotPostable, type MissingCategoryRow } from "@/lib/peak-payment-document";
import { loadPaymentContext } from "@/lib/peak-payment-server";

export const dynamic = "force-dynamic";

const bodyZ = z.object({
  guideId: z.string().min(1),
  jobs: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotIdx: z.number().int().min(0) })).min(1).max(60),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

// POST { guideId, jobs, paymentDate } — the PEAK document "Pay N jobs together" would
// create, line by line, or every reason it cannot. Writes nothing, calls no PEAK
// endpoint, uploads nothing: the operator sees the document before choosing a slip.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = bodyZ.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { guideId, jobs, paymentDate } = parsed.data;

  const reasons: string[] = [];
  if (!peakEnabled) reasons.push("PEAK is not connected");
  const loaded = await loadPaymentContext(guideId, jobs);
  if (!loaded.ok) reasons.push(...loaded.reasons);
  const { ctx } = loaded;

  // Build even when a job was refused, over every job whose rows could still go into
  // this document — the payable ones and any only waiting on approval — so every row to
  // fix (a missing category above all) is listed at once, not one refusal per click.
  // Pure: this builds a payload in memory and sends it nowhere.
  const candidates = loaded.ok ? ctx.jobs : [...ctx.jobs, ...ctx.awaitingApproval];
  let missingCategories: MissingCategoryRow[] = [];
  try {
    if (!candidates.length) return NextResponse.json({ ok: false, reasons, missingCategories });
    const doc = buildGuidePaymentDocument({
      guideId, peakContactId: ctx.peakContactId,
      // Neither is known yet: the number is assigned when the payment is made, and the
      // Paid By account is chosen in the same dialog. Neither changes a line.
      paymentRef: "FOLK-PAY-(assigned when paid)", paymentMethodId: "preview",
      paymentDate, jobs: candidates, accounts: ctx.accounts,
    });
    if (reasons.length) return NextResponse.json({ ok: false, reasons, missingCategories });
    return NextResponse.json({ ok: true, lines: doc.traces, gross: doc.gross, wht: doc.wht, total: doc.total, jobs: doc.jobs, issuedDate: doc.issuedDate });
  } catch (e) {
    if (!(e instanceof PaymentDocumentNotPostable)) throw e;
    missingCategories = e.missingCategories;
    return NextResponse.json({ ok: false, reasons: [...new Set([...reasons, ...e.reasons])], missingCategories });
  }
}
