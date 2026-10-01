import type { PrismaClient } from "@prisma/client";
import { expenseAmount, isReviewExpense, type Expense } from "@/lib/jobsheet";
import { canonicalPaidBy, type PaidBy } from "@/lib/peak-sync";
import { expenseKind, PAID_BY_VALUE, type DefaultablePayer } from "@/lib/payer-rules";
import { isProtected, type ProtectedRow } from "@/lib/protected-expense-fields";
import { guideSlotBookings, SHEET_BOOKING_STATUSES } from "@/lib/sheet-bookings";

// The payer a job's expense rows are SUGGESTED from the Rate its guests booked.
//
// A Rate is not accounting evidence. A suggestion is stored as paidBySource "rate-default",
// is never stamped, counts as UNCONFIRMED everywhere money is worked out (lib/payer-rules
// effectivePayer → Payments v2, the job sheet summary, PEAK), and becomes a payer only
// when a person presses Confirm payer or picks one.
//
// Classification (deterministic; owner policy 2026-10-01). Matched on the Rate title Bókun
// sends, trimmed and case-insensitive:
//
//   TICKET_INCLUDED    the title says the entrance tickets are part of the package:
//                      "with (all) (entrance) tickets", "including/includes/included …
//                      tickets", "tickets included" — and does NOT negate it.
//   GUIDED_EXPERIENCE  the title is on the explicit guided list (GUIDED_TITLES), or says
//                      the tickets are NOT included ("no / without / excluding tickets",
//                      "tickets not included").
//   UNKNOWN            everything else, and a booking with no Rate recorded. Never guessed
//                      to be guided: an unknown Rate suggests nothing. Generic titles such
//                      as "Standard rate" are UNKNOWN until their Bókun rate configuration
//                      is verified (owner 2026-10-01) — the name says nothing about tickets.
//
// Suggestions, per row kind, only when EVERY booking on the job agrees:
//
//   entrance tickets   all TICKET_INCLUDED   → Company Resource (stored "company": the
//                                              company/package paid; not reimbursed, no
//                                              advance to settle). Never Company Advance.
//                      any other mix         → nothing; flagged for review when the mix
//                                              includes a ticket-inclusive or unknown Rate
//   water, ferry, bus, all GUIDED_EXPERIENCE → Guide Own Money ("guide")
//   local transport,   any other mix         → nothing; flagged for review if a Rate is
//   lotus                                      unknown
//
// A row is never split between Rates: one row has one payer, and a row the guests' Rates
// disagree on is left for a person.
//
// What a suggestion may write over: no payer, an earlier suggestion, the after-tour default
// or an unconfirmed payer — never a payer a person or the guide chose, never a stamped,
// waived or certificate-requested row, never a category default payments already rely on.

export type RateKind = "TICKET_INCLUDED" | "GUIDED_EXPERIENCE" | "UNKNOWN";
export const RATE_KIND_LABEL: Record<RateKind, string> = {
  TICKET_INCLUDED: "tickets included",
  GUIDED_EXPERIENCE: "guided experience",
  UNKNOWN: "not recognised",
};

/** Rate titles verified (in Bókun's rate configuration) to be a guided experience without tickets. Empty until one is. */
export const GUIDED_TITLES: readonly string[] = [];
const NEGATED = /\b(no|not|without|excluding|excl\.?|except)\b[^.]*\btickets?\b|\btickets?\s+(are\s+)?not\s+included\b/i;
const TICKETS_INCLUDED = /\b(with|incl(?:uding|udes|uded)?)\s+(all\s+)?(the\s+)?(entrance\s+|entry\s+|admission\s+)?tickets?\b|\btickets?\s+(are\s+)?included\b/i;

