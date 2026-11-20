import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { isOps, isAdmin } from "@/lib/roles";
import { listCalendarSync } from "@/lib/calendar-sync-status";

export const dynamic = "force-dynamic";

// GET ?view=attention|all&status=ok|waiting|failed&when=upcoming|all — operators and admins.
// Where each company calendar event stands with Google (lib/calendar-sync-status).
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const q = z.object({
    view: z.enum(["attention", "all"]).default("attention"),
    status: z.enum(["ok", "waiting", "failed"]).optional(),
    when: z.enum(["upcoming", "all"]).default("upcoming"),
  }).safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!q.success) return NextResponse.json({ error: "bad-query" }, { status: 400 });
  return NextResponse.json({ ok: true, canBulkRetry: isAdmin(session?.user?.role), ...(await listCalendarSync(q.data)) });
}
