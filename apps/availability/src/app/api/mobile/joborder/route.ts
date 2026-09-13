import { NextResponse } from "next/server";
import { authenticateMobile } from "@/lib/mobile-auth";
import { guideJobOrder } from "@/lib/job-order";

// GET ?date&slotIdx — the guide's own job order ("ใบสั่งงานมัคคุเทศก์") as data.
//
// The same facts as the printed form (lib/job-order), for a guide who is asked
// for their job order while they are out working and has only their phone. The
// app has no browser view and the printed route is cookie-authenticated, so the
// order is sent as JSON and drawn natively.
//
// The guide is taken from the token, never from the query: this can only ever
// answer with the caller's own order.
export async function GET(req: Request) {
  const a = await authenticateMobile(req);
  if (!a.ok) return NextResponse.json({ error: a.error }, { status: a.status });

  const url = new URL(req.url);
  const date = url.searchParams.get("date") ?? "";
  const slotIdx = Number(url.searchParams.get("slotIdx") ?? "-1");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(slotIdx) || slotIdx < 0) {
    return NextResponse.json({ error: "bad-query" }, { status: 400 });
  }

  const order = await guideJobOrder(a.user.guideId, date, slotIdx);
  // An order only exists for work actually given to this guide. The operator's
  // printed route does not need an assignment — it is the operator issuing the
  // order — but a guide asking for their own does.
  if (!order.assigned) return NextResponse.json({ error: "not-assigned" }, { status: 404 });

  return NextResponse.json(order);
}
