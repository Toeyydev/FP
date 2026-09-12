import { NextResponse } from "next/server";
import { authenticateMobile } from "@/lib/mobile-auth";
import { guidePay } from "@/lib/guide-pay";

// GET ?all=1 — FolkOPS Mobile shows the token guide's own pay, month by month: each
// tour's net fee and reimbursable expenses, whether it has been paid, and the bank
// slip for it. The same answer the web My Pay gives, over a bearer token. Read-only:
// the app can never change a payment.
export async function GET(req: Request) {
  const a = await authenticateMobile(req);
  if (!a.ok) return NextResponse.json({ error: a.error }, { status: a.status });

  const all = new URL(req.url).searchParams.get("all") === "1";
  return NextResponse.json(await guidePay(a.user.guideId, { all }));
}
