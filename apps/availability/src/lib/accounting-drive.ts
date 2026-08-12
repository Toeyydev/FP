// Accounting document tree in the admin@folkpaths.com Drive:
//   Folkpaths Accounting / <Category> / <YYYY> / <NNMMM> / <Job No.> / files
// Category first (accountants review by transaction type + month, not by job),
// Gregorian year, fixed uppercase month codes, and the folder month comes from
// the FINANCIAL TRANSACTION date (advance paidAt / returnedAt / payment paidAt)
// — never the tour date. Folders are created lazily on first upload.
export const ACCOUNTING_ROOT = "Folkpaths Accounting";

export const MONTH_CODES = ["01JAN", "02FEB", "03MAR", "04APR", "05MAY", "06JUN", "07JUL", "08AUG", "09SEP", "10OCT", "11NOV", "12DEC"] as const;

export type FinancialCategory = "advance" | "advance_return" | "guide_payment" | "wht" | "other";
export const CATEGORY_FOLDER: Record<FinancialCategory, string> = {
  advance: "Advance",
  advance_return: "Return",
  guide_payment: "Guide-Payment",
  wht: "WHT",
  other: "Other",
};

// Year/month in Asia/Bangkok — a transfer at 23:30 Bangkok on 31 Jul must file
// under 07JUL even though it is already August in UTC.
export function accountingFolderPath(category: FinancialCategory, txAt: Date, jobRef: string): string[] {
  const bkk = new Date(txAt.getTime() + 7 * 3600 * 1000);
  const year = String(bkk.getUTCFullYear());
  const month = MONTH_CODES[bkk.getUTCMonth()];
  return [ACCOUNTING_ROOT, CATEGORY_FOLDER[category], year, month, jobRef];
}

// Keep the real file type: a rename may change the words, never the extension.
export function enforceExtension(displayName: string, mimeType: string): string {
  const ext = mimeType.includes("png") ? "png" : mimeType.includes("pdf") ? "pdf" : mimeType.includes("webp") ? "webp" : "jpg";
  const base = displayName.replace(/\.(png|jpe?g|pdf|webp)$/i, "").trim();
  return `${base || "document"}.${ext}`;
}
