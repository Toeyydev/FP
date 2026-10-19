import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { audit } from "@/lib/audit";
import { SLOT_TIMES } from "@/lib/slots";
import { siteUrl } from "@/lib/site";
import { resolveDurationMin } from "@/lib/tour-duration";
import { googleEnabled, calendarApi } from "@/lib/google-calendar";

// Google Calendar invitations for guides (owner, 2026-10-20).
//
// One company-owned event per guide on a departure, on the calendar of the connected
// admin@folkpaths.com account (the organizer). The guide is the only attendee, at
// `calendarEmail ?? email`; Google sends them the invitation, the update, the cancellation.
// No guide connects a Google account.
//
//   title        the tour name
//   time         the departure's start, and start + the job's duration, Asia/Bangkok
//   location     the tour's meeting point
//   description  the Job Code and the FolkOPS job link — no guest data
//   reminder     one popup, 60 minutes before (on the organizer's copy; see note below)
//
// The event belongs to the DEPARTURE, not the Assignment row (TourCalendarEvent). When the
// job moves from Guide A to Guide B the same event changes attendee: Google tells A they
// were removed and invites B. Nothing is deleted and recreated, so no duplicate.
//
// Only a guide's ACCEPT creates a new event (`create: true`, from lib/offers). Every other
// path — a manual assignment, a split, a removal, a cancellation — only updates, reassigns,
// reinstates or cancels an event that already exists. Nothing here backfills.
//
// Never throws, never blocks the caller. A failure is recorded on the row (status and
// Google's reason, never personal data) and retried by the 5-minute loop with backoff;
// after MAX_ATTEMPTS the operators are told once.
//
// While Google refuses to create a guide's event (the API switched off, no connection), the
// guide is not left with nothing: they are emailed one .ics, and the operators are told.
// The .ics carries the identifier Google is expected to give an event created with our id
// (`<id>@google.com`); the first successful sync records whether Google's iCalUID really
// matched (audit `icalUidMatchesFallback`). A matching UID lets a calendar that keys on UID
// treat Google's later invitation as an update of the same entry — but whether a given mail
// or calendar app actually merges the two is NOT proven here; check it on rollout.
// Reassigning or cancelling before then emails a CANCEL for it. (Email must be configured.)
//
// Note: Google applies an event's reminders to the organizer's calendar. A guest's copy uses
// the guest's own default notifications — Google gives the organizer no way to set them. So
// the guide's one-hour reminder is FolkOPS's own (lib/tour-reminders); this one is secondary.

const TZ = "Asia/Bangkok";
export const MAX_ATTEMPTS = 10;
const BACKOFF_MIN = [5, 30, 120, 360];
const PLACEHOLDER = /(@|\.)folkpath\.local$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Google event ids are base32hex (a–v, 0–9), 5–1024 chars. Derived from our row id, so a retried insert of the same row can only ever hit 409 — never make a second event. */
export function googleEventIdFor(rowId: string): string {
  return `folkops${createHash("sha256").update(rowId).digest("hex").slice(0, 40)}`;
}

/** Where the guide receives invitations: their calendar email, else their account email. Null when neither is a real address. */
export function inviteEmail(u: { calendarEmail?: string | null; email?: string | null } | null | undefined): string | null {
  for (const v of [u?.calendarEmail, u?.email]) {
    const e = (v ?? "").trim();
    if (e && EMAIL.test(e) && !PLACEHOLDER.test(e)) return e;
  }
  return null;
}

function addMinutes(date: string, hhmm: string, minutes: number): { date: string; time: string } {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), h, m + minutes));
  return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) };
}

export type EventBody = {
  summary: string; location?: string; description: string;
  start: { dateTime: string; timeZone: string }; end: { dateTime: string; timeZone: string };
  attendees: { email: string }[];
  reminders: { useDefault: false; overrides: { method: "popup"; minutes: number }[] };
  guestsCanInviteOthers: false; guestsCanSeeOtherGuests: false; guestsCanModify: false;
  status: "confirmed";
};

