import { NextResponse } from "next/server";
import { authenticateMobile } from "@/lib/mobile-auth";
import { guideSchedule } from "@/lib/guide-schedule";

// GET — the signed-in guide's upcoming tours, for FolkOPS Mobile. The same list
// as the web My Tours (/api/schedule); only how the guide is identified differs.
export async function GET(req: Request) {
  const a = await authenticateMobile(req);
  if (!a.ok) return NextResponse.json({ error: a.error }, { status: a.status });
  return NextResponse.json({ items: await guideSchedule(a.user.guideId) });
}
