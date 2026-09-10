import { NextResponse } from "next/server";
import { authenticateMobile } from "@/lib/mobile-auth";
import { guideTourDetails } from "@/lib/guide-schedule";

// GET ?date&slotIdx — one of the guide's own assigned tours in full, for FolkOPS
// Mobile. Unlike /api/tour-details there is no guideId parameter to honour: the
// token alone decides whose tour this is.
export async function GET(req: Request) {
  const a = await authenticateMobile(req);
  if (!a.ok) return NextResponse.json({ error: a.error }, { status: a.status });

  const q = new URL(req.url).searchParams;
  const date = q.get("date") || "";
  const slotIdx = Number(q.get("slotIdx") ?? "-1");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(slotIdx) || slotIdx < 0) {
    return NextResponse.json({ error: "bad-query" }, { status: 400 });
  }

  const details = await guideTourDetails(a.user.guideId, date, slotIdx);
  if (!details) return NextResponse.json({ error: "not-assigned" }, { status: 404 });
  return NextResponse.json(details);
}
