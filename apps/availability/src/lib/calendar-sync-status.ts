import { prisma } from "@/lib/db";
import { SLOT_TIMES } from "@/lib/slots";
import { MAX_ATTEMPTS, calendarErrorText, retryTourCalendarEventById, type ManualRetryResult } from "@/lib/tour-calendar-sync";

// Ops → Calendar sync: where every company calendar event stands with Google, and a way to
// retry the ones that are not in step. Reads TourCalendarEvent; writes only through
// lib/tour-calendar-sync. No guest data and no addresses are returned.

/** How a row reads to an operator. Waiting = automatic retries are still going; Failed = they gave up. */
export type SyncDisplay = "ok" | "waiting" | "failed";
export function displayStatus(r: { syncStatus: string; attempts: number }): SyncDisplay {
  if (r.syncStatus === "OK") return "ok";
  if (r.syncStatus === "FAILED" && r.attempts >= MAX_ATTEMPTS) return "failed";
  return "waiting";
}

export type SyncRowView = {
  id: string; date: string; time: string; tour: string; guideId: string; guide: string;
  state: "ACTIVE" | "CANCELLED"; status: SyncDisplay; attempts: number;
  error: string | null; nextAttemptAt: string | null; updatedAt: string; canRetry: boolean;
};
export type SyncFilter = { view: "attention" | "all"; status?: SyncDisplay; when: "upcoming" | "all" };

export const bangkokToday = (now = new Date()) => new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 10);

export async function listCalendarSync(f: SyncFilter, now = new Date()): Promise<{ counts: Record<SyncDisplay, number>; rows: SyncRowView[]; truncated: boolean }> {
  const rows = await prisma.tourCalendarEvent.findMany({
    where: f.when === "upcoming" ? { date: { gte: bangkokToday(now) } } : {},
    orderBy: [{ date: "asc" }, { slotIdx: "asc" }, { attendeeGuideId: "asc" }],
    select: { id: true, date: true, slotIdx: true, tourId: true, attendeeGuideId: true, state: true, syncStatus: true, attempts: true, lastError: true, nextAttemptAt: true, updatedAt: true },
  });
  const counts: Record<SyncDisplay, number> = { ok: 0, waiting: 0, failed: 0 };
  for (const r of rows) counts[displayStatus(r)]++;
  const shown = rows.filter((r) => {
    const s = displayStatus(r);
    if (f.view === "attention" && s === "ok") return false;
    return !f.status || s === f.status;
  });
  const LIMIT = 300;
  const page = shown.slice(0, LIMIT);
  const [tours, guides] = await Promise.all([
    prisma.tour.findMany({ where: { id: { in: [...new Set(page.map((r) => r.tourId))] } }, select: { id: true, name: true } }),
    prisma.user.findMany({ where: { guideId: { in: [...new Set(page.map((r) => r.attendeeGuideId))] } }, select: { guideId: true, displayName: true } }),
  ]);
  const tourName = new Map(tours.map((t) => [t.id, t.name]));
  const guideName = new Map(guides.map((g) => [g.guideId!, g.displayName]));
  return {
    counts,
    truncated: shown.length > LIMIT,
    rows: page.map((r) => ({
      id: r.id, date: r.date, time: SLOT_TIMES[r.slotIdx] ?? "", tour: tourName.get(r.tourId) ?? r.tourId,
      guideId: r.attendeeGuideId, guide: guideName.get(r.attendeeGuideId) ?? r.attendeeGuideId,
      state: r.state === "CANCELLED" ? "CANCELLED" : "ACTIVE", status: displayStatus(r), attempts: r.attempts,
      error: calendarErrorText(r.lastError), nextAttemptAt: r.syncStatus === "OK" ? null : r.nextAttemptAt?.toISOString() ?? null,
      updatedAt: r.updatedAt.toISOString(), canRetry: r.syncStatus !== "OK",
    })),
  };
}

export const BULK_RETRY_LIMIT = 20;

/**
 * Retry every upcoming event that is not in step, oldest departure first, one at a time, at
 * most BULK_RETRY_LIMIT per run. Only one run at a time across all app instances: the run
 * holds a Postgres advisory lock, and a second request while it is held is refused ("busy")
 * rather than queued — that is what makes a double click harmless.
 */
export async function retryNotInStep(now = new Date()): Promise<{ busy: true } | { busy: false; results: (ManualRetryResult & { id: string })[]; more: boolean }> {
  return prisma.$transaction(async (tx) => {
    const [got] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('calendar-sync:retry-not-in-step')) AS ok`;
    if (!got?.ok) return { busy: true as const };
    const due = await prisma.tourCalendarEvent.findMany({
      where: { syncStatus: { in: ["FAILED", "PENDING"] }, date: { gte: bangkokToday(now) } },
      orderBy: [{ date: "asc" }, { slotIdx: "asc" }], select: { id: true }, take: BULK_RETRY_LIMIT + 1,
    });
    const results: (ManualRetryResult & { id: string })[] = [];
    for (const r of due.slice(0, BULK_RETRY_LIMIT)) results.push({ id: r.id, ...(await retryTourCalendarEventById(r.id)) });
    return { busy: false as const, results, more: due.length > BULK_RETRY_LIMIT };
  }, { maxWait: 10_000, timeout: 300_000 });
}