/** The kind of a Rate by its title. No title, or one nothing here recognises, is UNKNOWN. */
export function rateKind(title: string | null | undefined): RateKind {
  const t = (title ?? "").trim().replace(/\s+/g, " ");
  if (!t) return "UNKNOWN";
  if (NEGATED.test(t)) return "GUIDED_EXPERIENCE";
  if (TICKETS_INCLUDED.test(t)) return "TICKET_INCLUDED";
  if (GUIDED_TITLES.includes(t.toLowerCase())) return "GUIDED_EXPERIENCE";
  return "UNKNOWN";
}

/** The Rates of a job's bookings: the kinds present, and each title with how many bookings carry it. */
export type JobRates = { kinds: RateKind[]; titles: { title: string | null; kind: RateKind; bookings: number }[] };

export function summariseRates(bookings: { rateTitle?: string | null }[]): JobRates {
  const byTitle = new Map<string, { title: string | null; kind: RateKind; bookings: number }>();
  for (const b of bookings) {
    const title = (b.rateTitle ?? "").trim() || null;
    const key = title ?? "\u0000none";
    const hit = byTitle.get(key);
    if (hit) hit.bookings++; else byTitle.set(key, { title, kind: rateKind(title), bookings: 1 });
  }
  const titles = [...byTitle.values()].sort((a, b) => (a.title ?? "").localeCompare(b.title ?? ""));
  return { kinds: [...new Set(titles.map((t) => t.kind))].sort() as RateKind[], titles };
}

/** Rows a guide normally fronts on the day: transport, and the standard water and lotus lines. */
function isOperational(e: Expense): boolean {
  if (expenseKind(e) === "TRANSPORT") return true;
  return /^\s*(water|lotus)\b/i.test(e.description ?? "");
}

export type RateSuggestion =
  | { payer: DefaultablePayer }
  | { review: "MIXED" | "UNKNOWN"; why: string }
  | null;

const only = (rates: JobRates, k: RateKind) => rates.kinds.length === 1 && rates.kinds[0] === k;

/** What the job's Rates suggest for this row: a payer, a reason to review, or nothing. */
export function rateDefaultFor(e: Expense, rates: JobRates): RateSuggestion {
  if (isReviewExpense(e) || !rates.kinds.length) return null;
  const unknown = rates.kinds.includes("UNKNOWN");
  if (expenseKind(e) === "ENTRANCE_TICKET") {
    if (only(rates, "TICKET_INCLUDED")) return { payer: "COMPANY_DIRECT" };
    if (rates.kinds.includes("TICKET_INCLUDED")) return { review: "MIXED", why: "some guests' Rate includes the tickets and some guests' does not" };
    if (unknown) return { review: "UNKNOWN", why: "a guest's Rate is not recognised" };
    return null; // all guided: the tickets are not the package's, and nothing here says who bought them
  }
  if (isOperational(e)) {
    if (only(rates, "GUIDED_EXPERIENCE")) return { payer: "GUIDE_PERSONAL" };
    if (unknown) return { review: "UNKNOWN", why: "a guest's Rate is not recognised" };
    return null;
  }
  return null;
}

/** The payer a row is expected to have under these Rates, when they suggest one — what an override departs from (lib/payer-rules). */
export function expectedPayerFrom(rates: JobRates): (e: Expense) => DefaultablePayer | null {
  return (e) => { const s = rateDefaultFor(e, rates); return s && "payer" in s ? s.payer : null; };
}

const SUGGESTION_SOURCES = new Set(["rate-default"]);
const REPLACEABLE = new Set(["default-after-tour", "unconfirmed", "rate-default"]);

export type RatePayerRow = Expense & ProtectedRow & { rateBasis?: string | null };

/** May a suggestion be written over this row's payer? Only over no payer, or a default nobody confirmed. */
export function rateDefaultMayReplace(e: RatePayerRow): boolean {
  if (isProtected(e)) return false;
  const payer = (e.paidBy ?? "").trim();
  const source = (e.paidBySource ?? "").trim();
  if (!payer) return true;
  return REPLACEABLE.has(source);
}

