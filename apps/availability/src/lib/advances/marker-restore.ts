// Restore missing `advanceSettlement` markers from the ledger — the rollback-safety repair.
//
// Why it exists (Phase 1F rehearsal, owner decision 2026-10-02): if writes have ever been
// enabled and the app is rolled back to code from before Phase 1B (0d35ff4), that code's job
// sheet save drops the `advanceSettlement` marker from a settled row — the ledger keeps the
// live EXPENSE_SETTLEMENT, but the row is no longer protected. Before rolling forward again,
// the markers are put back from the ledger. A guard inside the new app cannot help: the old
// code is what writes the sheet.
//
// The ledger is the authority. For every LIVE EXPENSE_SETTLEMENT (not reversed, not a
// reversal) its explicit Phase 1B `lines` say which rows it settled: identity, amount,
// category, advance. A marker is restored on a row only when exactly one row of that job
// sheet matches a line on all of them. Anything else — no row, two rows, a different amount,
// category or advance, a marker naming another settlement — refuses the WHOLE sheet for a
// person to look at. Nothing here creates, reverses or changes a settlement, a payer, a
// category, a link, an advance counter, a return, a refund, PEAK data or a payment; the only
// thing ever written is the marker field on a matched row.
//
// Nothing it reports or audits carries an expense description, note, guest or booking: a row
// is named by its snapshot line number, category, amount, settlement entry and a short hash of
// its identity — descriptions are free text and may one day hold personal data.
import { createHash } from "node:crypto";
import { expenseAmount, expenseCategory } from "@/lib/jobsheet";
import { financialIdentity } from "@/lib/protected-expense-fields";
import type { SettledMarker, SheetRow } from "./settlement";
import type { PrismaClient } from "@prisma/client";
import { advanceWritesFrozen } from "./freeze";

export type LiveSettlement = { id: string; advanceId: string; advanceNo: string; sourceId: string; amountSatang: number; snapshot: unknown };
export type SheetIssueCode =
  | "NO_LINES" | "LINES_DISAGREE_WITH_LEDGER" | "ROW_NOT_FOUND" | "DUPLICATE_IDENTITY" | "AMOUNT_MISMATCH" | "CATEGORY_MISMATCH"
  | "ADVANCE_MISMATCH" | "CONFLICTING_MARKER" | "ROW_CLAIMED_TWICE" | "STALE_MARKER" | "SHEET_NOT_FOUND";
export type SheetIssue = { code: SheetIssueCode; entryId?: string; detail: string };
export type SheetPlan = {
  sheetId: string; jobNo: string | null;
  settlements: string[];            // live settlement entry ids on this sheet
  expected: number;                 // markers the ledger says should exist
  correct: number;                  // already right
  missing: { index: number; entryId: string; marker: SettledMarker }[];
  issues: SheetIssue[];             // any issue → the sheet is not repaired
  safe: boolean;
};

const satang = (v: number) => Math.round(v * 100);
/** A short, stable, non-reversible tag for a row identity — safe to print and audit. */
export const identityTag = (identity: unknown) => createHash("sha256").update(String(identity ?? "")).digest("hex").slice(0, 10);
/** How a settled line is named in reports: never its description. */
const lineLabel = (l: { index?: unknown; category?: unknown; amountSatang?: unknown; identity?: unknown }) =>
  `line (row ${Number.isInteger(l.index) ? (l.index as number) + 1 : "?"}, ${String(l.category ?? "uncategorised")}, ${Number.isSafeInteger(l.amountSatang) ? l.amountSatang : "?"} satang, id ${identityTag(l.identity)})`;
type Line = { identity?: unknown; amountSatang?: unknown; category?: unknown; advanceId?: unknown; index?: unknown };

