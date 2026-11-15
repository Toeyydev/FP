// Operator review on the job sheet (owner 2026-11-15) — server side.
//
// 1. Tour expenses (Water / Bus / Ferry): the operator approves the guide's amount, approves a
//    different amount (reason required) or rejects it (reason required). The review is stored on
//    the guide's report row; an approval also writes the verified amount into the job's accounting
//    row for that item — the one row per item, so a second approval updates it, never adds one.
//    A row whose payer is already confirmed (or settled / certified) is not rewritten: if it
//    already shows the verified amount the review is simply recorded, otherwise it is refused
//    and the operator corrects the accounting row itself. An approved or paid sheet is locked.
// 2. Ticket receipts (Company ADV rows): the operator marks a row's current files Verified /
//    Rejected / asks for a new one (a note the guide reads), or adds an internal note. This never
//    touches the advance, its settlement or PEAK — those stay with Admin / Accountant.
//
// Every decision is kept in AuditLog (entityType JobSheet) and shown as the item's history.
// (The cross-sheet queue of reports still to check is lib/expense-review.)

import type { PrismaClient } from "@prisma/client";
import { expenseAmount, isApproved, type Expense } from "@/lib/jobsheet";
import { isProtected, type ProtectedRow } from "@/lib/protected-expense-fields";
import { newRowId } from "@/lib/expense-row-id";
import { decideReview, fixedItemOf, FIXED_ITEMS, isAdvanceRow, pricePaxFor, type FixedItemKey, type ReportRow, type ReviewDecision } from "@/lib/guide-fixed-expenses";

type Actor = { id: string | null; role: string | null };
type Fail = { ok: false; status: number; reasons: string[] };
const fail = (status: number, ...reasons: string[]): Fail => ({ ok: false, status, reasons });
const r2 = (n: number) => Math.round(n * 100) / 100;
export type SheetKey = { guideId: string; date: string; slotIdx: number };

async function loadSheet(db: PrismaClient, input: SheetKey) {
  const k = { guideId: input.guideId, date: input.date, slotIdx: input.slotIdx };
  const sheet = await db.jobSheet.findUnique({ where: { guideId_date_slotIdx: k } });
  if (!sheet) return null;
  const pay = await db.tourPayment.findUnique({ where: { guideId_date_slotIdx: k }, select: { status: true } });
  return { sheet, paid: pay?.status === "PAID" };
}

async function auditSheet(db: PrismaClient, sheetId: string, actor: Actor, action: string, detail: Record<string, unknown>) {
  await db.auditLog.create({ data: { actorId: actor.id, actorRole: actor.role, action, entityType: "JobSheet", entityId: sheetId, detail: detail as object } }).catch(() => {});
}

// ── Tour expenses ────────────────────────────────────────────────────────────────────────────

export async function reviewExpense(db: PrismaClient, input: SheetKey & { item: FixedItemKey; decision: ReviewDecision; actor: Actor }): Promise<{ ok: true; status: string; verified: number; accountingRow: "updated" | "added" | "unchanged" } | Fail> {
  const item = FIXED_ITEMS.find((f) => f.key === input.item);
  if (!item) return fail(400, "Unknown item");
  const loaded = await loadSheet(db, input);
  if (!loaded) return fail(404, "This job has no sheet yet");
  const { sheet, paid } = loaded;
  if (isApproved(sheet.approvalStatus) || paid) return fail(409, "The job sheet is approved — its expenses are locked");

  const report = ((sheet.guideExpenses as ReportRow[] | null) ?? []).map((r) => ({ ...r }));
  const ri = report.findIndex((r) => fixedItemOf(r)?.key === item.key && expenseAmount(r) > 0);
  if (ri < 0) return fail(404, `The guide did not report ${item.label}`);
  const reportedRow = report[ri];
  const reported = r2(expenseAmount(reportedRow));
  const decided = decideReview(reported, input.decision);
  if (!decided.ok) return fail(400, ...decided.reasons);

  // The job's accounting row for this item — one per item.
  const official = ((sheet.expenses as Expense[] | null) ?? []).map((e) => ({ ...e }));
  const matches = official.map((e, i) => ({ e, i })).filter(({ e }) => fixedItemOf(e)?.key === item.key);
  if (matches.length > 1) return fail(409, `The accounting rows list ${item.label} ${matches.length} times — merge them into one before reviewing`);
  let accountingRow: "updated" | "added" | "unchanged" = "unchanged";
  const want = pricePaxFor(decided.verified, reportedRow);
  if (matches.length === 1) {
    const { e, i } = matches[0];
    if (r2(expenseAmount(e)) !== decided.verified) {
      if (isProtected(e as ProtectedRow)) return fail(409, `${item.label}'s accounting row is confirmed at ${r2(expenseAmount(e)).toFixed(2)} — correct that row first, then record the review`);
      official[i] = { ...e, price: want.price, pax: want.pax };
      accountingRow = "updated";
    }
  } else if (decided.verified > 0) {
    official.push({ rowId: newRowId(), description: item.description, expenseType: item.expenseType, price: want.price, pax: want.pax } as Expense);
    accountingRow = "added";
  }

  report[ri] = { ...reportedRow, reviewStatus: decided.status, verifiedAmount: decided.verified, reviewReason: decided.reason, reviewedAt: new Date().toISOString(), reviewedById: input.actor.id, reviewedOf: reported };
  // Conditional on the sheet not having moved since it was read: a save in between wins, and
  // this is refused rather than writing over it.
  const moved = await db.jobSheet.updateMany({
    where: { id: sheet.id, updatedAt: sheet.updatedAt },
    data: { guideExpenses: report as object, ...(accountingRow !== "unchanged" ? { expenses: official as object } : {}) },
  });
  if (!moved.count) return fail(409, "The job sheet changed while you were reviewing — reload it");
  await auditSheet(db, sheet.id, input.actor, "expense.review", { item: item.key, label: item.description, status: decided.status, reported, verified: decided.verified, reason: decided.reason, accountingRow });
  return { ok: true, status: decided.status, verified: decided.verified, accountingRow };
}

