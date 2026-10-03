// Bringing back bookings that "Archive stale" hid.
//
// "Archive stale" (api/bookings/archive-stale) set every past booking that never had a
// guide to IGNORED — on 2026-06-15 it hid 398 at once, March to mid-June, and recorded
// only the count. Those tours did run: Bókun has the guests as CONFIRMED or ARRIVED. With
// them hidden, those days have no departures, so no guide can be recorded against them,
// no job sheet can be made, and none of their costs can reach the books.
//
// A booking comes back only when ALL of these hold — anything else is listed, not restored:
//   * it is IGNORED with no note and no guide (a hand-hidden duplicate carries a note, or
//     was hidden from a slot that had a guide), dated in the chosen range and in the past;
//   * Bókun, read now, says every booking it holds for it that day is CONFIRMED, ARRIVED
//     or NO_SHOW — never CANCELLED, never missing (owner, 2026-10-04: confirmed only);
//   * the date Bókun has is the date FolkOPS has;
//   * it has a tour and a departure;
//   * no other copy of the same booking is already live or also coming back. The same
//     Bókun booking can be stored twice: under its product code ("FOLK-T…", the webhook)
//     and under the channel's booking code ("GET-…", the search). The product copy is
//     the one kept.
// Restoring sets it back to PENDING and nothing else — no guide, no job sheet, no offer.
// The operator then records who guided each departure, as for any past tour.
import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { audit } from "@/lib/audit";
import { bokunApiEnabled, searchBookings } from "@/lib/bokun-api";

export type BokunItem = { productCode: string | null; bookingCode: string | null; ext: string | null; status: string | null; day: string | null };
export type Candidate = {
  id: string; source: string | null; confirmationCode: string | null; externalRef: string | null; status: string;
  date: string | null; slotIdx: number | null; tourId: string | null; pax: number | null; notes: string | null; assignedGuideId: string | null;
};
export type Exception = { id: string; ref: string; date: string | null; reason: string };
export type RestorePlan = { restore: Candidate[]; exceptions: Exception[]; hash: string };

export const CONFIRMED_STATUSES = ["CONFIRMED", "ARRIVED", "NO_SHOW"] as const;
/** The note "Archive stale" writes on what it hides (from 2026-10 on; the first run wrote none). */
export const ARCHIVED_NOTE = "Archived as stale (past, never dispatched)";
const archivedByNote = (notes: string | null) => (notes ?? "").startsWith(ARCHIVED_NOTE);
const LIVE = new Set(["PENDING", "OFFERED", "ASSIGNED"]);
const k = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

/** A Bókun start date as the Bangkok calendar day. */
export function bangkokDay(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v + 7 * 3600_000).toISOString().slice(0, 10);
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return null;
}

/** One Bókun product-booking search result, reduced to what the plan reads. */
export function toBokunItem(it: Record<string, unknown>): BokunItem {
  const parent = (it.parentBooking ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    productCode: s(it.productConfirmationCode),
    bookingCode: s(it.confirmationCode) ?? s(parent.confirmationCode),
    ext: s(it.externalBookingReference) ?? s(parent.externalBookingReference),
    status: s(it.status),
    day: bangkokDay(it.startDate ?? it.startDateTime),
  };
}

/** Which Bókun bookings stand behind this FolkOPS booking, and whether it is a product copy. */
function bokunFor(c: Candidate, idx: { product: Map<string, BokunItem>; booking: Map<string, BokunItem[]>; ext: Map<string, BokunItem[]> }) {
  const p = idx.product.get(k(c.confirmationCode));
  if (p) return { items: [p], productCopy: true };
  const sameDay = (xs: BokunItem[] | undefined) => (xs ?? []).filter((x) => x.day === c.date);
  const byBooking = sameDay(idx.booking.get(k(c.confirmationCode)));
  if (byBooking.length) return { items: byBooking, productCopy: false };
  return { items: sameDay(idx.ext.get(k(c.externalRef))), productCopy: false };
}

/**
 * Pure: which archived bookings come back. `rows` is every booking in the range (any
 * status — live ones are what a candidate must not duplicate); `bokun` is Bókun's view.
 */