/** What the ledger says about one sheet, compared with its rows. Pure — no reads, no writes. */
export function planSheet(sheet: { id: string; ref: string | null; expenses: unknown } | null, sheetId: string, settlements: readonly LiveSettlement[]): SheetPlan {
  const plan: SheetPlan = { sheetId, jobNo: sheet?.ref ?? null, settlements: settlements.map((s) => s.id), expected: 0, correct: 0, missing: [], issues: [], safe: false };
  if (!sheet) { plan.issues.push({ code: "SHEET_NOT_FOUND", detail: "The settled job sheet no longer exists" }); return plan; }
  const rows = (Array.isArray(sheet.expenses) ? sheet.expenses : []) as SheetRow[];
  const live = new Set(settlements.map((s) => s.id));
  const claimedBy = new Map<number, string>(); // row index → entry id

  for (const s of settlements) {
    const snap = (s.snapshot ?? {}) as { lines?: unknown };
    const lines = Array.isArray(snap.lines) ? (snap.lines as Line[]) : null;
    if (!lines || !lines.length) { plan.issues.push({ code: "NO_LINES", entryId: s.id, detail: "This settlement has no explicit lines — it cannot be matched to rows" }); continue; }
    const total = lines.reduce((t, l) => t + (Number.isSafeInteger(l.amountSatang) ? (l.amountSatang as number) : NaN), 0);
    if (total !== s.amountSatang || lines.some((l) => l.advanceId !== s.advanceId)) {
      plan.issues.push({ code: "LINES_DISAGREE_WITH_LEDGER", entryId: s.id, detail: "The settlement's lines do not add up to the ledger entry, or name another advance" });
      continue;
    }
    for (const l of lines) {
      plan.expected++;
      const label = lineLabel(l);
      const sameIdentity = rows.map((r, i) => ({ r, i })).filter(({ r }) => financialIdentity(r) === l.identity);
      if (!sameIdentity.length) { plan.issues.push({ code: "ROW_NOT_FOUND", entryId: s.id, detail: `No row reads like ${label} any more` }); continue; }
      if (sameIdentity.length > 1) { plan.issues.push({ code: "DUPLICATE_IDENTITY", entryId: s.id, detail: `${sameIdentity.length} rows read exactly like ${label} — nothing can tell which one was settled` }); continue; }
      const { r, i } = sameIdentity[0];
      if (satang(expenseAmount(r)) !== l.amountSatang) { plan.issues.push({ code: "AMOUNT_MISMATCH", entryId: s.id, detail: `The row for ${label} no longer has the settled amount` }); continue; }
      if (expenseCategory(r) !== l.category) { plan.issues.push({ code: "CATEGORY_MISMATCH", entryId: s.id, detail: `The row for ${label} has another category now` }); continue; }
      if ((r.advanceId ?? null) !== s.advanceId) { plan.issues.push({ code: "ADVANCE_MISMATCH", entryId: s.id, detail: `The row for ${label} is linked to ${r.advanceId ? "another advance" : "no advance"}` }); continue; }
      if (claimedBy.has(i) && claimedBy.get(i) !== s.id) { plan.issues.push({ code: "ROW_CLAIMED_TWICE", entryId: s.id, detail: `The row for ${label} is claimed by two live settlements` }); continue; }
      claimedBy.set(i, s.id);
      const m = r.advanceSettlement;
      if (m && typeof m === "object") {
        if (m.entryId === s.id && m.advanceId === s.advanceId) { plan.correct++; continue; }
        plan.issues.push({ code: "CONFLICTING_MARKER", entryId: s.id, detail: `The row for ${label} carries a marker for another settlement — never overwritten` });
        continue;
      }
      plan.missing.push({ index: i, entryId: s.id, marker: { entryId: s.id, advanceId: s.advanceId, advanceNo: s.advanceNo } });
    }
  }
  // A marker that no live settlement on this sheet stands behind is not this tool's to touch —
  // but it is reported, and it stops the sheet from being "repaired" around it.
  rows.forEach((r, i) => {
    const m = r.advanceSettlement;
    if (m && typeof m === "object" && !live.has(m.entryId) && !claimedBy.has(i)) {
      plan.issues.push({ code: "STALE_MARKER", entryId: m.entryId, detail: `Row ${i + 1} carries a marker for a settlement that is not live on this sheet` });
    }
  });
  plan.safe = plan.issues.length === 0;
  return plan;
}

/** The sheet's rows with ONLY the missing markers added; every other byte of every row is kept. */
export function withRestoredMarkers(expenses: unknown, missing: SheetPlan["missing"]): unknown[] {
  const rows = (Array.isArray(expenses) ? expenses : []) as Record<string, unknown>[];
  const at = new Map(missing.map((m) => [m.index, m.marker]));
  return rows.map((r, i) => (at.has(i) ? { ...r, advanceSettlement: at.get(i) } : r));
}

// ── reading the ledger and (only in apply mode) writing markers ──────────────

export const RESTORE_TOOL = "restore-settlement-markers";
export type RestoreReport = {
  mode: "dry-run" | "apply";
  sheetsInspected: number; settlementsInspected: number; expectedMarkers: number; correctMarkers: number;
  missingMarkers: number; restoredMarkers: number; sheetsRepaired: number;
  refusedSheets: { sheetId: string; jobNo: string | null; issues: { code: SheetIssueCode; entryId?: string; detail: string }[] }[];
  conflictsAtWrite: { sheetId: string; jobNo: string | null; reason: string }[];
};

async function liveSettlements(db: PrismaClient | Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0], sheetIds?: string[]) {
  const entries = await db.guideAdvanceEntry.findMany({
    where: { type: "EXPENSE_SETTLEMENT", sourceType: "JOB_SHEET", reversedByEntryId: null, reversesEntryId: null, ...(sheetIds ? { sourceId: { in: sheetIds } } : {}) },
    select: { id: true, advanceId: true, sourceId: true, amountSatang: true, snapshot: true, advance: { select: { advanceNo: true } } },
    orderBy: { id: "asc" },
  });
  return entries.map((e) => ({ id: e.id, advanceId: e.advanceId, advanceNo: e.advance.advanceNo, sourceId: e.sourceId, amountSatang: e.amountSatang, snapshot: e.snapshot }));
}

