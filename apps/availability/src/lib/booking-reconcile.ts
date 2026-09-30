import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { bookingRef } from "@/lib/booking-ref";
import { SLOT_TIMES } from "@/lib/slots";
import { tourStartMs } from "@/lib/no-show-count";
import { toSheetBooking, SHEET_BOOKING_STATUSES, type SheetBooking } from "@/lib/sheet-bookings";
import { isReviewExpense, isApproved, type Expense } from "@/lib/jobsheet";
import { isProtected, type ProtectedRow } from "@/lib/protected-expense-fields";
import { financialHistoryBlockers } from "@/lib/payments-v2/history";

// One place that carries booking changes all the way to the guides' jobs.
//
// A booking existing in FolkOPS is not the same as the guide knowing about it. On 13 Sep
// 2026 a Viator booking (2 pax) arrived five hours before an 08:30 departure that already
// had a guide and a job sheet. It was imported, held as PENDING for an operator to place,
// never placed — and the sheet kept 6 guests while 8 came.
//
// THE UNIT IS THE DEPARTURE (date + slot), NOT THE BOOKING. A booking event only says which
// departure became dirty; the database says what that departure should look like now. One
// run takes every booking at the departure, decides which guide's job each one belongs to,
// and brings every job there to that final state at once — so a stale cancelled row and a
// new late booking give 6 → 8 in one step, never 6 → 10 → 8.
//
// WHEN IN DOUBT, NOTHING MOVES. A booking is placed on a guide's job only when exactly one
// job can be its: an operator put it on that guide's sheet, or tagged it to that guide, or
// that guide is the only one running the booking's (mapped) tour at that time and nobody
// split the departure. Anything else — no tour mapped, two guides and no tag, a tag or tour
// that contradicts the sheet it is on, a booking on two sheets — is left for an operator
// with a review issue, and the jobs it could belong to are not changed at all (no rows
// added or removed, no expected pax recounted) until someone decides.
//
// ALL OR NOTHING. For each departure the booking placement, the assignment's expected pax,
// the job sheet's rows, the derived expense counts and their audit records are written in
// ONE database transaction. It first locks the departure's assignment rows, then its job
// sheet rows, and only then reads them: until it commits, no save, approval or certificate
// can change those sheets, so what it read is what it writes over. What a row lock cannot
// stop — a new guide or sheet appearing, a payment or advance recorded meanwhile — is
// checked again just before writing; if anything changed the whole transaction rolls back
// and the departure is recomputed once from fresh state. A second loss writes nothing and
// raises BOOKING_RECONCILIATION_CONFLICT. Notices and review alerts go out only after the
// commit; a failed notice never undoes correct data.
//
// NEVER TOUCHED: a guest's ACTUAL count or no-show, the guide's own expense report, any
// expense row a person confirmed (payer chosen by the operator or guide, payer stamp,
// waiver, certificate request), an approved sheet, a job with a certificate, a payment, a
// PEAK document or an advance, and anything after the tour started. Those raise an issue
// and leave the WHOLE job as it was — the booking is not placed and the expected pax is not
// changed either, so the guide's job never half-follows a booking.
//
// The canonical booking (what the channel says) is saved by the importer before this runs
// and is never rolled back here: this service only decides the OPERATIONAL placement.

type Db = typeof prisma;
type Tx = Prisma.TransactionClient;
export type Departure = { date: string; slotIdx: number };
export type ReconcileSource = "webhook" | "autosync" | "manual-sync" | "csv" | "sweep" | "test";
export type Notifier = {
  ops: (message: string, title: string, body: string, opts?: { push?: boolean; date?: string; dedupe?: boolean }) => Promise<void>;
  guide: (guideId: string, message: string, title: string, body: string) => Promise<void>;
};
export type ReconcileOptions = {
  source: ReconcileSource;
  reason?: string;
  now?: () => Date;
  db?: Db;
  /** Where notices go (default: the app's ops inbox + guide channels). */
  notifier?: Notifier;
  /** Departures the booking was on before this change (a moved booking). */
  previous?: Departure[];
  /** Test seam: runs after everything is read and decided, before the final validation and the writes. */
  beforeWrite?: (attempt: number) => Promise<void>;
};

export type ReviewCode = "BOOKING_JOB_MATCH_REVIEW_REQUIRED" | "BOOKING_RECONCILIATION_REVIEW_REQUIRED" | "BOOKING_MOVED_REVIEW_REQUIRED" | "DUPLICATE_BOOKING_REFERENCE_REVIEW_REQUIRED";
export type ReconcileOutcome =
  | { kind: "skipped"; why: string }
  | { kind: "no-job" }
  | { kind: "review-required"; code: ReviewCode; why: string }
  | { kind: "post-start"; flagged: boolean }
  | { kind: "blocked"; why: string[] }
  | { kind: "conflict" }
  | { kind: "reconciled"; guideId: string; changed: string[] };

const LIVE = SHEET_BOOKING_STATUSES; // PENDING, OFFERED, ASSIGNED
const INC_GUIDE = /inc\.?\s*guide/i;

/** Post-start disagreements are flagged only for tours on or after this date, so turning the
 *  feature on does not raise an alarm for every historical sheet at once. */
export const FLAG_POST_START_SINCE = process.env.BOOKING_RECONCILE_FLAG_SINCE || "2026-10-01";
/** How long after the start a disagreement is still worth raising automatically. */
const POST_START_FLAG_DAYS = 7;

const norm = (s?: string | null) => (s ?? "").trim().toLowerCase();
const guestsOf = (rows: SheetBooking[]) => rows.reduce((s, r) => s + (Number(r.bookedPax) || 0), 0);
/** The quantity fill-down gives a row for this many guests — the rule in lib/jobsheet. */
export const derivedQty = (e: { description?: string | null }, guests: number) => (INC_GUIDE.test(e.description ?? "") ? guests + 1 : guests);
const refKeys = (b: { externalRef?: string | null; confirmationCode?: string | null }) =>
  [b.externalRef, b.confirmationCode].map(norm).filter(Boolean);
const rawRefs = (b: { externalRef?: string | null; confirmationCode?: string | null }) =>
  [b.externalRef, b.confirmationCode].map((x) => (x ?? "").trim()).filter(Boolean);
const rowKey = (r: { bookingNo?: string | null }) => norm(r.bookingNo);
export const depKey = (d: Departure) => `${d.date}|${d.slotIdx}`;
const when = (d: Departure) => `${d.date} ${SLOT_TIMES[d.slotIdx] ?? ""}`.trim();
/** A row somebody recorded something on: an actual count, a no-show, a status, ticket
 *  details. Never removed automatically. */
export const rowHasEvidence = (r: SheetBooking & { noShowPax?: number | null }) =>
  r.actualPax != null || !!(r.status ?? "").trim() || (r.noShowPax ?? 0) > 0 || !!String(r.tickets ?? "").trim();
/** An expense row whose payer a PERSON chose (operator on the sheet, guide in the app). */
const payerConfirmed = (e: Expense) => ["operator", "guide"].includes((e.paidBySource ?? "").trim()) && !!(e.paidBy ?? "").trim();

// ── Ownership: whose job is each booking? (pure) ────────────────────────────

export type PlanBooking = { id: string; status: string; tourId: string | null; assignedGuideId: string | null; externalRef: string | null; confirmationCode: string | null; pax: number | null };
export type PlanAssign = { guideId: string; tourId: string };
export type PlanSheet = { guideId: string; rows: SheetBooking[] };
export type Plan = {
  /** live booking id → the one guide whose job it is */
  owner: Map<string, string>;
  /** live bookings nobody may place automatically, and why */
  review: Map<string, { why: string; guides: string[]; code: ReviewCode }>;
  /** guideId → why that guide's job must not be changed by this run */
  frozen: Map<string, string[]>;
  /** cancelled booking id → the one guide whose sheet still lists it */
  cancelHolder: Map<string, string>;
  /** rows to take off a sheet because the booking's tour is no longer that job's tour */
  release: { guideId: string; bookingId: string; why: string }[];
};

