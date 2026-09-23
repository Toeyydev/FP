import { certificateStatuses } from "@/lib/certificates/evidence";
import { checkEvidenceBeforePaying } from "@/lib/certificates/gate";
import type { Expense as SheetExpense } from "@/lib/jobsheet";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isOps } from "@/lib/roles";
import { sendPaymentNotice } from "@/lib/jobsheet-send";
import { peakEnabled } from "@/lib/peak-api";
import {
  buildGuidePaymentDocument, createCombinedDocument, documentHoldsJobs, documentStatus, PaymentDocumentNotPostable,
  type CreateDocumentResult, type GuidePaymentDocument,
} from "@/lib/peak-payment-document";
import {
  bangkokToday, documentFigures, documentJobs, loadPaymentContext, nextPaymentRef, PaymentClaimRefused, PaymentRefTaken, prismaCreateDeps, resolvePaymentDocument,
} from "@/lib/peak-payment-server";

export const dynamic = "force-dynamic";

const bodyZ = z.object({
  guideId: z.string().min(1),
  jobs: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotIdx: z.number().int().min(0) })).min(1).max(60),
  // The jobs were already paid (a transfer made before any PEAK document existed). The
  // document is created the same way; recording its payment later only adds the EXP.
  alreadyPaid: z.boolean().optional(),
});
const keyOf = (j: { date: string; slotIdx: number }) => `${j.date}|${j.slotIdx}`;

// POST { guideId, jobs } — STAGE 1 of "Pay N jobs together · one ref".
//
// Creates ONE unpaid PEAK expense document for these jobs and returns its EXP number.
// Nothing is paid: no payment date, no Paid By account, no slip, no guide notice. The
// jobs are locked to the document (AWAITING_PAYMENT) so nothing else can pay or post
// them; the payment is recorded against this same EXP later, by
// POST /api/pay/peak-document/pay. See lib/peak-payment-document for the order and why.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const actor = { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null };
  if (!peakEnabled) return NextResponse.json({ error: "peak-not-connected", reasons: ["PEAK is not connected"] }, { status: 503 });

  const parsed = bodyZ.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { guideId, jobs } = parsed.data;
  const alreadyPaid = !!parsed.data.alreadyPaid;

  // Asked again for exactly the jobs a live document already holds (a double click, a
  // retry after a dropped connection): answer with that document. Never a second one.
  const existing = await existingDocumentFor(guideId, jobs);
  if (existing) return existing;

  // One transfer, one document. While this guide already has a document for the same
  // month that is not paid yet (or not confirmed by PEAK), a second one would split the
  // month's transfer across two documents. Pay that one, or void it and make one with
  // every job. Jobs already paid are grouped by their transfer day instead.
  if (!alreadyPaid) {
    const months = [...new Set(jobs.map((j) => j.date.slice(0, 7)))];
    const open = await prisma.guidePaymentDocument.findMany({
      where: { guideId, alreadyPaid: false, status: { in: ["CREATING", "CREATE_UNCERTAIN", "AWAITING_PAYMENT", "PAYING", "PAYMENT_UNCERTAIN", "UNCERTAIN", "POSTING"] } },
      select: { paymentRef: true, peakDocumentNo: true, status: true, jobs: true },
    });
    const sameMonth = open.filter((d) => documentJobs(d).some((j) => months.includes(String(j.date).slice(0, 7))));
    if (sameMonth.length) {
      return NextResponse.json({
        error: "open-document-this-month",
        reasons: sameMonth.map((d) => `${guideId} already has ${d.peakDocumentNo ?? d.paymentRef} (${d.paymentRef}) for ${months.join(", ")}, not paid yet — record its payment first, or void it in PEAK and mark it voided on Payments, then create ONE document with every job`),
      }, { status: 409 });
    }
  }

  const loaded = await loadPaymentContext(guideId, jobs, { alreadyPaid });
  if (!loaded.ok) return NextResponse.json({ error: "not-payable", reasons: loaded.reasons }, { status: 409 });
  const { ctx } = loaded;

  let doc: GuidePaymentDocument | null = null;
  let result: CreateDocumentResult | null = null;
  // A waiver that rests on a certificate counts only while that certificate is LINKED.
  const certs = await certificateStatuses(ctx.jobs.map((j) => (j.expenses ?? []) as SheetExpense[]));
  // Checked against Drive before a document is created, not only before it is paid: a
  // PEAK document is the company committing to a figure, and a figure that leans on a
  // certificate nobody can still verify is not one to commit to.
  const evidence = await checkEvidenceBeforePaying(
    ctx.jobs.map((j) => (j.expenses ?? []) as SheetExpense[]),
    { actorId: actor.actorId ?? null, actorRole: actor.actorRole ?? null },
    {}, "document",
  );
  if (!evidence.ok) {
    return NextResponse.json({ error: "evidence-stale", reasons: evidence.reasons, staleCertificates: evidence.stale }, { status: 409 });
  }
  const deps = prismaCreateDeps({ guideId, actor, alreadyPaid });
  // The FOLK-PAY number is a count + 1, so two documents in the same second can pick the
  // same one. The claim is the first write and fails atomically, so try the next number.
  for (let attempt = 0; attempt < 3 && !result; attempt++) {
    const paymentRef = await nextPaymentRef(bangkokToday());
    try {
      doc = buildGuidePaymentDocument({ guideId, peakContactId: ctx.peakContactId, paymentRef, jobs: ctx.jobs, accounts: ctx.accounts, createdOn: bangkokToday(), certificates: certs });
    } catch (e) {
      if (e instanceof PaymentDocumentNotPostable) return NextResponse.json({ error: "not-payable", reasons: e.reasons, missingCategories: e.missingCategories, evidenceGaps: e.evidenceGaps }, { status: 409 });
      throw e;
    }
    try {
      result = await createCombinedDocument(deps, doc);
    } catch (e) {
      if (e instanceof PaymentRefTaken) continue;
      if (e instanceof PaymentClaimRefused) return NextResponse.json({ error: "not-payable", reasons: [e.message] }, { status: 409 });
      throw e;
    }
  }
  if (!result || !doc) return NextResponse.json({ error: "busy", reasons: ["Could not reserve a payment number — try again"] }, { status: 503 });

  if (result.status === "FAILED") {
    return NextResponse.json({ error: "peak-refused", paymentRef: result.paymentRef, reasons: [result.reason] }, { status: 502 });
  }
  if (result.status === "UNCERTAIN") {
    return NextResponse.json({
      error: "peak-uncertain", paymentRef: result.paymentRef,
      reasons: [
        `PEAK did not confirm document ${result.paymentRef}: ${result.reason}`,
        `Look in PEAK for an expense with reference ${result.paymentRef} before doing anything else. The jobs stay locked until you record what you find on the Payments page.`,
      ],
    }, { status: 502 });
  }
  return NextResponse.json({
    ok: true, status: "AWAITING_PAYMENT",
    paymentRef: result.paymentRef, documentNo: result.documentNo, documentId: result.documentId, documentLink: result.documentLink,
    gross: result.gross, wht: result.wht, total: result.total, lineCount: result.lines, issuedDate: doc.issuedDate,
    jobs: doc.jobs, lines: doc.traces, recordError: result.recordError,
    alreadyPaid, paidDate: ctx.paidDate,
  });
}

