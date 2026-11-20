import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { isAdmin } from "@/lib/roles";
import { retryNotInStep, BULK_RETRY_LIMIT } from "@/lib/calendar-sync-status";

export const dynamic = "force-dynamic";

// POST — admin only (session AND database role). Retry the upcoming events that are not in
// step with Google, one at a time, at most BULK_RETRY_LIMIT; a second request while one is
// running is refused (lib/calendar-sync-status).
export async function POST() {
  const session = await auth();
  const no = NextResponse.json({ error: "forbidden", message: "Only an admin can retry in bulk." }, { status: 403 });
  if (!isAdmin(session?.user?.role) || !session?.user?.id) return no;
  const me = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true, state: true } });
  if (me?.role !== "ADMIN" || me.state !== "ACTIVE") return no;
  const r = await retryNotInStep();
  if (r.busy) return NextResponse.json({ error: "busy", message: "A retry is already running. Wait for it to finish." }, { status: 409 });
  const ok = r.results.filter((x) => x.ok).length;
  await audit({ actorId: session.user.id, actorRole: "ADMIN", action: "calendar.manual_retry_bulk", entityType: "TourCalendarEvent",
    detail: { tried: r.results.length, ok, notOk: r.results.filter((x) => !x.ok).map((x) => ({ id: x.id, code: x.ok ? null : x.code })), more: r.more, limit: BULK_RETRY_LIMIT } }).catch(() => {});
  return NextResponse.json({ ok: true, tried: r.results.length, succeeded: ok, failed: r.results.length - ok, more: r.more, results: r.results });
}
