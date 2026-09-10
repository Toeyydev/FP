import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { guideTourDetails } from "@/lib/guide-schedule";

function ops(role?: string) {
  return role === "OPERATOR" || role === "ADMIN";
}

// GET ?date&slotIdx[&guideId] — the full tour details for one assigned job:
// the assignment + operator tour info + the booking customers. A guide sees
// only their own; an operator can pass any guideId.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const date = req.nextUrl.searchParams.get("date") || "";
  const slotIdx = Number(req.nextUrl.searchParams.get("slotIdx") ?? "-1");
  const isOps = ops(session.user.role);
  const guideId = isOps ? (req.nextUrl.searchParams.get("guideId") || session.user.guideId || "") : (session.user.guideId || "");
  if (!guideId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !(slotIdx >= 0)) return NextResponse.json({ error: "bad-query" }, { status: 400 });

  const details = await guideTourDetails(guideId, date, slotIdx);
  if (!details) return NextResponse.json({ error: "not-assigned" }, { status: 404 });
  return NextResponse.json(details);
}