/**
 * Decide, for one departure, which guide's job each booking is. Pure: the same inputs give
 * the same plan. `releasable(guideId, row)` says whether a row may come off that guide's
 * sheet (sheet editable, row carries no attendance); without it nothing is released.
 */
export function planDeparture(assigns: PlanAssign[], bookings: PlanBooking[], sheets: PlanSheet[], opts: { releasable?: (guideId: string, row: SheetBooking) => boolean } = {}): Plan {
  const plan: Plan = { owner: new Map(), review: new Map(), frozen: new Map(), cancelHolder: new Map(), release: [] };
  const assignOf = new Map(assigns.map((a) => [a.guideId, a]));
  const freeze = (g: string, why: string) => { if (!assignOf.has(g)) return; const l = plan.frozen.get(g) ?? []; l.push(why); plan.frozen.set(g, l); };
  const rowOn = (g: string, b: PlanBooking) => sheets.find((s) => s.guideId === g)?.rows.find((r) => refKeys(b).includes(rowKey(r)));
  const holdersOf = (b: PlanBooking) => { const k = refKeys(b); return sheets.filter((s) => s.rows.some((r) => k.includes(rowKey(r)))).map((s) => s.guideId); };
  const live = bookings.filter((b) => LIVE.includes(b.status));
  const candidatesOf = (b: PlanBooking) => (b.tourId ? assigns.filter((a) => a.tourId === b.tourId) : assigns).map((a) => a.guideId);

  // One booking identity, two live records at this departure (an OTA ref or a code shared):
  // nothing can say which record is the guest, so neither is counted, placed or written, and
  // every job either could touch is left exactly as it is.
  const dupOf = new Map<string, PlanBooking[]>();
  for (const b of live) {
    const twins = live.filter((x) => x.id !== b.id && refKeys(x).some((k) => refKeys(b).includes(k)));
    if (twins.length) dupOf.set(b.id, twins);
  }
  // One sheet listing the same booking twice: the rows cannot be told apart either.
  const doubleListed = new Set<string>();
  for (const s of sheets) for (const b of live) if (s.rows.filter((r) => refKeys(b).includes(rowKey(r))).length > 1) { doubleListed.add(b.id); }

  for (const b of live) {
    const ref = bookingRef(b.externalRef, b.confirmationCode) || "a booking";
    const toReview = (why: string, guides: string[], code: ReviewCode = "BOOKING_JOB_MATCH_REVIEW_REQUIRED") => {
      plan.review.set(b.id, { why, guides: [...new Set(guides)], code });
      for (const g of new Set(guides)) freeze(g, `${ref}: ${why}`);
    };
    const holders = holdersOf(b);
    if (dupOf.has(b.id) || doubleListed.has(b.id)) {
      const group = [b, ...(dupOf.get(b.id) ?? [])];
      const affected = [...holders, ...group.flatMap((x) => holdersOf(x)), ...group.flatMap(candidatesOf), ...group.map((x) => x.assignedGuideId).filter((g): g is string => !!g)];
      toReview(dupOf.has(b.id) ? `${group.length} live booking records share the booking reference ${ref}` : `${ref} is listed more than once on one job sheet`, affected, "DUPLICATE_BOOKING_REFERENCE_REVIEW_REQUIRED");
      continue;
    }
    if (holders.length > 1) { toReview(`it is listed on ${holders.length} job sheets (${holders.join(", ")})`, holders); continue; }
    let released = false;
    if (holders.length === 1) {
      const h = holders[0], ha = assignOf.get(h);
      if (!ha) { toReview(`it is on the job sheet of ${h}, who is no longer assigned to this departure`, []); continue; }
      if (b.assignedGuideId && b.assignedGuideId !== h) { toReview(`it is on ${h}'s job sheet but tagged to ${b.assignedGuideId}`, [h, b.assignedGuideId]); continue; }
      // On a sheet, with no tour of its own or this job's tour: an operator put it there.
      if (!b.tourId || b.tourId === ha.tourId) { plan.owner.set(b.id, h); continue; }
      // Its tour is no longer this job's tour. It comes off only if the row is clean and the
      // job will certainly be written (the caller decides that — see reconcileInTx).
      const row = rowOn(h, b)!;
      if (!opts.releasable?.(h, row)) { toReview(`its tour is now ${b.tourId} but it is on ${h}'s ${ha.tourId} job sheet`, [h]); continue; }
      plan.release.push({ guideId: h, bookingId: b.id, why: `tour changed to ${b.tourId}` });
      released = true;
    }
    // Not on any sheet (or released): placed only when exactly one job can be its.
    // A released booking with no such job goes back to the inbox (reviewed), never left as
    // an OFFERED booking that no job holds.
    const unowned = (why: string, guides: string[]) => { if (released || assigns.length) toReview(why, guides); };
    if (!b.tourId) { unowned("the booking has no tour mapped yet", []); continue; }
    const cands = assigns.filter((a) => a.tourId === b.tourId).map((a) => a.guideId);
    if (b.assignedGuideId) {
      if (cands.includes(b.assignedGuideId)) plan.owner.set(b.id, b.assignedGuideId);
      else toReview(`it is tagged to ${b.assignedGuideId}, who is not running this tour at this time`, [...cands, b.assignedGuideId]);
      continue;
    }
    if (!cands.length) { if (released) toReview(`its tour is now ${b.tourId} and nobody runs that tour at this time`, []); continue; }
    if (cands.length > 1) { toReview(`${cands.length} guides run this departure and the booking is tagged to none of them`, cands); continue; }
    const otherTags = live.filter((x) => x.tourId === b.tourId && x.assignedGuideId && x.assignedGuideId !== cands[0]);
    if (otherTags.length) { toReview("the departure is split between guides and this booking is tagged to none of them", [cands[0], ...otherTags.map((x) => x.assignedGuideId!)]); continue; }
    plan.owner.set(b.id, cands[0]);
  }

  for (const b of bookings.filter((x) => x.status === "CANCELLED")) {
    const holders = holdersOf(b);
    if (holders.length === 1) plan.cancelHolder.set(b.id, holders[0]);
    else if (holders.length > 1) for (const g of holders) freeze(g, `${bookingRef(b.externalRef, b.confirmationCode)}: a cancelled booking is listed on ${holders.length} job sheets`);
  }
  return plan;
}

// ── Results ──────────────────────────────────────────────────────────────────

type JobState = { status: "unchanged" | "reconciled" | "blocked" | "review" | "frozen"; changed: string[]; why: string[] };
export type DepartureResult = {
  kind: "skipped" | "no-job" | "post-start" | "done" | "conflict";
  why?: string;
  flagged?: number;
  plan?: Plan;
  jobs: Map<string, JobState>;
  placed: Set<string>;
  frozenBy: Map<string, ReviewCode>;
};
type Issue = { code: string; entity: { type: string; id: string }; sig: string; detail: Record<string, unknown>; message: string; push?: boolean; date?: string };
type Notice = { guideId: string; key: string; entityId: string; ops: [string, string, string] | null; guide: [string, string, string]; date: string };

class Conflict extends Error {}
const isRetryable = (e: unknown) => e instanceof Conflict || ["P2034", "P2028"].includes((e as { code?: string })?.code ?? "");

// ── Entry points ─────────────────────────────────────────────────────────────