/** The live document that already holds exactly these jobs, as a stage-1 answer. */
async function existingDocumentFor(guideId: string, jobs: { date: string; slotIdx: number }[]) {
  const pays = await prisma.tourPayment.findMany({ where: { guideId, OR: jobs.map((j) => ({ date: j.date, slotIdx: j.slotIdx })) }, select: { date: true, slotIdx: true, peakPaymentRef: true } });
  const refs = [...new Set(pays.map((p) => p.peakPaymentRef).filter((r): r is string => !!r))];
  if (refs.length !== 1 || pays.filter((p) => p.peakPaymentRef === refs[0]).length !== jobs.length) return null;
  const doc = await prisma.guidePaymentDocument.findUnique({ where: { paymentRef: refs[0] } });
  if (!doc || doc.guideId !== guideId || !documentHoldsJobs(doc.status)) return null;
  const held = documentJobs(doc);
  const same = held.length === jobs.length && jobs.every((j) => held.some((h) => keyOf(h) === keyOf(j)));
  if (!same) return null;
  const f = documentFigures(doc);
  const st = documentStatus(doc.status);
  return NextResponse.json({
    ok: st === "AWAITING_PAYMENT" || st === "PAID", existing: true, status: st,
    paymentRef: doc.paymentRef, documentNo: doc.peakDocumentNo, documentId: doc.peakDocumentId, documentLink: doc.peakDocumentLink,
    gross: f.gross, wht: f.wht, total: f.net, lineCount: f.lines, jobs: held, alreadyPaid: doc.alreadyPaid,
    reasons: st === "AWAITING_PAYMENT" || st === "PAID" ? [] : [`${doc.paymentRef} already holds these jobs and is ${String(st).toLowerCase().replace(/_/g, " ")} — settle it on the Payments page`],
  }, { status: st === "AWAITING_PAYMENT" || st === "PAID" ? 200 : 409 });
}

const resolveZ = z.discriminatedUnion("resolution", [
  z.object({ paymentRef: z.string().min(1).max(40), resolution: z.literal("found"), documentNo: z.string().min(1).max(40) }),
  z.object({ paymentRef: z.string().min(1).max(40), resolution: z.literal("not-found") }),
  z.object({ paymentRef: z.string().min(1).max(40), resolution: z.literal("payment-found") }),
  z.object({ paymentRef: z.string().min(1).max(40), resolution: z.literal("payment-not-found") }),
  z.object({ paymentRef: z.string().min(1).max(40), resolution: z.literal("voided") }),
]);

// PATCH { paymentRef, resolution } — a person records what only PEAK can say, for a
// document or payment PEAK did not confirm, or a document voided in PEAK.
// Operator/admin only, audited. See resolvePaymentDocument.
export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = resolveZ.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { paymentRef, ...resolution } = parsed.data;
  const r = await resolvePaymentDocument(paymentRef, resolution, { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  // A payment confirmed by hand is still a payment the guide should hear about — once.
  if (r.notify) { try { await sendPaymentNotice(r.notify.guideId, r.notify.jobs, undefined, r.notify.slipUrl ?? undefined); } catch { /* best-effort */ } }
  return NextResponse.json({ ok: true });
}
