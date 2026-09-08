// The Historical Job Sheet backlog: pure domain rules.
//
// No Prisma, no HTTP — so the state machine, the instance key and the snapshot
// allowlist can be tested directly. Routes stay thin: parse, call in here, write.
//
// The whole feature exists because ~250 tour instances from early 2026 have no
// job sheet and no assignment. Nothing here infers what happened on those tours;
// it only records what an operator says happened.

export const HISTORICAL_REVIEW_STATUSES = [
  "NEEDS_REVIEW", "CONFIRMED_OPERATED", "CONFIRMED_CANCELLED", "CUSTOMER_NO_SHOW",
  "GUIDE_UNKNOWN", "NEEDS_EVIDENCE", "READY_TO_RECONSTRUCT", "RECONSTRUCTED_DRAFT",
  "EXCLUDED", "COMPLETED",
] as const;
export type HistoricalReviewStatus = (typeof HISTORICAL_REVIEW_STATUSES)[number];

export const HISTORICAL_ACTIONS = [
  "confirmOperated", "confirmCancelled", "confirmNoShow", "needEvidence",
  "guideUnknown", "setGuide", "markReady", "reconstruct", "complete",
  "exclude", "reopen", "reverse", "addNote",
] as const;
export type HistoricalAction = (typeof HISTORICAL_ACTIONS)[number];

/**
 * The pilot window. Booking, Assignment and JobSheet all store `date` as a LOCAL
 * Bangkok date string ("YYYY-MM-DD"), never a timestamp — so the window is an
 * exact string comparison and there is no UTC boundary to cross. Asia/Bangkok is
 * UTC+7 with no DST, so a local calendar day is unambiguous.
 */
export const MAY_2026 = { from: "2026-05-01", to: "2026-05-31" } as const;

export function isInWindow(date: string, w: { from: string; to: string } = MAY_2026): boolean {
  return date >= w.from && date <= w.to;
}

/**
 * The identity of one historical tour instance.
 *
 * Date + slot only. `tourId` is deliberately excluded because it is MUTABLE —
 * product mapping assigns it after import, which is why some imported rows still
 * have none. A key containing it would produce a SECOND row the first time a
 * product was mapped, and the generator would stop being idempotent.
 *
 * Date and slot are immutable operational facts, and a slot is one departure per
 * date in this system (BlockedSlot is unique on exactly that pair). Verified
 * across Feb-May 2026: 267 instances, 267 distinct pairs, no collisions.
 */
export function instanceKeyFor(date: string, slotIdx: number): string {
  return `${date}#${String(slotIdx).padStart(2, "0")}`;
}

export function parseInstanceKey(key: string): { date: string; slotIdx: number } | null {
  const m = /^(\d{4}-\d{2}-\d{2})#(\d{2})$/.exec(key ?? "");
  return m ? { date: m[1], slotIdx: Number(m[2]) } : null;
}

// ---------------------------------------------------------------------------
// auditSnapshot allowlist
// ---------------------------------------------------------------------------

/**
 * Exactly what may be stored from the Stage 1 audit. Operational classification
 * only: enough to reproduce the decision, nothing about a customer.
 *
 * Never: customer names, phone numbers, emails, bank details, tax numbers, raw
 * imported payloads, credentials or tokens. Built field-by-field below rather
 * than by spreading an audit row, so a new field upstream cannot leak by default.
 */
export const HISTORICAL_AUDIT_KEYS = [
  "classification", "readiness", "matchMethod", "warnings",
  "bookingCount", "livePax", "cancelledCount", "archivedCount",
  "channels", "bookingStatuses", "generatedAt", "auditVersion",
] as const;

export type AuditSnapshot = Partial<{
  classification: string; readiness: string; matchMethod: string; warnings: string[];
  bookingCount: number; livePax: number; cancelledCount: number; archivedCount: number;
  channels: string[]; bookingStatuses: string[]; generatedAt: string; auditVersion: string;
}>;

const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 200) : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 20).map((x) => x.slice(0, 120)) : undefined);

