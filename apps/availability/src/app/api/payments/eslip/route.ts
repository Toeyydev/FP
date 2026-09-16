import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";

// Retired by Payments v2 (Phase 1).
//
// This endpoint used to take ONE slip and mark every tour of a guide's month paid, dated
// by the upload. A month is not a transfer: each transfer now becomes a payment record
// (FOLK-PMT-…) with its own jobs, the date the bank moved the money, the amount and this
// slip — see lib/payments-v2 and POST /api/guide-payments.
//
// It still answers, rather than 404, so an old tab gets told where to go.
function ops(role?: string) { return role === "OPERATOR" || role === "ADMIN"; }
const refuse = (error: string, reason: string) => NextResponse.json({ error, reasons: [reason], detail: reason }, { status: 409 });

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  void req;
  return refuse("use-record-payment", "A month is not paid by one slip. Open Payments → Record payment: choose the jobs this transfer paid, give its date and amount, and attach the slip.");
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  void req;
  return refuse("evidence-is-kept", "A payment slip is evidence and stays with its payment. Reverse the payment, with a reason, if it was wrong.");
}