/** The event exactly as Google should hold it, for one guide on one departure. Pure. */
export function buildEventBody(o: { tourName: string; meetingPoint?: string | null; date: string; slotIdx: number; durationMin: number; jobRef: string | null; jobLink: string; attendeeEmail: string | null }): EventBody {
  const start = SLOT_TIMES[o.slotIdx] ?? "09:00";
  const end = addMinutes(o.date, start, o.durationMin);
  return {
    summary: o.tourName,
    ...(o.meetingPoint?.trim() ? { location: o.meetingPoint.trim() } : {}),
    description: `Job Code: ${o.jobRef || "(not numbered yet)"}\n${o.jobLink}`,
    start: { dateTime: `${o.date}T${start}:00`, timeZone: TZ },
    end: { dateTime: `${end.date}T${end.time}:00`, timeZone: TZ },
    attendees: o.attendeeEmail ? [{ email: o.attendeeEmail }] : [],
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 60 }] },
    guestsCanInviteOthers: false, guestsCanSeeOtherGuests: false, guestsCanModify: false,
    status: "confirmed",
  };
}

export const contentHash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** The calendar identifier Google is expected to give an event created with our id (checked on each successful sync). */
export const icalUidFor = (googleEventId: string) => `${googleEventId}@google.com`;

// The emailed stand-in for an event Google would not create. Returns whether it was sent.
async function emailFallback(o: { to: string; googleEventId: string; body: EventBody | null; method: "REQUEST" | "CANCEL"; sequence: number }): Promise<boolean> {
  try {
    const [{ makeIcs }, { sendEmail }] = await Promise.all([import("@/lib/calendar"), import("@/lib/email")]);
    const b = o.body;
    const startMs = b ? Date.parse(`${b.start.dateTime}+07:00`) : Date.now();
    const durationMin = b ? Math.round((Date.parse(`${b.end.dateTime}+07:00`) - startMs) / 60_000) : 60;
    const ics = makeIcs({ uid: icalUidFor(o.googleEventId), startMs, durationMin, summary: b?.summary ?? "Tour", description: b?.description, location: b?.location,
      method: o.method, sequence: o.sequence, status: o.method === "CANCEL" ? "CANCELLED" : "CONFIRMED" });
    const r = await sendEmail({
      to: o.to,
      subject: o.method === "CANCEL" ? `Tour cancelled for you: ${b?.summary ?? "a tour"}` : `Tour: ${b?.summary ?? ""} — ${b?.start.dateTime.replace("T", " ").slice(0, 16) ?? ""}`,
      text: o.method === "CANCEL" ? "This tour is no longer yours. It has been removed from your calendar." : `${b?.summary ?? ""}\n${b?.start.dateTime.replace("T", " ").slice(0, 16) ?? ""}\n${b?.description ?? ""}`,
      icalEvent: { method: o.method, content: ics },
    });
    return !!r?.sent;
  } catch { return false; }
}

// The organizer: the connected account named by FOLKPATHS_CALENDAR_EMAIL (else
// FOLKPATHS_DRIVE_EMAIL, the company account), else the earliest operator/admin connection.
async function organizer(): Promise<{ refreshToken: string; calendarId: string } | null> {
  if (!googleEnabled) return null;
  const opIds = (await prisma.user.findMany({ where: { role: { in: ["OPERATOR", "ADMIN"] } }, select: { id: true } })).map((u) => u.id);
  if (!opIds.length) return null;
  const conns = await prisma.googleCalendar.findMany({ where: { userId: { in: opIds } }, orderBy: { connectedAt: "asc" } }).catch(() => []);
  const want = (process.env.FOLKPATHS_CALENDAR_EMAIL || process.env.FOLKPATHS_DRIVE_EMAIL || "").trim().toLowerCase();
  const c = (want && conns.find((x) => x.email?.toLowerCase() === want)) || conns[0];
  if (!c?.refreshToken) return null;
  try { return { refreshToken: decrypt(c.refreshToken), calendarId: c.calendarId || "primary" }; } catch { return null; }
}

/** Are Google invitations the way guides hear about a tour? (Then the old .ics email is not sent.) */
export async function calendarInvitesActive(): Promise<boolean> {
  return !!(await organizer().catch(() => null));
}

type Row = Awaited<ReturnType<typeof prisma.tourCalendarEvent.findMany>>[number];

