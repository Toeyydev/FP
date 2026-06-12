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