export function planRestore(rows: readonly Candidate[], bokun: readonly BokunItem[], today: string, archivedBefore: string | null): RestorePlan {
  const idx = { product: new Map<string, BokunItem>(), booking: new Map<string, BokunItem[]>(), ext: new Map<string, BokunItem[]>() };
  for (const b of bokun) {
    if (b.productCode) idx.product.set(k(b.productCode), b);
    if (b.bookingCode) idx.booking.set(k(b.bookingCode), [...(idx.booking.get(k(b.bookingCode)) ?? []), b]);
    if (b.ext) idx.ext.set(k(b.ext), [...(idx.ext.get(k(b.ext)) ?? []), b]);
  }
  const ref = (c: Candidate) => c.externalRef || c.confirmationCode || c.id;
  const exceptions: Exception[] = [];
  const ok: (Candidate & { productCopy: boolean })[] = [];
  for (const c of rows) {
    if (c.status !== "IGNORED") continue;
    const no = (reason: string) => exceptions.push({ id: c.id, ref: ref(c), date: c.date, reason });
    if (!c.date || c.date >= today) { no("not a past tour"); continue; }
    // Only what "Archive stale" could have hidden: it took tours dated before the day it ran.
    // A booking hidden after that was hidden by hand (Ignore), which leaves no note either.
    if (c.assignedGuideId) { no("hidden by hand (it has a guide)"); continue; }
    if (!archivedByNote(c.notes)) {
      if ((c.notes ?? "").trim()) { no("hidden by hand (it has a note)"); continue; }
      if (!archivedBefore || c.date >= archivedBefore) { no("not hidden by Archive stale (dated after it ran)"); continue; }
    }
    if (!c.tourId || c.slotIdx == null) { no("no tour or departure"); continue; }
    const { items, productCopy } = bokunFor(c, idx);
    if (!items.length) { no("Bókun has no booking for it on this date"); continue; }
    const bad = items.filter((x) => !(CONFIRMED_STATUSES as readonly string[]).includes(x.status ?? ""));
    if (bad.length) { no(`Bókun says ${[...new Set(bad.map((x) => x.status ?? "unknown"))].join("/")}`); continue; }
    if (productCopy && items[0].day !== c.date) { no(`Bókun has it on ${items[0].day ?? "another date"}`); continue; }
    ok.push({ ...c, productCopy });
  }

  // The same booking twice: the same code, or a search copy beside any copy with the same
  // OTA number, date and tour. A live copy always wins; between two coming back, the product copy.
  const sameKey = (c: Candidate) => `${k(c.externalRef)}|${c.date}|${c.tourId}`;
  const live = rows.filter((r) => LIVE.has(r.status));
  const liveCodes = new Set(live.map((r) => k(r.confirmationCode)).filter(Boolean));
  const liveKeys = new Set(live.filter((r) => k(r.externalRef)).map(sameKey));
  const productKeys = new Set(ok.filter((c) => c.productCopy && k(c.externalRef)).map(sameKey));
  const restore: Candidate[] = [];
  const seenCodes = new Set<string>();
  for (const c of ok) {
    const code = k(c.confirmationCode);
    const no = (reason: string) => exceptions.push({ id: c.id, ref: ref(c), date: c.date, reason });
    if (code && (liveCodes.has(code) || seenCodes.has(code))) { no("another copy of this booking is already on the board"); continue; }
    if (k(c.externalRef) && !c.productCopy && (liveKeys.has(sameKey(c)) || productKeys.has(sameKey(c)))) { no("a second copy of a booking that is already on the board or coming back"); continue; }
    if (k(c.externalRef) && c.productCopy && live.some((r) => sameKey(r) === sameKey(c) && !idx.product.has(k(r.confirmationCode)))) { no("the same booking is already on the board under the channel's code"); continue; }
    if (code) seenCodes.add(code);
    const { productCopy: _p, ...rest } = c;
    restore.push(rest);
  }
  restore.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || (a.slotIdx ?? 0) - (b.slotIdx ?? 0));
  const hash = createHash("sha256").update(restore.map((r) => r.id).sort().join(",")).digest("hex").slice(0, 32);
  return { restore, exceptions, hash };
}

const bangkokToday = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

/** Every Bókun product booking starting in the range, one month at a time (a read). */
export async function readBokun(from: string, to: string, search = searchBookings): Promise<{ ok: true; items: BokunItem[] } | { ok: false; reason: string }> {
  if (search === searchBookings && !bokunApiEnabled) return { ok: false, reason: "Bókun is not connected on this server (BOKUN_ACCESS_KEY / BOKUN_SECRET_KEY), so nothing can be checked. Nothing was changed." };
  const out = new Map<string, BokunItem>();
  let start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (start <= end) {
    const monthEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
    const stop = monthEnd < end ? monthEnd : end;
    for (let page = 1; page <= 60; page++) {
      const r = await search({ from: start.toISOString().slice(0, 10), to: stop.toISOString().slice(0, 10), page, pageSize: 100 });
      if (!r.ok) return { ok: false, reason: `Bókun could not be read (${r.status}${r.error ? `: ${r.error.slice(0, 120)}` : ""}). Nothing was changed.` };
      for (const it of r.items as Record<string, unknown>[]) {
        const b = toBokunItem(it);
        out.set(b.productCode ?? `${b.bookingCode}|${b.day}|${out.size}`, b);
      }
      if (r.items.length < 100) break;
    }
    start = new Date(Date.UTC(stop.getUTCFullYear(), stop.getUTCMonth(), stop.getUTCDate() + 1));
  }
  return { ok: true, items: [...out.values()] };
}

