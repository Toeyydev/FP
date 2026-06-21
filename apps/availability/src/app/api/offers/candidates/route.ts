import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { availableGuides } from "@/lib/offers";

function ops(role?: string) { return role === "OPERATOR" || role === "ADMIN"; }

// GET ?date=YYYY-MM-DD&slotIdx=N — guides who are free for that slot, so the
// operator can hand an unfilled job to a specific one. Operator/admin only.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const date = req.nextUrl.searchParams.get("date") || "";
  const slotIdx = Number(req.nextUrl.searchParams.get("slotIdx") ?? "-1");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(slotIdx >= 0)) {
    return NextResponse.json({ error: "bad-query" }, { status: 400 });
  }
  const guides = await availableGuides(date, slotIdx);
  return NextResponse.json({ guides: guides.map((g) => ({ guideId: g.guideId, displayName: g.displayName })) });
}

// POST { slots: [{date, slotIdx}] } — available guide IDs for each slot at once,
// so the Bookings inbox can hide guides who blocked that slot from its picker.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => null) as { slots?: { date: string; slotIdx: number }[] } | null;
  const slots = (body?.slots ?? [])
    .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s?.date) && Number.isInteger(s?.slotIdx) && s.slotIdx >= 0)
    .slice(0, 200);
  const uniq = [...new Map(slots.map((s) => [`${s.date}|${s.slotIdx}`, s])).values()];
  const lists = await Promise.all(uniq.map((s) => availableGuides(s.date, s.slotIdx)));
  const map: Record<string, string[]> = {};
  uniq.forEach((s, i) => { map[`${s.date}|${s.slotIdx}`] = lists[i].map((g) => g.guideId!).filter(Boolean); });
  return NextResponse.json({ map });
}
