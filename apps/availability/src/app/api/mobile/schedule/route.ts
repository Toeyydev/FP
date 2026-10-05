import { NextResponse } from "next/server";
import { authenticateMobile } from "@/lib/mobile-auth";
import { guideSchedule, UNREPORTED_LOOKBACK_DAYS } from "@/lib/guide-schedule";

// GET — the signed-in guide's tours, for FolkOPS Mobile: the same list as the web
// My Tours (/api/schedule), plus the tours of the last week still owing a report.
// The app is where a guide reports, so it must still show them what they owe after
// midnight; the web list is left as it was.
export async function GET(req: Request) {
  const a = await authenticateMobile(req);
  if (!a.ok) return NextResponse.json({ error: a.error }, { status: a.status });
  return NextResponse.json({ items: await guideSchedule(a.user.guideId, Date.now(), { unreportedDays: UNREPORTED_LOOKBACK_DAYS }) });
}
