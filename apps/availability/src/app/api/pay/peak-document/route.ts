import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { isOps } from "@/lib/roles";
import { googleDriveEnabled, folkpathsDriveToken } from "@/lib/google-drive";
import { sendPaymentNotice } from "@/lib/jobsheet-send";
import { peakEnabled } from "@/lib/peak-api";
import {
  buildGuidePaymentDocument, payJobsTogether, PaymentDocumentNotPostable, type PayTogetherResult, type GuidePaymentDocument,
} from "@/lib/peak-payment-document";
import {
  loadPaymentContext, nextPaymentRef, PaymentClaimRefused, PaymentRefTaken, prismaPayTogetherDeps, resolvePaymentDocument,
} from "@/lib/peak-payment-server";

export const dynamic = "force-dynamic";

const jobsZ = z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slotIdx: z.number().int().min(0) })).min(1).max(60);

// POST (multipart) { guideId, jobs, paymentDate, paymentMethodId, paymentMethodName?, file }
//
// "Pay N jobs together · one ref": ONE PEAK expense document for one transfer — the
// guide as the contact, one FOLK-PAY reference, one payment date, one Paid By account,
// the slip attached, and a line per job and category. The jobs are marked paid only
// after PEAK creates the document, and every one of them stores that document's number
// and id. See lib/peak-payment-document for the order and why.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const actor = { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null };
  if (!peakEnabled) return NextResponse.json({ error: "peak-not-connected", reasons: ["PEAK is not connected"] }, { status: 503 });
  if (!googleDriveEnabled) return NextResponse.json({ error: "not-configured", reasons: ["Connect Google Drive first — the slip is saved there"] }, { status: 400 });

  const form = await req.formData().catch(() => null);
  const guideId = String(form?.get("guideId") || "");
  const paymentDate = String(form?.get("paymentDate") || "");
  const paymentMethodId = String(form?.get("paymentMethodId") || "").trim();
  const paymentMethodName = String(form?.get("paymentMethodName") || "").trim().slice(0, 120) || null;
  let jobsRaw: unknown = null;
  try { jobsRaw = JSON.parse(String(form?.get("jobs") || "[]")); } catch { /* reported below */ }
  const jobs = jobsZ.safeParse(jobsRaw);
  const file = form?.get("file") as unknown as { size?: number; type?: string; arrayBuffer?: () => Promise<ArrayBuffer> } | null;
  if (!guideId || !jobs.success || !/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  if (!file || typeof file.arrayBuffer !== "function" || !(file.size ?? 0)) return NextResponse.json({ error: "no-slip", reasons: ["Attach the payment slip"] }, { status: 400 });
  if ((file.size ?? 0) > 10 * 1024 * 1024) return NextResponse.json({ error: "too-large", reasons: ["The slip is over 10 MB"] }, { status: 400 });
  const mime = file.type || "image/jpeg";
  if (!/^image\//.test(mime) && mime !== "application/pdf") return NextResponse.json({ error: "bad-file", reasons: ["The slip must be an image or a PDF"] }, { status: 400 });

  const refreshToken = await folkpathsDriveToken(actor.actorId ?? undefined);
  if (!refreshToken) return NextResponse.json({ error: "not-connected", reasons: ["Connect the Folkpaths Google account first"] }, { status: 400 });

  const loaded = await loadPaymentContext(guideId, jobs.data);
  if (!loaded.ok) return NextResponse.json({ error: "not-payable", reasons: loaded.reasons }, { status: 409 });
  const { ctx } = loaded;

  const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
  const deps = prismaPayTogetherDeps({
    guideId, guideName: ctx.guideName, paymentDate, paymentMethodId, paymentMethodName,
    file: { base64, mime }, refreshToken, actor,
  });

  let doc: GuidePaymentDocument | null = null;
  let result: PayTogetherResult | null = null;
  // The FOLK-PAY number is a count + 1, so two payments in the same second can pick the
  // same one. The claim is the first write and fails atomically, so try the next number.
  for (let attempt = 0; attempt < 3 && !result; attempt++) {
    const paymentRef = await nextPaymentRef(paymentDate);
    try {
      doc = buildGuidePaymentDocument({
        guideId, peakContactId: ctx.peakContactId, paymentRef, paymentDate, paymentMethodId, jobs: ctx.jobs, accounts: ctx.accounts,
      });
    } catch (e) {
      if (e instanceof PaymentDocumentNotPostable) return NextResponse.json({ error: "not-payable", reasons: e.reasons, missingCategories: e.missingCategories }, { status: 409 });
      throw e;
    }
    try {
      result = await payJobsTogether(deps, doc);
    } catch (e) {
      if (e instanceof PaymentRefTaken) continue;
      if (e instanceof PaymentClaimRefused) return NextResponse.json({ error: "not-payable", reasons: [e.message] }, { status: 409 });
      throw e;
    }
  }
  if (!result || !doc) return NextResponse.json({ error: "busy", reasons: ["Could not reserve a payment number — try again"] }, { status: 503 });

  if (result.status === "FAILED") {
    return NextResponse.json({ error: result.stage === "slip" ? "slip-failed" : "peak-refused", paymentRef: result.paymentRef, reasons: [result.reason] }, { status: 502 });
  }
  if (result.status === "UNCERTAIN") {
    return NextResponse.json({
      error: "peak-uncertain", paymentRef: result.paymentRef,
      reasons: [
        `PEAK did not confirm payment ${result.paymentRef}: ${result.reason}`,
        `Look in PEAK for an expense with reference ${result.paymentRef} before doing anything else. The jobs stay locked until you record what you find on the Payments page.`,
      ],
    }, { status: 502 });
  }

  // Tell the guide once the payment is real. Best-effort, as everywhere else.
  try { await sendPaymentNotice(guideId, doc.jobs.map((j) => ({ date: j.date, slotIdx: j.slotIdx })), undefined, result.slipLink); } catch { /* best-effort */ }

  return NextResponse.json({
    ok: true,
    paymentRef: result.paymentRef,
    documentNo: result.documentNo,
    documentId: result.documentId,
    documentLink: result.documentLink,
    slipLink: result.slipLink,
    total: result.total,
    lines: doc.traces,
    attachment: result.attachment,
    recordError: result.recordError,
  });
}

const resolveZ = z.discriminatedUnion("resolution", [
  z.object({ paymentRef: z.string().min(1).max(40), resolution: z.literal("found"), documentNo: z.string().min(1).max(40) }),
  z.object({ paymentRef: z.string().min(1).max(40), resolution: z.literal("not-found") }),
  z.object({ paymentRef: z.string().min(1).max(40), resolution: z.literal("voided") }),
]);

// PATCH { paymentRef, resolution: "found", documentNo } | { paymentRef, resolution: "not-found" | "voided" }
// A person records what only PEAK can say. Operator/admin only, audited.
export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = resolveZ.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { paymentRef, ...resolution } = parsed.data;
  const r = await resolvePaymentDocument(paymentRef, resolution, { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true });
}