/** Reconcile the departure(s) one booking change touches: where it was, then where it is. */
export async function reconcileBookingChange(bookingId: string, opts: ReconcileOptions): Promise<ReconcileOutcome> {
  const db = opts.db ?? prisma;
  const b = await db.booking.findUnique({ where: { id: bookingId }, select: { id: true, status: true, date: true, slotIdx: true } });
  if (!b) return { kind: "skipped", why: "no such booking" };
  // A hidden duplicate is not a booking of its own; its live twin carries the change.
  if (b.status === "IGNORED") return { kind: "skipped", why: "hidden duplicate" };
  const results = await reconcileBookings([{ id: bookingId, previous: opts.previous }], opts);
  if (!b.date || b.slotIdx == null) return { kind: "skipped", why: "not on a departure" };
  const r = results.get(depKey({ date: b.date, slotIdx: b.slotIdx }));
  return r ? outcomeFor(bookingId, r) : { kind: "skipped", why: "long past" };
}

/**
 * Reconcile every departure these bookings touch, each ONCE — the batch entry for the
 * autosync and the sweep. Departures a booking moved away from go first, so a booking
 * leaves its old job before it joins the new one.
 */
export async function reconcileBookings(items: { id: string; previous?: Departure[] }[], opts: ReconcileOptions): Promise<Map<string, DepartureResult>> {
  const db = opts.db ?? prisma;
  const out = new Map<string, DepartureResult>();
  if (!items.length) return out;
  const nowMs = (opts.now ?? (() => new Date()))().getTime();
  const bookings = await db.booking.findMany({ where: { id: { in: [...new Set(items.map((i) => i.id))] } }, select: { id: true, status: true, date: true, slotIdx: true, externalRef: true, confirmationCode: true } });
  const current = new Map<string, Departure>();
  const old = new Map<string, Departure>();
  const add = (m: Map<string, Departure>, d: Departure | null) => { if (d && tourStartMs(d.date, d.slotIdx) >= nowMs - POST_START_FLAG_DAYS * 86400_000) m.set(depKey(d), d); };
  for (const b of bookings) if (b.status !== "IGNORED" && b.date && b.slotIdx != null) add(current, { date: b.date, slotIdx: b.slotIdx });
  for (const i of items) for (const d of i.previous ?? []) add(old, d);
  // Upcoming sheets that still list one of these bookings at another departure: it moved.
  const refs = [...new Set(bookings.filter((b) => b.status !== "IGNORED").flatMap(rawRefs))];
  if (refs.length) {
    const today = new Date(nowMs + 7 * 3600_000).toISOString().slice(0, 10);
    for (let i = 0; i < refs.length; i += 200) {
      const chunk = refs.slice(i, i + 200);
      const sheets = await db.jobSheet.findMany({ where: { date: { gte: today }, OR: chunk.map((r) => ({ bookings: { array_contains: [{ bookingNo: r }] } })) }, select: { date: true, slotIdx: true } });
      for (const s of sheets) add(old, { date: s.date, slotIdx: s.slotIdx });
    }
  }
  for (const k of current.keys()) old.delete(k);
  for (const d of [...old.values(), ...current.values()]) out.set(depKey(d), await reconcileDeparture(d, opts));
  return out;
}

/** Bring every guide job at one departure to the state its bookings say, atomically. */
export async function reconcileDeparture(dep: Departure, opts: ReconcileOptions): Promise<DepartureResult> {
  const db = opts.db ?? prisma;
  const now = (opts.now ?? (() => new Date()))().getTime();
  const start = tourStartMs(dep.date, dep.slotIdx);
  const empty = (kind: DepartureResult["kind"], why?: string): DepartureResult => ({ kind, why, jobs: new Map(), placed: new Set(), frozenBy: new Map() });
  // Old history is not this service's business.
  if (start < now - POST_START_FLAG_DAYS * 86400_000) return empty("skipped", "long past");
  if (now >= start) return postStart(db, dep, opts);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const run = await db.$transaction((tx) => reconcileInTx(tx, dep, opts, attempt, now), { maxWait: 10_000, timeout: 20_000 });
      await afterCommit(db, run.issues, run.notices, opts);
      return run.result;
    } catch (e) {
      if (!isRetryable(e)) throw e;
      if (attempt === 2) {
        await afterCommit(db, [issue("BOOKING_RECONCILIATION_CONFLICT", { type: "Departure", id: depKey(dep) }, `${Math.floor(now / 3600_000)}`,
          { date: dep.date, slotIdx: dep.slotIdx, source: opts.source, why: "the job was saved by someone else twice while it was being reconciled" },
          `${when(dep)}: the job was being updated from its bookings while someone was editing it, twice. Nothing was changed — open the job sheet and check its guests.`, dep.date, true)], [], opts);
        return empty("conflict");
      }
    }
  }
  return empty("conflict");
}

// ── Before the start: one transaction per departure ──────────────────────────

type SheetRow = SheetBooking & { noShowPax?: number | null };
type LoadedBooking = PlanBooking & { customerName: string | null; source: string | null; noShow: boolean; noShowPax: number };
type Removed = { key: string; why: string; kind: "cancelled" | "released" | "moved"; bookingId?: string; to?: Departure };
type Draft = {
  a: { id: string; guideId: string; tourId: string; pax: number | null };
  sheet: { id: string; ref: string | null } | undefined;
  owned: LoadedBooking[]; toPlace: LoadedBooking[]; expected: number; recount: boolean;
  newRows: SheetRow[] | null; newExpenses: (Expense & ProtectedRow)[] | null;
  added: SheetRow[]; removed: Removed[]; resized: { key: string; from: number | null; to: number | null }[];
  recalculated: { description: string; from: number; to: number }[]; warnings: string[];
  sheetOld: number; sheetNew: number; changed: string[];
};

const assignSig = (xs: { id: string; guideId: string; tourId: string; pax: number | null }[]) => xs.map((a) => `${a.id}:${a.guideId}:${a.tourId}:${a.pax}`).sort().join(",");
const sheetSig = (xs: { id: string; updatedAt: Date }[]) => xs.map((x) => `${x.id}:${x.updatedAt.getTime()}`).sort().join(",");

