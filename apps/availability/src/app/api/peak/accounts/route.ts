import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isOps } from "@/lib/roles";
import { getAccountCodes, peakEnabled, sanitizePeakError } from "@/lib/peak-api";

export const dynamic = "force-dynamic"; // the chart is PEAK's to change, never cached here

// GET — the PEAK chart of accounts, for the mapping dropdown.
//
// READ-ONLY. This route lists accounts and nothing else: it creates no document,
// posts no expense, and writes nothing to our database. It exists so an operator
// picks a real account code instead of anyone typing or guessing one.
export async function GET() {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  if (!peakEnabled) {
    return NextResponse.json({ ok: false, accounts: [], error: "PEAK is not connected (credentials or user token missing)" }, { status: 503 });
  }

  let res;
  try {
    res = await getAccountCodes();
  } catch (e) {
    return NextResponse.json({ ok: false, accounts: [], error: sanitizePeakError(e) }, { status: 502 });
  }

  if (!res.ok) {
    // PEAK's own reason, already sanitised of anything credential-shaped.
    return NextResponse.json({ ok: false, accounts: [], error: res.desc ?? "PEAK rejected the account request", peakCode: res.code ?? null }, { status: 502 });
  }
  // A successful call that returns nothing is still a dead end for the operator —
  // say so rather than rendering an empty search box with no explanation.
  const accounts = res.accounts ?? [];
  if (!accounts.length) {
    return NextResponse.json({
      ok: false, accounts: [],
      error: "PEAK returned no accounts. If your chart of accounts is not empty, this is a parsing problem — send this message to support.",
      peakCode: res.code ?? null,
    }, { status: 502 });
  }
  return NextResponse.json({ ok: true, accounts });
}