// One departure at a time per process: two syncs of the same departure must not both
// decide to create. The (date, slotIdx, attendeeGuideId) unique index backs this across processes.
const running = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = running.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  running.set(key, next.catch(() => {}));
  return next;
}

/**
 * Bring a departure's events in line with who is on it.
 *   create     this guide may get a NEW event (only a guide's Accept passes it)
 *   departing  this guide is being taken off (the caller deletes the assignment next)
 */
export async function syncDepartureCalendar(date: string, slotIdx: number, o: { create?: string; departing?: string } = {}): Promise<void> {
  return serial(`${date}|${slotIdx}`, () => syncOnce(date, slotIdx, o)).catch(() => {});
}

async function syncOnce(date: string, slotIdx: number, o: { create?: string; departing?: string }): Promise<void> {
  const [assignments, rows] = await Promise.all([
    prisma.assignment.findMany({ where: { date, slotIdx }, select: { guideId: true, tourId: true } }),
    prisma.tourCalendarEvent.findMany({ where: { date, slotIdx }, orderBy: { createdAt: "asc" } }),
  ]);
  const desired = assignments.filter((a) => a.guideId !== o.departing);
  if (!rows.length && !(o.create && desired.some((a) => a.guideId === o.create))) return; // nothing to keep in step, nothing to create

  const want = new Map(desired.map((a) => [a.guideId, a.tourId]));
  const active = rows.filter((r) => r.state === "ACTIVE");
  const cancelled = rows.filter((r) => r.state === "CANCELLED");
  const touched: Row[] = [];
  const kept = new Set<string>();
  for (const r of active) if (want.has(r.attendeeGuideId)) { kept.add(r.attendeeGuideId); touched.push(r); }
  const spareActive = active.filter((r) => !touched.includes(r));
  const spareCancelled = cancelled.filter((r) => !want.has(r.attendeeGuideId));

  for (const [guideId, tourId] of want) {
    if (kept.has(guideId)) continue;
    // 1. this guide's own earlier event on the departure, cancelled → reinstate it
    let r: Row | undefined = cancelled.find((x) => x.attendeeGuideId === guideId);
    // 2. an event whose guide left → hand it over (Guide A → Guide B on the same event)
    if (!r) r = spareActive.shift();
    // 3. a cancelled event on the departure → reinstate it for this guide
    if (!r) r = spareCancelled.shift();
    if (r) {
      r = await prisma.tourCalendarEvent.update({ where: { id: r.id }, data: { attendeeGuideId: guideId, tourId, state: "ACTIVE", syncStatus: "PENDING" } });
    } else if (o.create === guideId) {
      // 4. a guide's Accept, and no event to reuse → a new one
      const org = await organizer();
      const id = `tce_${createHash("sha256").update(`${date}|${slotIdx}|${guideId}|${Date.now()}|${Math.random()}`).digest("hex").slice(0, 24)}`;
      r = await prisma.tourCalendarEvent.create({ data: { id, date, slotIdx, tourId, attendeeGuideId: guideId, googleEventId: googleEventIdFor(id), calendarId: org?.calendarId ?? "primary" } })
        .catch(async () => (await prisma.tourCalendarEvent.findFirst({ where: { date, slotIdx, attendeeGuideId: guideId } })) ?? undefined);
    }
    if (r) { kept.add(guideId); touched.push(r); }
  }
  // Events whose guide is no longer on the departure, and that nobody took over → cancel.
  for (const r of spareActive) {
    if (touched.includes(r)) continue;
    touched.push(await prisma.tourCalendarEvent.update({ where: { id: r.id }, data: { state: "CANCELLED", syncStatus: "PENDING" } }));
  }
  for (const r of touched) await pushRow(r);
}

