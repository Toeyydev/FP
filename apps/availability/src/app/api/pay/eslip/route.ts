import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";

// Retired by Payments v2 (Phase 1).
//
// These paths marked tours PAID from a slip upload — one covering slip, or split slips
// summing to a tour's payout — dated by the upload, and (when PEAK posting was switched
// on) posted an expense as a side effect. A transfer is now recorded once, deliberately:
// POST /api/guide-payments takes the jobs, the date the bank moved the money, the amount,
// any adjustments and the slip, reconciles them, and only then are the jobs paid.
//
// Split payments (several transfers settling one job) are not carried over yet: record
// the transfer that happened, and the job stays partly unpaid until the rest is recorded.
//
// It answers instead of 404 so an old browser tab is told where to go.
function ops(role?: string) { return role === "OPERATOR" || role === "ADMIN"; }
const refuse = (error: string, reason: string) => NextResponse.json({ error, reasons: [reason], detail: reason }, { status: 409 });

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  void req;
  return refuse("use-record-payment", "Uploading a slip no longer pays a tour. Open Payments → Record payment: choose the jobs, give the transfer date and amount, and attach this slip.");
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  void req;
  return refuse("evidence-is-kept", "A payment slip is evidence and stays with its payment. Reverse the payment, with a reason, if it was wrong.");
}