async function reconcileInTx(tx: Tx, dep: Departure, opts: ReconcileOptions, attempt: number, now: number) {
  const result: DepartureResult = { kind: "done", jobs: new Map(), placed: new Set(), frozenBy: new Map() };
  const issues: Issue[] = [];
  const notices: Notice[] = [];

  // ── 1. Locks, always in this order: the departure's assignments, then its job sheets by id.
  // While they are held nobody can save, approve, certify or re-assign these jobs' rows, so
  // everything read below is the state the writes land on. (A NEW assignment or sheet row
  // is not stopped by a row lock; the final validation catches those.)
  await tx.$queryRaw`SELECT id FROM "Assignment" WHERE "date" = ${dep.date} AND "slotIdx" = ${dep.slotIdx} ORDER BY id FOR UPDATE`;
  const assigns = await tx.assignment.findMany({ where: dep, select: { id: true, guideId: true, tourId: true, pax: true }, orderBy: { id: "asc" } });
  if (!assigns.length) return { result: { ...result, kind: "no-job" as const }, issues, notices };
  await tx.$queryRaw`SELECT id FROM "JobSheet" WHERE "date" = ${dep.date} AND "slotIdx" = ${dep.slotIdx} ORDER BY id FOR UPDATE`;

  const bookings: LoadedBooking[] = await tx.booking.findMany({
    where: { ...dep, status: { in: [...LIVE, "CANCELLED"] } },
    select: { id: true, status: true, tourId: true, assignedGuideId: true, externalRef: true, confirmationCode: true, pax: true, customerName: true, source: true, noShow: true, noShowPax: true },
    orderBy: { createdAt: "asc" },
  });
  const sheets = await tx.jobSheet.findMany({ where: dep, orderBy: { id: "asc" }, select: { id: true, ref: true, guideId: true, bookings: true, expenses: true, updatedAt: true, guideExpensesAt: true, approvalStatus: true, peakDocumentNo: true } });
  const rowsOf = (s: { bookings: unknown }) => ((s.bookings as unknown as SheetRow[]) ?? []);
  const sheetOf = (g: string) => sheets.find((s) => s.guideId === g);
  const isAssigned = (g: string) => assigns.some((a) => a.guideId === g);
  const refOf = (b: LoadedBooking) => bookingRef(b.externalRef, b.confirmationCode) || "a booking";

  // Why a job may not change automatically (memoised: asked only when needed).
  const blockerCache = new Map<string, Promise<string[]>>();
  const blockersOf = (g: string) => {
    if (!blockerCache.has(g)) blockerCache.set(g, jobBlockers(tx, sheetOf(g) ?? null, { guideId: g, ...dep }));
    return blockerCache.get(g)!;
  };
  const editable = new Map<string, boolean>();
  const checkEditable = async (g: string) => {
    if (!editable.has(g)) { const s = sheetOf(g); editable.set(g, !(s && isApproved(s.approvalStatus)) && !(await blockersOf(g)).length); }
    return editable.get(g)!;
  };

  // Rows whose booking is no longer at this departure at all: it moved (date, time or slot).
  const here = new Set(bookings.flatMap(refKeys));
  const strayKeys = [...new Set(sheets.filter((s) => isAssigned(s.guideId)).flatMap((s) => rowsOf(s).map(rowKey)).filter((k) => k && !here.has(k)))];
  const moved = new Map<string, Departure>(); // row key → where the booking is now
  if (strayKeys.length) {
    const found = await tx.booking.findMany({
      where: { status: { not: "IGNORED" }, OR: [{ externalRef: { in: strayKeys, mode: "insensitive" } }, { confirmationCode: { in: strayKeys, mode: "insensitive" } }] },
      select: { externalRef: true, confirmationCode: true, date: true, slotIdx: true, status: true },
    });
    for (const k of strayKeys) {
      const f = found.filter((x) => refKeys(x).includes(k));
      const to = f.find((x) => LIVE.includes(x.status)) ?? f[0];
      if (to && to.date && to.slotIdx != null) moved.set(k, { date: to.date, slotIdx: to.slotIdx });
    }
  }
  // Editability is needed up front only for sheets that may have to give a row up.
  for (const s of sheets) {
    if (!isAssigned(s.guideId)) continue;
    const tourHere = assigns.find((a) => a.guideId === s.guideId)!.tourId;
    const mayRelease = rowsOf(s).some((r) => {
      const k = rowKey(r);
      if (!k) return false;
      if (moved.has(k)) return true;
      const b = bookings.find((x) => LIVE.includes(x.status) && refKeys(x).includes(k));
      return !!(b && b.tourId && b.tourId !== tourHere);
    });
    if (mayRelease) await checkEditable(s.guideId);
  }

  // ── 2. Plan, then settle it: a row may leave a job only if that job is certainly written.
  // A planned release is not a release. If the old job turns out frozen for ANY reason (an
  // ambiguous booking, a moved row it cannot give up, a booking still on another sheet), the
  // release is withdrawn and the plan is made again with that job holding its rows — so the
  // booking stays where it is and goes to review, and no second job ever receives it.
  const noRelease = new Set<string>();
  const releasable = (g: string, row: SheetBooking) => !noRelease.has(g) && editable.get(g) === true && !rowHasEvidence(row as SheetRow);
  const elsewhereMemo = new Map<string, string | null>();
  const elsewhereOf = async (b: LoadedBooking) => {
    if (!elsewhereMemo.has(b.id)) elsewhereMemo.set(b.id, await listedElsewhere(tx, b, dep, now));
    return elsewhereMemo.get(b.id)!;
  };
  let plan!: Plan;
  let frozenMoved = new Map<string, { sheetId: string; ref: string | null; row: string; to: Departure; why: string }[]>();
  let frozenLate = new Map<string, string>();
  const frozenNow = (g: string) => plan.frozen.has(g) || frozenMoved.has(g) || frozenLate.has(g);
  for (let pass = 0; ; pass++) {
    plan = planDeparture(assigns, bookings, sheets.map((s) => ({ guideId: s.guideId, rows: rowsOf(s) })), { releasable });
    frozenMoved = new Map();
    for (const s of sheets) for (const r of rowsOf(s)) {
      const to = moved.get(rowKey(r));
      if (!to || !isAssigned(s.guideId) || releasable(s.guideId, r)) continue;
      const why = `${r.bookingNo} moved to ${when(to)} but its row here cannot be removed automatically (${rowHasEvidence(r) ? "something is recorded on it" : "the job sheet is locked"})`;
      frozenMoved.set(s.guideId, [...(frozenMoved.get(s.guideId) ?? []), { sheetId: s.id, ref: s.ref, row: r.bookingNo, to, why }]);
    }
    frozenLate = new Map();
    for (const a of assigns) {
      if (plan.frozen.has(a.guideId) || frozenMoved.has(a.guideId)) continue;
      const sheet = sheetOf(a.guideId);
      for (const b of bookings) {
        if (plan.owner.get(b.id) !== a.guideId) continue;
        if (sheet && rowsOf(sheet).some((r) => refKeys(b).includes(rowKey(r)))) continue;
        const elsewhere = await elsewhereOf(b);
        if (elsewhere) { frozenLate.set(a.guideId, `${refOf(b)} is still on ${elsewhere}`); break; }
      }
    }
    const withdraw: string[] = [];
    for (const g of new Set(plan.release.map((r) => r.guideId))) if (frozenNow(g) || !(await checkEditable(g))) withdraw.push(g);
    if (!withdraw.length) break;
    if (pass >= 4) throw new Conflict("the ownership plan did not settle");
    for (const g of withdraw) noRelease.add(g);
  }
  // A released booking joins its new job only if that job is certainly written as well;
  // otherwise it goes back to the inbox (PENDING) for an operator, never OFFERED to nobody.
  const unplace = new Set<string>();
  for (const r of plan.release) {
    const o = plan.owner.get(r.bookingId);
    const oSheet = o ? sheetOf(o) : undefined;
    const takes = !!o && !frozenNow(o) && !(oSheet && isApproved(oSheet.approvalStatus)) && !(await blockersOf(o)).length;
    if (!takes) {
      if (o) {
        plan.owner.delete(r.bookingId);
        plan.review.set(r.bookingId, { why: `its tour changed to one ${o} runs, but ${o}'s job cannot take it now`, guides: [o], code: "BOOKING_JOB_MATCH_REVIEW_REQUIRED" });
      }
      unplace.add(r.bookingId);
    }
  }
  result.plan = plan;
  for (const [, rv] of plan.review) for (const g of rv.guides) if (!result.frozenBy.has(g)) result.frozenBy.set(g, rv.code);
  for (const g of plan.frozen.keys()) if (!result.frozenBy.has(g)) result.frozenBy.set(g, "BOOKING_JOB_MATCH_REVIEW_REQUIRED");
  for (const [g, list] of frozenMoved) {
    result.frozenBy.set(g, "BOOKING_MOVED_REVIEW_REQUIRED");
    for (const m of list) issues.push(issue("BOOKING_MOVED_REVIEW_REQUIRED", { type: "JobSheet", id: m.sheetId }, `${m.row}|${depKey(m.to)}`, { jobRef: m.ref, bookingRef: m.row, from: depKey(dep), to: depKey(m.to), why: m.why, source: opts.source },
      `${m.ref ?? when(dep)}: booking ${m.row} moved to ${when(m.to)}, but it is still on this job sheet and was not removed — ${m.why}. Check both jobs.`, dep.date, true));
  }
  for (const [id, rv] of plan.review) {
    const b = bookings.find((x) => x.id === id)!;
    const ref = bookingRef(b.externalRef, b.confirmationCode);
    issues.push(issue(rv.code, { type: "Booking", id }, rv.why, { bookingRef: ref || null, date: dep.date, slotIdx: dep.slotIdx, guides: rv.guides, why: rv.why, source: opts.source },
      `Booking ${ref || "(no ref)"} for ${when(dep)} could not be placed automatically: ${rv.why}. ${rv.guides.length ? `${rv.guides.join(", ")}'s job was left unchanged. ` : ""}Place it in Bookings.`, dep.date, true));
  }

  const auditBase = { date: dep.date, slotIdx: dep.slotIdx, source: opts.source, reason: opts.reason ?? null };
  const audits: { action: string; entityType: string; entityId: string; detail: Record<string, unknown> }[] = [];
  // A job that does not change still hears that a guest on it cancelled — with no count,
  // because no count was committed.
  const cancelNotices = async (a: { id: string; guideId: string }) => {
    const sheet = sheetOf(a.guideId);
    if (!sheet) return;
    for (const b of bookings) {
      if (b.status !== "CANCELLED" || plan.cancelHolder.get(b.id) !== a.guideId) continue;
      if (!rowsOf(sheet).some((r) => refKeys(b).includes(rowKey(r)))) continue;
      const seen = await tx.auditLog.findFirst({ where: { action: "booking.guide_cancel_notified", entityId: b.id, detail: { path: ["guideId"], equals: a.guideId } }, select: { id: true } });
      if (seen || audits.some((x) => x.action === "booking.guide_cancel_notified" && x.entityId === b.id)) continue;
      audits.push({ action: "booking.guide_cancel_notified", entityType: "Booking", entityId: b.id, detail: { guideId: a.guideId, assignmentId: a.id, ...auditBase } });
      notices.push({ guideId: a.guideId, entityId: a.id, key: `cancel|${b.id}`, date: dep.date, ops: null,
        guide: [`A booking on your ${when(dep)} tour (${refOf(b)}) was cancelled. The office is checking your guest list — your job sheet has not changed yet.`, "A guest cancelled", `${when(dep)} · being checked`] });
    }
  };

  // ── 3. Each job: the rows, counts and expense quantities it should have ──
  const drafts: Draft[] = [];
  for (const a of assigns) {
    const g = a.guideId;
    if (frozenNow(g)) {
      const why = [...(plan.frozen.get(g) ?? []), ...(frozenMoved.get(g) ?? []).map((m) => m.why), ...(frozenLate.has(g) ? [frozenLate.get(g)!] : [])];
      result.jobs.set(g, { status: "frozen", changed: [], why });
      if (frozenLate.has(g)) {
        result.frozenBy.set(g, "BOOKING_MOVED_REVIEW_REQUIRED");
        issues.push(issue("BOOKING_MOVED_REVIEW_REQUIRED", { type: "Assignment", id: a.id }, frozenLate.get(g)!, { guideId: g, jobRef: sheetOf(g)?.ref ?? null, ...auditBase, why: frozenLate.get(g) },
          `${sheetOf(g)?.ref ?? `${g} ${when(dep)}`}: ${frozenLate.get(g)}. This job was not changed — take it off the other job first.`, dep.date, true));
      }
      await cancelNotices(a);
      continue;
    }
    const owned = bookings.filter((b) => plan.owner.get(b.id) === g);
    const toPlace = owned.filter((b) => b.status === "PENDING");
    const sheet = sheetOf(g);
    const changed: string[] = [];
    if (toPlace.length) changed.push("booking placed");

    let newRows: SheetRow[] | null = null, newExpenses: (Expense & ProtectedRow)[] | null = null;
    const added: SheetRow[] = [], removed: Removed[] = [], resized: Draft["resized"] = [], preserved: string[] = [];
    const warnings: string[] = [], recalculated: Draft["recalculated"] = [];
    let sheetOld = 0, sheetNew = 0;
    if (sheet) {
      const saved = rowsOf(sheet);
      sheetOld = guestsOf(saved);
      const kept: SheetRow[] = [];
      const matched = new Set<string>();
      for (const r of saved) {
        const k = rowKey(r);
        if (!k) { kept.push(r); continue; }
        const own = owned.find((b) => refKeys(b).includes(k));
        if (own) {
          matched.add(own.id);
          if ((r.bookedPax ?? null) !== (own.pax ?? null)) { resized.push({ key: r.bookingNo, from: r.bookedPax ?? null, to: own.pax ?? null }); kept.push({ ...r, bookedPax: own.pax ?? null }); }
          else kept.push(r);
          continue;
        }
        const liveHere = bookings.some((b) => LIVE.includes(b.status) && refKeys(b).includes(k));
        const cancelled = bookings.find((b) => b.status === "CANCELLED" && plan.cancelHolder.get(b.id) === g && refKeys(b).includes(k));
        if (cancelled && !liveHere) {
          if (rowHasEvidence(r)) { preserved.push(r.bookingNo); kept.push(r); }
          else removed.push({ key: r.bookingNo, why: "cancelled", kind: "cancelled", bookingId: cancelled.id });
          continue;
        }
        const rel = plan.release.find((x) => x.guideId === g && refKeys(bookings.find((b) => b.id === x.bookingId)!).includes(k));
        if (rel) { removed.push({ key: r.bookingNo, why: rel.why, kind: "released", bookingId: rel.bookingId }); continue; }
        const to = moved.get(k);
        if (to) { removed.push({ key: r.bookingNo, why: `moved to ${when(to)}`, kind: "moved", to }); continue; } // releasable, or this job would be frozen
        kept.push(r); // a manual row, or a booking number FolkOPS does not hold: the operator's
      }
      for (const b of owned) {
        if (matched.has(b.id)) continue;
        const row = toSheetBooking(b);
        added.push(row); kept.push(row);
      }
      const guestsChanged = added.length + removed.length + resized.length > 0;
      if (guestsChanged) newRows = kept;
      sheetNew = guestsOf(kept);
      if (guestsChanged && sheetOld !== sheetNew) {
        // Expense counts move only while they are still the system's own fill-down for the
        // old guest count, the guide has not filed their report, and no person confirmed
        // the row. Anything else is somebody's number — kept, and flagged.
        const exps = ((sheet.expenses as unknown as (Expense & ProtectedRow)[]) ?? []).map((e) => {
          if (isReviewExpense(e) || e.pax == null) return e;
          const from = derivedQty(e, sheetOld), to = derivedQty(e, sheetNew);
          if (e.pax !== from) { if (e.pax > 0 && e.pax !== to) warnings.push(`"${e.description}" is ${e.pax}, not the fill-down ${from}`); return e; }
          if (sheet.guideExpensesAt) { warnings.push(`"${e.description}": the guide already reported expenses`); return e; }
          if (isProtected(e)) { warnings.push(`"${e.description}" is signed for`); return e; }
          if (payerConfirmed(e)) { warnings.push(`"${e.description}": its payer was confirmed by a person`); return e; }
          recalculated.push({ description: e.description ?? "", from, to });
          return { ...e, pax: to };
        });
        if (recalculated.length) newExpenses = exps;
      }
      if (newRows) changed.push("job sheet");
    }
    // The expected pax: the job sheet's own guest total when there is a sheet (the rule the
    // job-sheet save uses too, so the two never disagree), the job's bookings when there is
    // not. Recounted only when the job's guests come from bookings — a job an operator
    // dispatched with none in FolkOPS (a private or manual tour) keeps its number.
    const expected = sheet ? sheetNew : owned.reduce((n, b) => n + (b.pax ?? 0), 0);
    const recount = (owned.length > 0 || removed.length > 0) && expected !== (a.pax ?? 0);
    if (recount) changed.push("assignment pax");
    if (preserved.length) issues.push(issue("BOOKING_RECONCILIATION_REVIEW_REQUIRED", { type: "JobSheet", id: sheet!.id }, `cancelled-kept|${preserved.join(",")}`, { guideId: g, jobRef: sheet!.ref, ...auditBase, why: "cancelled booking kept: something is recorded on its row", rows: preserved },
      `${sheet!.ref ?? when(dep)}: ${preserved.join(", ")} ${preserved.length > 1 ? "were" : "was"} cancelled, but attendance or ticket details are recorded on the row, so it stays. Check it.`, dep.date));
    if (!changed.length) { result.jobs.set(g, { status: "unchanged", changed, why: [] }); continue; }

    // The whole job moves, or none of it: blockers and approval stop everything.
    const blockers = await blockersOf(g);
    if (blockers.length) {
      result.jobs.set(g, { status: "blocked", changed: [], why: blockers });
      issues.push(issue("BOOKING_RECONCILIATION_BLOCKED", { type: sheet ? "JobSheet" : "Assignment", id: sheet?.id ?? a.id }, `${a.pax ?? 0}->${expected}|${sheetOld}->${sheetNew}|${blockers.join(";")}`,
        { guideId: g, jobRef: sheet?.ref ?? null, ...auditBase, why: blockers.join("; "), expectedFrom: a.pax ?? null, expectedTo: expected },
        `${sheet?.ref ?? `${g} ${when(dep)}`}: booking data changed (${sheet ? `${sheetOld} → ${sheetNew}` : `${a.pax ?? 0} → ${expected}`} guests) but the job was not updated because ${blockers.join("; ")}. Nothing was placed or recounted. Review it.`, dep.date, true));
      await cancelNotices(a);
      continue;
    }
    if (sheet && isApproved(sheet.approvalStatus)) {
      const why = "the job sheet is approved — unapprove it first, so the new guest list is signed off again";
      result.jobs.set(g, { status: "review", changed: [], why: [why] });
      result.frozenBy.set(g, "BOOKING_RECONCILIATION_REVIEW_REQUIRED");
      issues.push(issue("BOOKING_RECONCILIATION_REVIEW_REQUIRED", { type: "JobSheet", id: sheet.id }, `${sheetOld}->${sheetNew}|${a.pax ?? 0}->${expected}`, { guideId: g, jobRef: sheet.ref, ...auditBase, why },
        `${sheet.ref ?? when(dep)}: booking data changed (${sheetOld} → ${sheetNew} guests) but ${why}. Nothing on the job was changed.`, dep.date, true));
      await cancelNotices(a);
      continue;
    }
    drafts.push({ a, sheet, owned, toPlace, expected, recount, newRows, newExpenses, added, removed, resized, recalculated, warnings, sheetOld, sheetNew, changed });
  }

  // ── 4. Final validation, immediately before writing ──
  if (opts.beforeWrite) await opts.beforeWrite(attempt);
  // The guides and sheets this plan was made for must still be the guides and sheets. A row
  // lock does not stop a NEW assignment (a second guide added) or a new sheet appearing.
  const assignsNow = await tx.assignment.findMany({ where: dep, select: { id: true, guideId: true, tourId: true, pax: true } });
  if (assignSig(assignsNow) !== assignSig(assigns)) throw new Conflict("the departure's guides changed while it was being reconciled");
  const sheetsNow = await tx.jobSheet.findMany({ where: dep, select: { id: true, updatedAt: true } });
  if (sheetSig(sheetsNow) !== sheetSig(sheets)) throw new Conflict("a job sheet appeared or changed while the departure was being reconciled");
  // Blockers are asked again, fresh: a payment or advance has no link to the sheet row, so
  // the sheet lock alone does not stop one being recorded meanwhile.
  for (const d of drafts) {
    const fresh = await jobBlockers(tx, d.sheet ? sheetOf(d.a.guideId)! : null, { guideId: d.a.guideId, ...dep });
    if (fresh.length) throw new Conflict("the job gained accounting history while it was being reconciled");
  }
  // No booking may end up on more job sheets than before, or on more than one.
  const draftOf = (g: string) => drafts.find((d) => d.a.guideId === g);
  const finalRows = sheets.map((s) => ({ guideId: s.guideId, rows: draftOf(s.guideId)?.newRows ?? rowsOf(s) }));
  const violations: string[] = [];
  for (const b of bookings.filter((x) => LIVE.includes(x.status))) {
    const k = refKeys(b);
    const before = sheets.filter((s) => rowsOf(s).some((r) => k.includes(rowKey(r)))).length;
    const after = finalRows.filter((s) => s.rows.some((r) => k.includes(rowKey(r)))).length;
    if (after > Math.max(1, before)) violations.push(`${refOf(b)} would be on ${after} job sheets`);
    for (const d of drafts) if (d.newRows) {
      const n = d.newRows.filter((r) => k.includes(rowKey(r))).length;
      const was = sheetOf(d.a.guideId) ? rowsOf(sheetOf(d.a.guideId)!).filter((r) => k.includes(rowKey(r))).length : 0;
      if (n > Math.max(1, was)) violations.push(`${refOf(b)} would be listed ${n} times on ${d.a.guideId}'s job sheet`);
    }
  }
  if (violations.length) {
    for (const d of drafts) result.jobs.set(d.a.guideId, { status: "review", changed: [], why: violations });
    issues.push(issue("BOOKING_RECONCILIATION_REVIEW_REQUIRED", { type: "Departure", id: depKey(dep) }, violations.join(";"), { ...auditBase, why: violations.join("; ") },
      `${when(dep)}: the automatic update was stopped because ${violations.join("; ")}. Nothing on this departure was changed — check its job sheets.`, dep.date, true));
    return { result, issues, notices: [] };
  }

  // ── 5. The writes, all in this transaction ──
  for (const d of drafts) {
    const { a, sheet } = d;
    const g = a.guideId;
    const jobBase = { ...auditBase, guideId: g };
    if (d.toPlace.length) {
      const ids = d.toPlace.map((b) => b.id);
      const hit = await tx.booking.updateMany({ where: { id: { in: ids }, status: "PENDING" }, data: { status: "OFFERED" } });
      if (hit.count !== ids.length) throw new Conflict("a booking changed while it was being placed");
      for (const b of d.toPlace) { result.placed.add(b.id); audits.push({ action: "booking.reconciled", entityType: "Booking", entityId: b.id, detail: { ...jobBase, bookingRef: bookingRef(b.externalRef, b.confirmationCode) || null, placed: true, expectedPax: d.expected } }); }
    }
    // A booking this job gives up with no job to go to goes back to the inbox.
    for (const r of d.removed) {
      if (r.kind === "released" && r.bookingId && unplace.has(r.bookingId)) {
        await tx.booking.updateMany({ where: { id: r.bookingId, status: { in: ["OFFERED", "ASSIGNED"] } }, data: { status: "PENDING" } });
        audits.push({ action: "booking.unplaced", entityType: "Booking", entityId: r.bookingId, detail: { ...jobBase, row: r.key, why: r.why } });
      }
      if (r.kind === "moved" && r.to) {
        // Unplaced here; the new departure's own reconciliation places it again if exactly one job can take it.
        const moving = await tx.booking.findMany({ where: { date: r.to.date, slotIdx: r.to.slotIdx, status: { in: ["OFFERED", "ASSIGNED"] }, OR: [{ externalRef: { equals: r.key, mode: "insensitive" } }, { confirmationCode: { equals: r.key, mode: "insensitive" } }] }, select: { id: true, externalRef: true, confirmationCode: true } });
        for (const m of moving) {
          const onSheetThere = await tx.jobSheet.findFirst({ where: { date: r.to.date, slotIdx: r.to.slotIdx, OR: rawRefs(m).map((x) => ({ bookings: { array_contains: [{ bookingNo: x }] } })) }, select: { id: true } });
          if (onSheetThere) continue;
          await tx.booking.updateMany({ where: { id: m.id, status: { in: ["OFFERED", "ASSIGNED"] } }, data: { status: "PENDING" } });
          audits.push({ action: "booking.unplaced", entityType: "Booking", entityId: m.id, detail: { ...jobBase, row: r.key, why: r.why } });
        }
      }
    }
    if (d.recount) {
      const hit = await tx.assignment.updateMany({ where: { id: a.id, pax: a.pax }, data: { pax: d.expected } });
      if (hit.count !== 1) throw new Conflict("the assignment changed while it was being reconciled");
      audits.push({ action: "assignment.booking_sync", entityType: "Assignment", entityId: a.id, detail: { ...jobBase, oldExpectedPax: a.pax ?? null, newExpectedPax: d.expected } });
    }
    if (sheet && d.newRows) {
      // No updatedAt condition here: this row has been locked since before it was read, so
      // nothing else can have written it in between. The lock is the guard.
      await tx.jobSheet.update({
        where: { id: sheet.id },
        data: { bookings: d.newRows as unknown as Prisma.InputJsonValue, ...(d.newExpenses ? { expenses: d.newExpenses as unknown as Prisma.InputJsonValue } : {}) },
      });
      const sheetBase = { ...jobBase, jobSheetId: sheet.id, jobRef: sheet.ref };
      for (const r of d.added) audits.push({ action: "jobsheet.booking_added", entityType: "JobSheet", entityId: sheet.id, detail: { ...sheetBase, row: r.bookingNo } });
      for (const r of d.removed) audits.push({ action: "jobsheet.booking_removed", entityType: "JobSheet", entityId: sheet.id, detail: { ...sheetBase, row: r.key, why: r.why } });
      if (d.resized.length) audits.push({ action: "jobsheet.booking_resized", entityType: "JobSheet", entityId: sheet.id, detail: { ...sheetBase, rows: d.resized } });
      if (d.sheetOld !== d.sheetNew) audits.push({ action: "jobsheet.expected_pax_changed", entityType: "JobSheet", entityId: sheet.id, detail: { ...sheetBase, oldExpectedPax: d.sheetOld, newExpectedPax: d.sheetNew } });
      if (d.recalculated.length) audits.push({ action: "jobsheet.expense_pax_recalculated", entityType: "JobSheet", entityId: sheet.id, detail: { ...sheetBase, rows: d.recalculated } });
      if (d.warnings.length) issues.push(issue("EXPENSE_COUNT_REVIEW", { type: "JobSheet", id: sheet.id }, `${d.sheetOld}->${d.sheetNew}`, { ...sheetBase, why: d.warnings.join("; ") },
        `${sheet.ref ?? "A job sheet"}: guests ${d.sheetOld} → ${d.sheetNew}. These expense counts were left as they are — check them: ${d.warnings.join("; ")}.`, dep.date));
    }
    result.jobs.set(g, { status: "reconciled", changed: d.changed, why: [] });

    // Tell people about the job's COMMITTED final guest count — once per new count. The last
    // count this job was told is recorded here, in the same transaction as the change, so a
    // rolled-back attempt tells nobody anything, and a count that goes 6 → 8 → 6 → 8 is
    // announced each time it changes (not suppressed because 6 → 8 was once said before).
    const from = sheet ? d.sheetOld : (a.pax ?? 0);
    const to = sheet ? d.sheetNew : (d.recount ? d.expected : (a.pax ?? 0));
    const last = await tx.auditLog.findFirst({ where: { action: "booking.guide_state_notified", entityId: a.id }, orderBy: { createdAt: "desc" }, select: { detail: true } });
    const told = (last?.detail as { to?: number } | null)?.to;
    const baseline = told ?? from;
    if (to !== baseline) {
      const late = d.toPlace.length > 0 || d.added.length > 0;
      const cancelledOut = d.removed.some((r) => r.kind === "cancelled");
      const head = late ? "LATE BOOKING" : cancelledOut && to < baseline ? "BOOKING CANCELLED" : "BOOKING CHANGED";
      const news = d.owned.filter((b) => d.toPlace.includes(b) || [...d.added.map((r) => r.bookingNo), ...d.resized.map((r) => r.key)].some((k) => refKeys(b).includes(norm(k))));
      const refs = [...new Set([...news.map((b) => bookingRef(b.externalRef, b.confirmationCode)), ...d.removed.map((r) => r.key)].filter(Boolean))].sort();
      const sources = [...new Set(news.map((b) => b.source).filter(Boolean))].join(" + ") || "Booking";
      const plus = news.filter((b) => d.toPlace.includes(b) || d.added.some((r) => refKeys(b).includes(rowKey(r)))).reduce((n, b) => n + (b.pax ?? 0), 0);
      const msg = [`${head} — ${sheet?.ref ?? when(dep)}`, `${sources} ${refs.join(", ")}${late && plus ? ` · +${plus} guests` : ""}`, `Expected guests: ${baseline} → ${to}`, `Guide: ${g}`, `Tour starts: ${when(dep)}`].join("\n");
      const lead = late ? "A late booking was added" : cancelledOut && to < baseline ? "A guest cancelled" : "A booking changed";
      audits.push({ action: "booking.guide_state_notified", entityType: "Assignment", entityId: a.id, detail: { guideId: g, from: baseline, to, ...auditBase } });
      notices.push({
        guideId: g, entityId: a.id, key: `${a.id}|${baseline}->${to}`, date: dep.date,
        ops: [msg, late ? "Late booking added to a job" : cancelledOut ? "Booking cancelled on a job" : "Booking changed on a job", `${refs.join(", ")} · ${baseline} → ${to} guests`],
        guide: [`${lead} on your ${when(dep)} tour. Expected guests: ${baseline} → ${to}.`, lead, `${when(dep)} · ${to} guests`],
      });
    }
  }
  if (audits.length) await tx.auditLog.createMany({ data: audits.map((x) => ({ ...x, detail: x.detail as Prisma.InputJsonValue })) });
  return { result, issues, notices };
}

/** Is this booking still on an upcoming job sheet at ANOTHER departure (and not as some other booking there)? */
async function listedElsewhere(tx: Tx, b: LoadedBooking, dep: Departure, now: number): Promise<string | null> {
  const refs = rawRefs(b);
  if (!refs.length) return null;
  const today = new Date(now + 7 * 3600_000).toISOString().slice(0, 10);
  const hits = await tx.jobSheet.findMany({
    where: { date: { gte: today }, NOT: { AND: [{ date: dep.date }, { slotIdx: dep.slotIdx }] }, OR: refs.map((r) => ({ bookings: { array_contains: [{ bookingNo: r }] } })) },
    select: { ref: true, guideId: true, date: true, slotIdx: true },
  });
  for (const h of hits) {
    if (tourStartMs(h.date, h.slotIdx) <= now) continue; // a tour that ran is history, not a claim
    // The same number at that departure may be another booking (an OTA amendment keeps its ref).
    const other = await tx.booking.findFirst({ where: { id: { not: b.id }, date: h.date, slotIdx: h.slotIdx, status: { not: "IGNORED" }, OR: [{ externalRef: { in: refs, mode: "insensitive" } }, { confirmationCode: { in: refs, mode: "insensitive" } }] }, select: { id: true } });
    if (!other) return `${h.ref ?? `${h.guideId}'s`} job sheet (${when(h)})`;
  }
  return null;
}

/** Why this job must not be changed automatically: certificates, PEAK, payments, advances. */
async function jobBlockers(db: Tx, sheet: { id: string; peakDocumentNo: string | null } | null, key: { guideId: string; date: string; slotIdx: number }): Promise<string[]> {
  const out: string[] = [];
  if (sheet) {
    const certs = await db.expenseCertificate.findMany({ where: { jobSheetId: sheet.id, NOT: { status: "VOID" } }, select: { certificateNo: true, status: true } });
    for (const c of certs) out.push(c.status === "READY_TO_ATTEST"
      ? `Booking data changed after certificate ${c.certificateNo} was created — it must be regenerated`
      : `certificate ${c.certificateNo} is ${c.status}`);
    if (sheet.peakDocumentNo) out.push(`the job is in PEAK (${sheet.peakDocumentNo})`);
  }
  // A failure to check is a reason to stop, not a green light.
  const history = await financialHistoryBlockers(db as unknown as Db, [key]).catch(() => ["the payment history could not be checked"]);
  out.push(...history);
  return [...new Set(out)];
}

// ── After the start: record, never rewrite ────────────────────────────────────

async function postStart(db: Db, dep: Departure, opts: ReconcileOptions): Promise<DepartureResult> {
  const result: DepartureResult = { kind: "post-start", flagged: 0, jobs: new Map(), placed: new Set(), frozenBy: new Map() };
  if (dep.date < FLAG_POST_START_SINCE) return result;
  const [assigns, bookings, sheets] = await Promise.all([
    db.assignment.findMany({ where: dep, select: { guideId: true, tourId: true } }),
    db.booking.findMany({ where: { ...dep, status: { in: [...LIVE, "CANCELLED"] } }, select: { id: true, status: true, tourId: true, assignedGuideId: true, externalRef: true, confirmationCode: true, pax: true } }),
    db.jobSheet.findMany({ where: dep, select: { id: true, ref: true, guideId: true, bookings: true } }),
  ]);
  if (!assigns.length || !sheets.length) return result;
  const rowsOf = (s: { bookings: unknown }) => ((s.bookings as unknown as SheetBooking[]) ?? []);
  const plan = planDeparture(assigns, bookings, sheets.map((s) => ({ guideId: s.guideId, rows: rowsOf(s) })));
  result.plan = plan;
  const issues: Issue[] = [];
  for (const s of sheets) {
    const rows = rowsOf(s);
    const disagreements: { b: PlanBooking; why: string }[] = [];
    for (const b of bookings) {
      const row = rows.find((r) => refKeys(b).includes(rowKey(r)));
      const live = LIVE.includes(b.status);
      const twinLive = row && bookings.some((x) => x.id !== b.id && LIVE.includes(x.status) && refKeys(x).includes(rowKey(row)));
      if (live && plan.owner.get(b.id) === s.guideId && !row) disagreements.push({ b, why: `a booking (${b.pax ?? "?"} pax) is not on the job sheet` });
      else if (!live && row && plan.cancelHolder.get(b.id) === s.guideId && !twinLive) disagreements.push({ b, why: "a booking on the job sheet is now cancelled" });
      else if (live && row && plan.owner.get(b.id) === s.guideId && (row.bookedPax ?? null) !== (b.pax ?? null)) disagreements.push({ b, why: `a booking is ${row.bookedPax ?? "?"} pax on the sheet and ${b.pax ?? "?"} pax now` });
    }
    if (!disagreements.length) continue;
    const completed = !!(await db.checkin.findFirst({ where: { guideId: s.guideId, ...dep, type: "COMPLETE" }, select: { id: true } }));
    for (const { b, why } of disagreements) {
      const ref = bookingRef(b.externalRef, b.confirmationCode);
      const code = completed ? "POST_TOUR_BOOKING_CHANGE" : "BOOKING_CHANGED_AFTER_START";
      issues.push(issue(code, { type: "Booking", id: b.id }, `${b.status}|${b.pax}|${why}`,
        { bookingRef: ref || null, date: dep.date, slotIdx: dep.slotIdx, guides: [s.guideId], jobRef: s.ref ?? null, why, source: opts.source },
        `${completed ? "POST-TOUR BOOKING CHANGE — REVIEW REQUIRED" : "Booking changed after tour start — manual attendance review required"}: ${s.ref ?? `${dep.date} ${s.guideId}`}, ${ref || "a booking"} — ${why}. Nothing on the job was changed.`));
      result.flagged = (result.flagged ?? 0) + 1;
    }
  }
  await afterCommit(db, issues, [], opts);
  return result;
}

// ── Issues and notices: only after the data is committed ─────────────────────

function issue(code: string, entity: { type: string; id: string }, sig: string, detail: Record<string, unknown>, message: string, date?: string, push = false): Issue {
  return { code, entity, sig, detail, message, date, push };
}

const defaultNotifier = async (): Promise<Notifier> => {
  const { notifyOps, notifyGuide } = await import("@/lib/booking-import");
  return { ops: notifyOps, guide: (g, m, t, b) => notifyGuide(g, m, t, b) };
};

async function afterCommit(db: Db, issues: Issue[], notices: Notice[], opts: ReconcileOptions) {
  if (!issues.length && !notices.length) return;
  const notifier = opts.notifier ?? (await defaultNotifier());
  for (const x of issues) {
    try { await raiseIssue(db, notifier, x); } catch (e) { await noteFailure(db, "issue", x.entity.id, x.code, e); }
  }
  // Whether to tell anyone was decided inside the transaction, against the last count this
  // job was told, and recorded there with the change: nothing here can repeat or reorder it.
  for (const n of notices) {
    if (n.ops) { try { await notifier.ops(n.ops[0], n.ops[1], n.ops[2], { date: n.date, dedupe: false }); } catch (e) { await noteFailure(db, "ops", n.entityId, n.key, e); } }
    try { await notifier.guide(n.guideId, n.guide[0], n.guide[1], n.guide[2]); } catch (e) { await noteFailure(db, "guide", n.entityId, n.key, e); }
  }
}

async function noteFailure(db: Db, channel: string, entityId: string, key: string, e: unknown) {
  try {
    await db.auditLog.create({ data: { action: "booking.notification_failed", entityType: "Reconciliation", entityId, detail: { channel, key, error: String((e as Error)?.message ?? e).slice(0, 200) } } });
  } catch { /* the data is already correct; a lost log line must not undo it */ }
}

/** An issue an operator must look at: audited, and shown in the ops inbox once per change. */
async function raiseIssue(db: Db, notifier: Notifier, x: Issue) {
  const sig = `${x.code}|${x.sig}`;
  const seen = await db.auditLog.findFirst({ where: { action: "booking.reconciliation_required", entityType: x.entity.type, entityId: x.entity.id, detail: { path: ["sig"], equals: sig } }, select: { id: true } });
  if (seen) return;
  const detail = { code: x.code, sig, ...x.detail } as Prisma.InputJsonValue;
  if (x.code.startsWith("POST_TOUR")) await db.auditLog.create({ data: { action: "booking.post_tour_change", entityType: x.entity.type, entityId: x.entity.id, detail } });
  await db.auditLog.create({ data: { action: "booking.reconciliation_required", entityType: x.entity.type, entityId: x.entity.id, detail } });
  // Post-start issues concern a tour that already ran, which notifyOps would drop for a
  // past date — so those are raised without the date filter.
  const postStartIssue = x.code.includes("POST") || x.code.includes("AFTER_START");
  await notifier.ops(x.message, "Booking needs review", `${String(x.detail.bookingRef ?? x.detail.jobRef ?? "Booking")} · ${x.code}`, { push: x.push ?? false, ...(postStartIssue || !x.date ? {} : { date: x.date }) });
}

/** What one departure run means for one booking. */
function outcomeFor(bookingId: string, r: DepartureResult): ReconcileOutcome {
  if (r.kind === "skipped") return { kind: "skipped", why: r.why ?? "" };
  if (r.kind === "no-job") return { kind: "no-job" };
  if (r.kind === "conflict") return { kind: "conflict" };
  if (r.kind === "post-start") return { kind: "post-start", flagged: (r.flagged ?? 0) > 0 };
  const rv = r.plan?.review.get(bookingId);
  if (rv) return { kind: "review-required", code: rv.code, why: rv.why };
  const g = r.plan?.owner.get(bookingId) ?? r.plan?.cancelHolder.get(bookingId);
  const job = g ? r.jobs.get(g) : undefined;
  if (!g || !job) return { kind: "skipped", why: "not on any guide's job" };
  if (job.status === "blocked") return { kind: "blocked", why: job.why };
  if (job.status === "review" || job.status === "frozen") return { kind: "review-required", code: r.frozenBy.get(g) ?? "BOOKING_JOB_MATCH_REVIEW_REQUIRED", why: job.why.join("; ") };
  return { kind: "reconciled", guideId: g, changed: r.placed.has(bookingId) ? job.changed : job.changed.filter((c) => c !== "booking placed") };
}