// Make Google hold what the row says. Only calls Google when something changed.
async function pushRow(r: Row): Promise<void> {
  const fresh = await prisma.tourCalendarEvent.findUnique({ where: { id: r.id } });
  if (!fresh) return;
  let body: EventBody | { status: "cancelled" };
  let attendeeEmail: string | null = fresh.attendeeEmail;
  if (fresh.state === "ACTIVE") {
    const [u, tour, sheet, offer] = await Promise.all([
      prisma.user.findUnique({ where: { guideId: fresh.attendeeGuideId }, select: { email: true, calendarEmail: true } }),
      prisma.tour.findUnique({ where: { id: fresh.tourId }, select: { id: true, name: true, meetingPoint: true, durationMin: true } }),
      prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId: fresh.attendeeGuideId, date: fresh.date, slotIdx: fresh.slotIdx } }, select: { ref: true } }),
      prisma.jobOffer.findFirst({ where: { date: fresh.date, slotIdx: fresh.slotIdx, tourId: fresh.tourId, assignedGuideId: fresh.attendeeGuideId, status: "ASSIGNED" }, orderBy: { createdAt: "desc" }, select: { id: true, durationMin: true } }),
    ]);
    attendeeEmail = inviteEmail(u);
    body = buildEventBody({
      tourName: tour?.name ?? fresh.tourId, meetingPoint: tour?.meetingPoint, date: fresh.date, slotIdx: fresh.slotIdx,
      durationMin: resolveDurationMin(offer, tour).minutes, jobRef: sheet?.ref ?? null,
      jobLink: siteUrl(`/job-sheet?guideId=${encodeURIComponent(fresh.attendeeGuideId)}&date=${fresh.date}&slotIdx=${fresh.slotIdx}`), attendeeEmail,
    });
  } else {
    body = { status: "cancelled" };
  }
  const hash = contentHash(body);
  // A fallback .ics went to someone who no longer holds this event (reassigned, or cancelled)
  // and Google never made the event → withdraw it from their calendar.
  let row = fresh;
  if (row.fallbackSentAt && row.fallbackEmail && !row.createdInGoogle && (row.state === "CANCELLED" || row.fallbackEmail !== attendeeEmail)) {
    await emailFallback({ to: row.fallbackEmail, googleEventId: row.googleEventId, body: null, method: "CANCEL", sequence: 1 });
    row = await prisma.tourCalendarEvent.update({ where: { id: row.id }, data: { fallbackSentAt: null, fallbackEmail: null } });
  }
  if (row.syncStatus === "OK" && row.contentHash === hash) return; // Google already has exactly this — no call, no email to the guide
  if (fresh.state === "CANCELLED" && !fresh.createdInGoogle) {
    await prisma.tourCalendarEvent.update({ where: { id: fresh.id }, data: { syncStatus: "OK", contentHash: hash, lastError: null, nextAttemptAt: null, attendeeEmail } });
    return;
  }

  const org = await organizer();
  let result: { ok: boolean; status: number; reason: string | null; op: string; json?: Record<string, unknown> };
  if (!org) result = { ok: false, status: 0, reason: "no-organizer-connection", op: "none" };
  else {
    const path = `/calendars/${encodeURIComponent(fresh.calendarId)}/events`;
    const q = { sendUpdates: "all" };
    if (!fresh.createdInGoogle) {
      const ins = await calendarApi(org.refreshToken, "POST", path, { query: q, body: { id: fresh.googleEventId, ...body } });
      // 409: this id already exists — an earlier attempt got through. Update it instead.
      const r2 = ins.status === 409 ? await calendarApi(org.refreshToken, "PATCH", `${path}/${fresh.googleEventId}`, { query: q, body }) : ins;
      result = { ...r2, op: ins.status === 409 ? "insert-409-patch" : "insert" };
    } else {
      const up = await calendarApi(org.refreshToken, "PATCH", `${path}/${fresh.googleEventId}`, { query: q, body });
      result = { ...up, op: fresh.state === "CANCELLED" ? "cancel" : "update" };
    }
  }

  // Does Google's identifier for the event match the one a fallback .ics used? Recorded, so
  // the first real event shows it. (A match is necessary for a client to merge the two
  // entries; it does not prove every client will.)
  const icalUid = typeof result.json?.iCalUID === "string" ? result.json.iCalUID : null;
  if (result.ok) {
    await prisma.tourCalendarEvent.update({ where: { id: fresh.id }, data: { syncStatus: "OK", contentHash: hash, createdInGoogle: true, attempts: 0, lastError: null, nextAttemptAt: null, attendeeEmail } });
  } else {
    const attempts = fresh.attempts + 1;
    const wait = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)];
    await prisma.tourCalendarEvent.update({ where: { id: fresh.id }, data: { syncStatus: "FAILED", attempts, lastError: `${result.status} ${result.reason ?? ""}`.trim().slice(0, 200), nextAttemptAt: new Date(Date.now() + wait * 60_000) } });
    // Google would not create this guide's event: email them the stand-in, once — and on the
    // first failure tell the operators, so a guide without either is never a silent outcome.
    if (row.state === "ACTIVE" && !row.createdInGoogle && "summary" in body) {
      let emailed = !!row.fallbackSentAt;
      if (!emailed && attendeeEmail && await emailFallback({ to: attendeeEmail, googleEventId: row.googleEventId, body, method: "REQUEST", sequence: 0 })) {
        await prisma.tourCalendarEvent.update({ where: { id: fresh.id }, data: { fallbackSentAt: new Date(), fallbackEmail: attendeeEmail } });
        emailed = true;
      }
      if (attempts === 1) {
        try {
          const { notifyOps } = await import("@/lib/booking-import");
          await notifyOps(`Google Calendar did not create the invitation for ${row.attendeeGuideId} — ${body.summary}, ${row.date} ${SLOT_TIMES[row.slotIdx] ?? ""} (${result.status} ${result.reason ?? ""}). FolkOPS keeps retrying. ${emailed ? "The guide was emailed a calendar file meanwhile." : "The guide has NOT been sent a calendar invitation — email is not set up or has no address for them."}`,
            "Calendar invite not sent", `${row.attendeeGuideId} · ${row.date} · ${result.reason ?? result.status}`, { date: row.date, push: false });
        } catch { /* alerts are best-effort */ }
      }
    }
    if (attempts === MAX_ATTEMPTS) {
      try {
        const { notifyOps } = await import("@/lib/booking-import");
        await notifyOps(`Google Calendar could not update the invitation for ${fresh.attendeeGuideId} on ${fresh.date} ${SLOT_TIMES[fresh.slotIdx] ?? ""} after ${MAX_ATTEMPTS} tries (${result.status} ${result.reason ?? ""}). The guide may not have the event.`, "Calendar invite failing", `${fresh.date} · ${result.reason ?? result.status}`, { date: fresh.date });
      } catch { /* alerts are best-effort */ }
    }
  }
  try {
    await audit({ actorId: null, actorRole: "SYSTEM", action: result.ok ? "calendar.event_synced" : "calendar.event_failed", entityType: "TourCalendarEvent", entityId: fresh.id,
      detail: { date: fresh.date, slotIdx: fresh.slotIdx, guideId: fresh.attendeeGuideId, state: fresh.state, op: result.op, status: result.status, ...(result.ok ? {} : { reason: result.reason }),
        ...(icalUid ? { icalUidMatchesFallback: icalUid === icalUidFor(fresh.googleEventId) } : {}) } });
  } catch { /* the audit never blocks */ }
}

