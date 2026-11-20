import type { PrismaClient } from "@prisma/client";
import { prisma as defaultDb } from "@/lib/db";
import { audit } from "@/lib/audit";
import { isApproved } from "@/lib/jobsheet";
import { canAdd, rewriteRows, rowIdFor, type Actor } from "@/lib/expense-attachments/service";
import { checkNoReceiptReason, withoutNoReceipt, type NoReceipt } from "@/lib/expense-attachments/no-receipt-row";

// Set or clear the "no receipt" reason on one expense row (see ./no-receipt-row).
// The same people who may attach a file may give the reason: the guide on their own job,
// the office on every job. Not once the sheet is approved — the certificate issued at
// Approve prints the reason, and a reason changed under it would make it stale.

export type NoReceiptResult = { ok: true; rowId: string } | { ok: false; status: number; error: string };

export async function setNoReceipt(o: {
  db?: PrismaClient; actor: Actor; sheet: { guideId: string; date: string; slotIdx: number };
  rowId?: string | null; expenseIndex?: number | null; reason: string | null;
}, now: Date = new Date()): Promise<NoReceiptResult> {
  const db = o.db ?? defaultDb;
  const sheet = await db.jobSheet.findUnique({ where: { guideId_date_slotIdx: o.sheet }, select: { id: true, ref: true, guideId: true, approvalStatus: true } });
  if (!sheet) return { ok: false, status: 404, error: "no-sheet" };
  if (!canAdd(o.actor, sheet.guideId)) return { ok: false, status: 403, error: "forbidden" };
  if (isApproved(sheet.approvalStatus)) return { ok: false, status: 409, error: "approved" };
  const reason = (o.reason ?? "").trim();
  if (reason) { const bad = checkNoReceiptReason(reason); if (bad) return { ok: false, status: 400, error: bad }; }

  const rowId = await rowIdFor(db, sheet.id, { rowId: o.rowId, index: o.expenseIndex });
  if (!rowId) return { ok: false, status: 404, error: "row-not-found" };
  let refused: string | null = null;
  let description = "";
  const written = await rewriteRows(db, sheet.id, (cur) => {
    const i = cur.findIndex((r) => r.rowId === rowId);
    if (i < 0) { refused = "row-not-found"; return null; }
    const row = cur[i];
    description = (row.description ?? "").trim();
    if (reason && ((row.receiptUrl ?? "").trim() || (row.receiptFileId ?? "").trim())) { refused = "has-receipt"; return null; }
    const next = reason
      ? { ...row, noReceipt: { reason, by: o.actor.id, role: o.actor.role ?? null, at: now.toISOString() } satisfies NoReceipt }
      : withoutNoReceipt(row);
    if (next === row) return null;
    return cur.map((r, j) => (j === i ? next : r));
  });
  if (refused) return { ok: false, status: refused === "has-receipt" ? 409 : 404, error: refused };
  if (!written) return { ok: false, status: 409, error: "busy" };
  await audit({ actorId: o.actor.id, actorRole: o.actor.role ?? null, action: reason ? "jobsheet.no_receipt_set" : "jobsheet.no_receipt_cleared", entityType: "JobSheet", entityId: sheet.id,
    detail: { ref: sheet.ref, rowId, row: description, ...(reason ? { reason } : {}) } });
  return { ok: true, rowId };
}
