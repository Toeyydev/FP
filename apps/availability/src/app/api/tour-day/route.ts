import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { isOps } from "@/lib/roles";
import { tourDays } from "@/lib/tour-day";

// GET /api/tour-day?month=YYYY-MM — operators and admins: who ran which tour, day by day.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const month = req.nextUrl.searchParams.get("month") ?? "";
  if (!/^\d{4}-\d{2}$/.test(month)) return NextResponse.json({ error: "bad-month" }, { status: 400 });
  return NextResponse.json({ month, days: await tourDays(month) });
}
