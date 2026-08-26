import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isOps } from "@/lib/roles";
import { getPaymentMethods, peakEnabled, sanitizePeakError } from "@/lib/peak-api";

export const dynamic = "force-dynamic";

// GET — PEAK's payment methods, so the bank account a payout settles to is chosen
// from a real list instead of an opaque id being typed into an env var.
//
// READ-ONLY: lists methods, creates nothing, posts nothing.
export async function GET() {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  if (!peakEnabled) {
    return NextResponse.json({ ok: false, methods: [], error: "PEAK is not connected (credentials or user token missing)" }, { status: 503 });
  }

  let res;
  try {
    res = await getPaymentMethods();
  } catch (e) {
    return NextResponse.json({ ok: false, methods: [], error: sanitizePeakError(e) }, { status: 502 });
  }
  if (!res.ok) {
    return NextResponse.json({ ok: false, methods: [], error: res.desc ?? "PEAK rejected the payment-method request", peakCode: res.code ?? null }, { status: 502 });
  }

  const methods = res.methods ?? [];
  if (!methods.length) {
    // A working call that returns nothing is still a dead end — say so rather than
    // rendering an empty list the operator cannot interpret.
    return NextResponse.json({
      ok: false, methods: [],
      error: "PEAK returned no payment methods. If you have bank accounts set up in PEAK, this is a parsing problem — send this message to support.",
      peakCode: res.code ?? null,
    }, { status: 502 });
  }
  return NextResponse.json({ ok: true, methods });
}