/** Retry the events that failed or never reached Google, for departures from today on. Never creates one. */
export async function retryTourCalendarEvents(now = new Date()): Promise<number> {
  const today = new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
  const due = await prisma.tourCalendarEvent.findMany({
    where: { syncStatus: { in: ["PENDING", "FAILED"] }, attempts: { lt: MAX_ATTEMPTS }, date: { gte: today }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
    select: { date: true, slotIdx: true }, take: 20, orderBy: { updatedAt: "asc" },
  });
  const seen = new Set<string>();
  for (const d of due) {
    const k = `${d.date}|${d.slotIdx}`;
    if (seen.has(k)) continue;
    seen.add(k);
    await syncDepartureCalendar(d.date, d.slotIdx);
  }
  return seen.size;
}

// ---- The names the rest of the app already calls ----

/** After a guide is put on a departure. `create` only from a guide's Accept. */
export async function pushTourToCalendars(guideId: string, date: string, slotIdx: number, o: { create?: boolean } = {}): Promise<void> {
  await syncDepartureCalendar(date, slotIdx, o.create ? { create: guideId } : {});
}

/** Before a guide is taken off a departure (the caller deletes the assignment next). */
export async function removeTourEvents(a: { guideId: string; date: string; slotIdx: number }): Promise<void> {
  await syncDepartureCalendar(a.date, a.slotIdx, { departing: a.guideId });
}