/**
 * Dry run (default) or apply. Apply refuses unless advance writes are frozen — the repair
 * must never race a settlement — and repairs a sheet only if a fresh plan, taken inside its
 * transaction, is still safe and still needs exactly the same markers.
 */
export async function runMarkerRestore(prisma: PrismaClient, opts: { mode: "dry-run" | "apply"; operator?: string }): Promise<RestoreReport | { refused: string }> {
  if (opts.mode === "apply") {
    if (!advanceWritesFrozen()) return { refused: "APPLY refused: ADVANCE_WRITES_FROZEN is not 1 — markers are restored only while advance writes are frozen" };
    if (!(opts.operator ?? "").trim()) return { refused: "APPLY refused: say who is running it (operator) — it goes in the audit log" };
  }
  const settlements = await liveSettlements(prisma);
  const bySheet = new Map<string, LiveSettlement[]>();
  for (const s of settlements) bySheet.set(s.sourceId, [...(bySheet.get(s.sourceId) ?? []), s]);
  const sheets = await prisma.jobSheet.findMany({ where: { id: { in: [...bySheet.keys()] } }, select: { id: true, ref: true, expenses: true } });
  const report: RestoreReport = { mode: opts.mode, sheetsInspected: bySheet.size, settlementsInspected: settlements.length, expectedMarkers: 0, correctMarkers: 0, missingMarkers: 0, restoredMarkers: 0, sheetsRepaired: 0, refusedSheets: [], conflictsAtWrite: [] };
  const plans = [...bySheet.entries()].map(([sheetId, ss]) => planSheet(sheets.find((x) => x.id === sheetId) ?? null, sheetId, ss));
  for (const p of plans) {
    report.expectedMarkers += p.expected; report.correctMarkers += p.correct; report.missingMarkers += p.missing.length;
    if (!p.safe) report.refusedSheets.push({ sheetId: p.sheetId, jobNo: p.jobNo, issues: p.issues });
  }
  if (opts.mode !== "apply") return report;

  for (const p of plans.filter((x) => x.safe && x.missing.length)) {
    const outcome = await prisma.$transaction(async (tx) => {
      // Re-check everything inside the transaction: the sheet and its live settlements now.
      const locked = await tx.$queryRaw<{ id: string; ref: string | null; expenses: unknown }[]>`SELECT id, ref, expenses FROM "JobSheet" WHERE id = ${p.sheetId} FOR UPDATE`;
      const now = locked[0] ?? null;
      const fresh = planSheet(now, p.sheetId, await liveSettlements(tx, [p.sheetId]));
      const same = JSON.stringify(fresh.missing) === JSON.stringify(p.missing) && JSON.stringify(fresh.settlements) === JSON.stringify(p.settlements);
      if (!fresh.safe || !same) return { conflict: fresh.safe ? "the sheet or its settlements changed since the dry run" : fresh.issues.map((x) => x.code).join(", ") };
      const next = withRestoredMarkers(now!.expenses, fresh.missing);
      // Raw SQL on purpose: only the expenses JSON changes — updatedAt (the sheet's version) is
      // left as it was, so approvals and open screens are not disturbed by a repair.
      // The row is locked (FOR UPDATE) and re-planned under the lock; the expenses it was planned
      // from are still the guard, so a write that slipped in would refuse rather than be merged.
      const hit = await tx.$executeRaw`UPDATE "JobSheet" SET expenses = ${JSON.stringify(next)}::jsonb WHERE id = ${p.sheetId} AND expenses = ${JSON.stringify(now!.expenses)}::jsonb`;
      if (hit !== 1) return { conflict: "the sheet changed while it was being repaired" };
      await tx.auditLog.create({ data: {
        actorId: null, actorRole: "TOOL", action: "advance.settlement_markers_restored", entityType: "JobSheet", entityId: p.sheetId,
        detail: { tool: RESTORE_TOOL, operator: opts.operator!.trim(), jobNo: p.jobNo, settlementEntryIds: [...new Set(fresh.missing.map((m) => m.entryId))], markersRestored: fresh.missing.length, rows: fresh.missing.map((m) => ({ index: m.index, entryId: m.entryId, advanceNo: m.marker.advanceNo })), at: new Date().toISOString() },
      } });
      return { restored: fresh.missing.length };
    });
    if ("conflict" in outcome) report.conflictsAtWrite.push({ sheetId: p.sheetId, jobNo: p.jobNo, reason: outcome.conflict ?? "" });
    else { report.restoredMarkers += outcome.restored; report.sheetsRepaired++; }
  }
  return report;
}
