// "No receipt" on a Tour Expense row: the reason a guide or the office gives for a row
// with no ticket or receipt behind it (owner, 2026-11-07). Kept on the row as
//
//   noReceipt: { reason, by, role, at }
//
// and printed against that row on the certificate in lieu of a receipt issued at Approve
// (lib/certificates/payload). Pure helpers here; the write is lib/expense-attachments/no-receipt.
//
// The browser never writes it through a sheet save: `expenseZ` does not declare it, so a
// save drops it, and the save carries the stored one across by the row's stable id
// (carryNoReceipt). Only the no-receipt endpoint sets or clears it.

export type NoReceipt = { reason: string; by: string | null; role: string | null; at: string };
type RowLike = { rowId?: string | null; receiptUrl?: string | null; receiptFileId?: string | null; noReceipt?: unknown };

export const NO_RECEIPT_MIN = 3;
export const NO_RECEIPT_MAX = 300;

/** Ready-made reasons. "Other" is typed by the person. */
export const NO_RECEIPT_REASONS_TH = [
  "ผู้ขายไม่ออกใบเสร็จ (ร้านค้ารายย่อย / รถโดยสาร / เรือ)",
  "ตั๋วหรือใบเสร็จหาย",
  "ตั๋วไม่มีราคาแสดง (มีแค่หางตั๋ว)",
] as const;

const hasReceipt = (r: RowLike) => !!((r.receiptUrl ?? "").trim() || (r.receiptFileId ?? "").trim());

/** The reason on a row, when the row still has no receipt; null otherwise. */
export function noReceiptReason(r: RowLike | null | undefined): string | null {
  if (!r || hasReceipt(r)) return null;
  const n = r.noReceipt as Partial<NoReceipt> | null | undefined;
  const reason = typeof n?.reason === "string" ? n.reason.trim() : "";
  return reason || null;
}

/** The row without its reason. Same object back when it has none. */
export function withoutNoReceipt<T extends RowLike>(r: T): T {
  if (!r || !("noReceipt" in r)) return r;
  const copy = { ...r };
  delete copy.noReceipt;
  return copy;
}

/** Put each stored row's reason back on the row with the same id; drop it where a receipt is now attached. */
export function carryNoReceipt<T extends RowLike>(stored: readonly RowLike[] | null | undefined, rows: readonly T[]): T[] {
  const byId = new Map<string, unknown>();
  for (const s of stored ?? []) if (s?.rowId && s.noReceipt) byId.set(s.rowId, s.noReceipt);
  return rows.map((r) => {
    const base = withoutNoReceipt(r);
    const n = r.rowId ? byId.get(r.rowId) : undefined;
    return n && !hasReceipt(base) ? { ...base, noReceipt: n } : base;
  });
}

/** Why a reason cannot be accepted, or null. */
export function checkNoReceiptReason(reason: string): "reason-short" | "reason-long" | null {
  const t = reason.trim();
  if (t.length < NO_RECEIPT_MIN) return "reason-short";
  if (t.length > NO_RECEIPT_MAX) return "reason-long";
  return null;
}