const LABEL: Record<PaidBy, string> = { GUIDE_PERSONAL: "Guide Own Money", GUIDE_ADVANCE: "Company Advance", COMPANY_DIRECT: "Company Resource", UNSPECIFIED: "not set" };

export type RateReview = { description: string; reason: string };
export type RateApplied<T> = { rows: T[]; review: RateReview[]; conflicts: RateReview[] };

/**
 * Apply the job's Rate suggestions to these rows. Pure.
 *
 * `onlyExisting`: refresh suggestions already on rows (a booking joined or left the job —
 * lib/booking-reconcile) without filling rows nobody suggested anything for yet. A
 * suggestion the new Rates no longer support is taken off, so a stale guess never stands.
 *
 * Returns the rows, the rows left for review (mixed or unknown Rates), and confirmed rows
 * whose payer the current Rates disagree with — reported, never changed.
 */
export function applyRateDefaults<T extends RatePayerRow>(rows: T[], rates: JobRates, opts: { onlyExisting?: boolean } = {}): RateApplied<T> {
  const review: RateReview[] = [], conflicts: RateReview[] = [];
  const out = rows.map((e) => {
    if (isReviewExpense(e) || expenseAmount(e) <= 0) return e;
    const what = (e.description ?? "").trim() || "an expense row";
    const d = rateDefaultFor(e, rates);
    const source = (e.paidBySource ?? "").trim();
    const isSuggestion = SUGGESTION_SOURCES.has(source);
    if (!rateDefaultMayReplace(e)) {
      // Somebody's payer. Never changed — only reported when the booked Rates now disagree.
      const stored = canonicalPaidBy(e);
      if (d && "payer" in d && stored !== "UNSPECIFIED" && stored !== d.payer) conflicts.push({ description: what, reason: `confirmed as ${LABEL[stored]}, but the booked Rates suggest ${LABEL[d.payer]}` });
      if (d && "review" in d && stored !== "UNSPECIFIED") conflicts.push({ description: what, reason: `confirmed as ${LABEL[stored]}, but ${d.why}` });
      return e;
    }
    if (opts.onlyExisting && !isSuggestion) return e;
    if (d && "payer" in d) {
      const paidBy = PAID_BY_VALUE[d.payer];
      const rateBasis = rates.kinds.join("+");
      if ((e.paidBy ?? "").trim() === paidBy && isSuggestion && e.rateBasis === rateBasis) return e;
      return { ...e, paidBy, paidBySource: "rate-default" as const, rateBasis };
    }
    if (d && "review" in d) review.push({ description: what, reason: d.why });
    if (isSuggestion) {
      // The suggestion no longer holds: take it off rather than leave a stale guess.
      const { rateBasis: _r, ...rest } = e;
      return { ...rest, paidBy: "", paidBySource: undefined } as T;
    }
    return e;
  });
  return { rows: out, review, conflicts };
}

type Db = Pick<PrismaClient, "assignment" | "booking" | "jobSheet">;

/** The Rates of this guide's own bookings on a job: live bookings at the slot, on the job's tour, their share if split. */
export async function jobRates(db: Db, key: { guideId: string; date: string; slotIdx: number }): Promise<JobRates> {
  const assignment = await db.assignment.findUnique({ where: { guideId_date_slotIdx: key }, select: { tourId: true } });
  const tourId = assignment?.tourId
    ?? (await db.jobSheet.findUnique({ where: { guideId_date_slotIdx: key }, select: { tourId: true } }))?.tourId
    ?? null;
  const atSlot = await db.booking.findMany({
    where: { date: key.date, slotIdx: key.slotIdx, status: { in: [...SHEET_BOOKING_STATUSES] } },
    select: { rateTitle: true, assignedGuideId: true, tourId: true },
  });
  const sameTour = atSlot.filter((b) => !tourId || !b.tourId || b.tourId === tourId);
  return summariseRates(guideSlotBookings(sameTour, key.guideId));
}