// ── Ticket receipts ──────────────────────────────────────────────────────────────────────────

export type ReceiptAction = "VERIFY" | "REJECT" | "REQUEST_NEW" | "NOTE";

export async function reviewReceipts(db: PrismaClient, input: SheetKey & { rowId: string; action: ReceiptAction; note?: string | null; actor: Actor },
  notify?: (guideId: string, message: string) => Promise<void>): Promise<{ ok: true; files: number } | Fail> {
  const loaded = await loadSheet(db, input);
  if (!loaded) return fail(404, "This job has no sheet yet");
  const { sheet } = loaded;
  const row = ((sheet.expenses as Expense[] | null) ?? []).find((e) => e.rowId === input.rowId);
  if (!row) return fail(404, "No such row on the sheet");
  if (!isAdvanceRow(row)) return fail(409, "Only rows paid from the Company ADV are reviewed here");
  const note = (input.note ?? "").trim() || null;
  if (input.action !== "VERIFY" && (!note || note.length < 4)) return fail(400, input.action === "NOTE" ? "Write the note" : "Say what is wrong (the guide sees this)");
  const files = await db.expenseAttachment.findMany({ where: { jobSheetId: sheet.id, expenseRowId: input.rowId, status: "UPLOADED" }, select: { id: true } });
  if (input.action === "VERIFY" && !files.length) return fail(409, "There is no receipt to verify yet");

  if (input.action !== "NOTE") {
    const status = input.action === "VERIFY" ? "VERIFIED" : input.action === "REJECT" ? "REJECTED" : "REPLACEMENT_REQUESTED";
    if (files.length) await db.expenseAttachment.updateMany({ where: { id: { in: files.map((f) => f.id) } }, data: { reviewStatus: status, reviewNote: input.action === "VERIFY" ? null : note, reviewedById: input.actor.id, reviewedAt: new Date() } });
  }
  await auditSheet(db, sheet.id, input.actor, "receipt.review", { rowId: input.rowId, label: row.description, action: input.action, note, files: files.length, internal: input.action === "NOTE" });
  if ((input.action === "REQUEST_NEW" || input.action === "REJECT") && notify) {
    await notify(sheet.guideId, `${row.description} receipt (${sheet.ref ?? input.date}): ${note} — please upload a new one on the job sheet.`).catch(() => {});
  }
  return { ok: true, files: files.length };
}

// ── History ──────────────────────────────────────────────────────────────────────────────────

/** Review decisions on this sheet, oldest first. Operators only — it carries internal notes. */
export async function reviewHistory(db: PrismaClient, sheetId: string) {
  const rows = await db.auditLog.findMany({ where: { entityType: "JobSheet", entityId: sheetId, action: { in: ["expense.review", "receipt.review"] } }, orderBy: { createdAt: "asc" }, take: 300, select: { createdAt: true, action: true, actorRole: true, detail: true } });
  return rows.map((r) => ({ at: r.createdAt.toISOString(), action: r.action, by: r.actorRole ?? "", detail: r.detail as Record<string, unknown> }));
}