/** Copy only allowlisted keys, dropping anything else without comment. */
export function sanitizeAuditSnapshot(raw: unknown): AuditSnapshot {
  const r = (raw ?? {}) as Record<string, unknown>;
  const out: AuditSnapshot = {};
  const set = <K extends keyof AuditSnapshot>(k: K, v: AuditSnapshot[K]) => { if (v !== undefined) out[k] = v; };
  set("classification", str(r.classification));
  set("readiness", str(r.readiness));
  set("matchMethod", str(r.matchMethod));
  set("warnings", strs(r.warnings));
  set("bookingCount", num(r.bookingCount));
  set("livePax", num(r.livePax));
  set("cancelledCount", num(r.cancelledCount));
  set("archivedCount", num(r.archivedCount));
  set("channels", strs(r.channels));
  set("bookingStatuses", strs(r.bookingStatuses));
  set("generatedAt", str(r.generatedAt));
  set("auditVersion", str(r.auditVersion));
  return out;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export type ReviewState = {
  reviewStatus: HistoricalReviewStatus;
  confirmedGuideId?: string | null;
  jobSheetId?: string | null;
};

export type ActionContext = {
  role?: string | null;
  /** Free text supplied with the action (exclusion reason / review note). */
  reason?: string | null;
  /** The guide the operator picked, for setGuide. */
  guideId?: string | null;
  /** Whether a job sheet already exists at this (guide, date, slot). */
  sheetExistsAtKey?: boolean;
  /** Whether an unresolved duplicate blocks reconstruction. */
  hasUnresolvedDuplicate?: boolean;
};

export type TransitionResult =
  | { ok: true; status: HistoricalReviewStatus; auditAction: string; adminOnly: boolean }
  | { ok: false; error: string };

const isAdmin = (r?: string | null) => r === "ADMIN";

/**
 * The single authority on what an action does.
 *
 * The client posts an ACTION, never a target status — so a client cannot invent
 * a state, and CONFIRMED_OPERATED / CONFIRMED_CANCELLED / CUSTOMER_NO_SHOW are
 * reachable only through an explicit operator decision.
 */
export function applyAction(state: ReviewState, action: HistoricalAction, ctx: ActionContext = {}): TransitionResult {
  const from = state.reviewStatus;
  const ok = (status: HistoricalReviewStatus, auditAction: string, adminOnly = false): TransitionResult =>
    adminOnly && !isAdmin(ctx.role)
      ? { ok: false, error: "admin-only" }
      : { ok: true, status, auditAction, adminOnly };

  // COMPLETED is terminal. Nothing reopens a finished reconstruction; the sheet
  // itself is the record from that point on.
  if (from === "COMPLETED") return { ok: false, error: "completed-is-terminal" };

  // A note never changes state, so it is allowed from anywhere still open.
  if (action === "addNote") {
    if (!ctx.reason?.trim()) return { ok: false, error: "note-required" };
    return ok(from, "historical.note_added");
  }

  switch (action) {
    case "confirmOperated":
      if (from === "NEEDS_REVIEW" || from === "NEEDS_EVIDENCE" || from === "GUIDE_UNKNOWN")
        return ok("CONFIRMED_OPERATED", "historical.confirmed_operated");
      break;

    case "confirmCancelled":
      if (from === "NEEDS_REVIEW" || from === "NEEDS_EVIDENCE") {
        if (!ctx.reason?.trim()) return { ok: false, error: "reason-required" };
        return ok("CONFIRMED_CANCELLED", "historical.confirmed_cancelled");
      }
      break;

    case "confirmNoShow":
      if (from === "NEEDS_REVIEW" || from === "NEEDS_EVIDENCE")
        return ok("CUSTOMER_NO_SHOW", "historical.confirmed_no_show");
      break;

    case "needEvidence":
      if (from === "NEEDS_REVIEW" || from === "CONFIRMED_OPERATED" || from === "CUSTOMER_NO_SHOW") {
        if (!ctx.reason?.trim()) return { ok: false, error: "note-required" };
        return ok("NEEDS_EVIDENCE", "historical.needs_evidence");
      }
      break;

    case "guideUnknown":
      if (from === "NEEDS_REVIEW" || from === "CONFIRMED_OPERATED" || from === "CUSTOMER_NO_SHOW")
        return ok("GUIDE_UNKNOWN", "historical.guide_unknown");
      break;

    case "setGuide": {
      if (!ctx.guideId?.trim()) return { ok: false, error: "guide-required" };
      // Naming a guide on a finished draft would leave the sheet attributed to
      // someone else. Reverse it first — that is an explicit, audited act.
      if (from === "RECONSTRUCTED_DRAFT") return { ok: false, error: "reverse-draft-first" };
      if (from === "GUIDE_UNKNOWN") return ok("CONFIRMED_OPERATED", "historical.guide_set");
      // Changing the guide costs readiness: it has to be re-earned deliberately.
      if (from === "READY_TO_RECONSTRUCT") return ok("CONFIRMED_OPERATED", "historical.guide_changed");
      if (from === "CONFIRMED_OPERATED" || from === "CUSTOMER_NO_SHOW" || from === "NEEDS_REVIEW" || from === "NEEDS_EVIDENCE")
        return ok(from, "historical.guide_set");
      break;
    }

    case "markReady":
      if (from === "CONFIRMED_OPERATED" || from === "CUSTOMER_NO_SHOW") {
        if (!state.confirmedGuideId) return { ok: false, error: "guide-required" };
        if (ctx.sheetExistsAtKey) return { ok: false, error: "sheet-already-exists" };
        if (ctx.hasUnresolvedDuplicate) return { ok: false, error: "unresolved-duplicate" };
        return ok("READY_TO_RECONSTRUCT", "historical.ready");
      }
      break;

    case "reconstruct":
      if (from === "READY_TO_RECONSTRUCT") {
        if (!state.confirmedGuideId) return { ok: false, error: "guide-required" };
        if (state.jobSheetId) return { ok: false, error: "already-reconstructed" };
        if (ctx.sheetExistsAtKey) return { ok: false, error: "sheet-already-exists" };
        if (ctx.hasUnresolvedDuplicate) return { ok: false, error: "unresolved-duplicate" };
        return ok("RECONSTRUCTED_DRAFT", "historical.reconstructed");
      }
      break;

    case "complete":
      if (from === "RECONSTRUCTED_DRAFT") {
        if (!state.jobSheetId) return { ok: false, error: "job-sheet-required" };
        return ok("COMPLETED", "historical.completed");
      }
      break;

    case "exclude":
      if (from === "CONFIRMED_CANCELLED" || from === "NEEDS_REVIEW" || from === "NEEDS_EVIDENCE") {
        if (!ctx.reason?.trim()) return { ok: false, error: "reason-required" };
        return ok("EXCLUDED", "historical.excluded");
      }
      break;

    case "reverse":
      // Undoing a draft removes a real job sheet, so it is ADMIN-only and the
      // route does the PEAK / payment checks around it.
      if (from === "RECONSTRUCTED_DRAFT") return ok("NEEDS_REVIEW", "historical.reversed", true);
      break;

    case "reopen":
      // An exclusion can be wrong; reopening it is ADMIN-only so it leaves a trail.
      if (from === "EXCLUDED") return ok("NEEDS_REVIEW", "historical.reopened", true);
      if (from === "CONFIRMED_CANCELLED" || from === "CONFIRMED_OPERATED" || from === "CUSTOMER_NO_SHOW"
        || from === "GUIDE_UNKNOWN" || from === "NEEDS_EVIDENCE" || from === "READY_TO_RECONSTRUCT")
        return ok("NEEDS_REVIEW", "historical.reopened");
      break;
  }
  return { ok: false, error: `not-allowed-from-${from}` };
}

/** Whether the Create-historical-draft control may be shown at all. */
export function canReconstruct(state: ReviewState, ctx: ActionContext = {}): boolean {
  return applyAction(state, "reconstruct", ctx).ok;
}

/** What a reviewer still has to supply before this row can move forward. */
export function missingInfo(state: ReviewState): string[] {
  const out: string[] = [];
  if (!state.confirmedGuideId) out.push("guide not identified");
  if (state.reviewStatus === "NEEDS_REVIEW") out.push("operation not confirmed");
  return out;
}

/** The immutable provenance line stamped on a reconstructed sheet. */
export function reconstructionNote(args: { instanceKey: string; by: string; at: Date }): string {
  return `Reconstructed from historical records on ${args.at.toISOString().slice(0, 10)} by ${args.by}. `
    + `Review ${args.instanceKey}. Not submitted by the guide.`;
}
