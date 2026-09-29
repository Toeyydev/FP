import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { isOps } from "@/lib/roles";
import { transferReadiness } from "@/lib/peak-payment-server";

export const dynamic = "force-dynamic";

// GET ?paymentRef=FOLK-PAY-… — may this transfer be made, right now?
//
// Read-only. It reads the document, recomputes every job's figures from the job sheets as
// they stand, and asks PEAK what it still holds — PEAK reads are free and create nothing.
//
// The answer is what the screen shows: the stage, the figures, and — only when the answer
// is yes — the bank note to paste into the transfer. A document can be voided in PEAK, or
// a job sheet edited, between the page loading and someone opening their banking app, so
// the note is issued by this check rather than rendered from stored data.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const paymentRef = (req.nextUrl.searchParams.get("paymentRef") ?? "").trim();
  if (!paymentRef) return NextResponse.json({ error: "bad-query", reasons: ["Which payment?"] }, { status: 400 });

  const readiness = await transferReadiness(paymentRef);
  if (!readiness) return NextResponse.json({ error: "no-document", reasons: [`There is no payment ${paymentRef}`] }, { status: 404 });
  return NextResponse.json({ ok: true, paymentRef, ...readiness });
}