export async function loadRows(db: PrismaClient, from: string, to: string): Promise<Candidate[]> {
  return db.booking.findMany({
    where: { date: { gte: from, lte: to } },
    select: { id: true, source: true, confirmationCode: true, externalRef: true, status: true, date: true, slotIdx: true, tourId: true, pax: true, notes: true, assignedGuideId: true },
  });
}

export type PlanSummary = {
  from: string; to: string; hash: string;
  restore: { count: number; pax: number; departures: number; byMonth: Record<string, { bookings: number; pax: number; departures: number }> };
  exceptions: Exception[];
};

export function summarise(plan: RestorePlan, from: string, to: string): PlanSummary {
  const byMonth: PlanSummary["restore"]["byMonth"] = {};
  const deps = new Map<string, Set<string>>();
  for (const r of plan.restore) {
    const m = (r.date ?? "").slice(0, 7);
    const e = (byMonth[m] ??= { bookings: 0, pax: 0, departures: 0 });
    e.bookings++; e.pax += r.pax ?? 0;
    const s = deps.get(m) ?? new Set<string>(); s.add(`${r.date}|${r.slotIdx}`); deps.set(m, s);
  }
  for (const [m, s] of deps) byMonth[m].departures = s.size;
  return {
    from, to, hash: plan.hash,
    restore: { count: plan.restore.length, pax: plan.restore.reduce((t, r) => t + (r.pax ?? 0), 0), departures: new Set(plan.restore.map((r) => `${r.date}|${r.slotIdx}`)).size, byMonth },
    exceptions: plan.exceptions,
  };
}

/** The latest day "Archive stale" archived up to (exclusive), from its audit rows. */
export async function archivedBeforeDay(db: PrismaClient): Promise<string | null> {
  const runs = await db.auditLog.findMany({ where: { action: "bookings.archive_stale" }, select: { detail: true } });
  const days = runs.map((r) => String((r.detail as { upTo?: unknown } | null)?.upTo ?? "")).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  return days.at(-1) ?? null;
}

export async function previewRestore(db: PrismaClient, from: string, to: string, deps: { search?: typeof searchBookings; today?: string } = {}):
  Promise<{ ok: true; plan: RestorePlan; summary: PlanSummary } | { ok: false; reason: string }> {
  const archivedBefore = await archivedBeforeDay(db);
  if (!archivedBefore) return { ok: false, reason: "No \"Archive stale\" run is on record, so there is nothing it hid to bring back." };
  const bokun = await readBokun(from, to, deps.search);
  if (!bokun.ok) return bokun;
  const plan = planRestore(await loadRows(db, from, to), bokun.items, deps.today ?? bangkokToday(), archivedBefore);
  return { ok: true, plan, summary: summarise(plan, from, to) };
}

/**
 * Restore exactly the plan the admin looked at: it is worked out again, and refused if it
 * is not the same list (`hash`). Each booking moves only if it is still IGNORED.
 */
export async function applyRestore(db: PrismaClient, input: { from: string; to: string; hash: string; actor: { actorId: string | null; actorRole: string | null } },
  deps: { search?: typeof searchBookings; today?: string } = {}): Promise<{ ok: true; restored: number } | { ok: false; status: number; reason: string }> {
  const p = await previewRestore(db, input.from, input.to, deps);
  if (!p.ok) return { ok: false, status: 502, reason: p.reason };
  if (p.plan.hash !== input.hash) return { ok: false, status: 409, reason: "The list changed since you looked at it (a booking was changed, or Bókun now says something else). Preview again." };
  if (!p.plan.restore.length) return { ok: true, restored: 0 };
  const ids = p.plan.restore.map((r) => r.id);
  const r = await db.$transaction(async (tx) => {
    const noted = await tx.booking.updateMany({ where: { id: { in: ids }, status: "IGNORED", notes: { startsWith: ARCHIVED_NOTE } }, data: { status: "PENDING", notes: null } });
    const rest = await tx.booking.updateMany({ where: { id: { in: ids }, status: "IGNORED" }, data: { status: "PENDING" } });
    return { count: noted.count + rest.count };
  });
  await audit({
    ...input.actor, action: "bookings.archive_restored", entityType: "Booking",
    detail: {
      from: input.from, to: input.to, restored: r.count, planHash: p.plan.hash,
      bookings: p.plan.restore.map((b) => ({ id: b.id, ref: b.externalRef || b.confirmationCode, date: b.date, slotIdx: b.slotIdx, pax: b.pax })),
      exceptions: p.plan.exceptions.length,
      rule: "IGNORED with no note and no guide; every Bókun booking for it that day CONFIRMED/ARRIVED/NO_SHOW; same date; no other live copy",
    },
  });
  return { ok: true, restored: r.count };
}
