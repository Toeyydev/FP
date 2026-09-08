// Stops a reconstructed historical job sheet being swept away by the generic
// cleanup paths.
//
// Six user-visible routes delete job sheets by (guideId, date, slotIdx) — a guide
// being un-assigned, a slot being re-split, a payment removed, an import tidying
// an emptied slot. None of them know about the backlog, and a reconstructed sheet
// sitting at that key would be deleted as collateral, leaving the review pointing
// at nothing.
//
// Two layers, deliberately:
//   1. this preflight, so the operator gets a 409 explaining what to do;
//   2. the FK's ON DELETE RESTRICT, which catches the concurrent case the
//      preflight cannot — a draft created between the check and the delete.
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export const HISTORICAL_DELETE_ERROR = "historical-job-requires-reversal";
export const HISTORICAL_DELETE_MESSAGE =
  "This Job Sheet was reconstructed from historical records. An administrator must reverse the historical draft before it can be removed.";

/**
 * Is any sheet matching this filter a reconstructed historical draft?
 *
 * Takes the caller's own `where` verbatim — one route deletes across a date
 * RANGE, not a single day, so a narrower signature would have forced that caller
 * to guess at a different filter than the one it actually deletes with. The
 * check and the delete must see the same rows or the guard is theatre.
 */
export async function hasHistoricalJobSheet(where: Prisma.JobSheetWhereInput): Promise<boolean> {
  const n = await prisma.jobSheet.count({
    where: { ...where, OR: [{ origin: "HISTORICAL_BACKFILL" }, { historicalReview: { isNot: null } }] },
  });
  return n > 0;
}

/** Prisma's foreign-key violation. The backstop when the preflight was raced. */
export function isRestrictViolation(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === "P2003" || code === "P2014";
}

/**
 * The one response shape every guarded route returns, so the client can branch on
 * a stable code. Deliberately says nothing about Prisma, tables or stack traces.
 */
export function historicalDeleteConflict(): { body: { error: string; message: string }; status: 409 } {
  return { body: { error: HISTORICAL_DELETE_ERROR, message: HISTORICAL_DELETE_MESSAGE }, status: 409 };
}
