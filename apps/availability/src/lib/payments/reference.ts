// Classify a bank-transfer memo into a Folkpaths payment reference.
//
// Pure and side-effect free: no DB, no I/O. The RAW memo is never mutated — callers
// store `raw` in PaymentTransaction.paymentMemoRaw and `normalized` in
// paymentMemoNormalized, and use `type`/`value` for matching. This is the memo half
// of the "bank Transaction ID vs Folkpaths payment reference" separation: the bank
// transaction id is handled elsewhere and is NOT a payment reference.

export type PaymentReferenceType =
  | "JOB_NO" // FOLK-BKK-YYYYMMDD-NN — one individual job sheet
  | "PAYOUT_ITEM_NO" // FP-PAY-YYYYMMDD-Gnnn — one guide's (weekly) payout item
  | "PAYMENT_BATCH_NO" // FP-BATCH-YYYYMMDD-nnn — a K CASH CONNECT PLUS bank batch
  | "PEAK_EXPENSE_NO" // EXP-YYYYMM-nnnnn — a PEAK accounting expense
  | "OTHER" // non-empty memo with no recognised reference
  | "NOT_FOUND"; // empty / no memo

export type ClassifiedReference = {
  raw: string; // exactly as supplied — store in paymentMemoRaw, never overwrite
  normalized: string; // whitespace/case-normalised copy — store in paymentMemoNormalized
  type: PaymentReferenceType;
  value: string | null; // the matched reference; the trimmed text for OTHER; null for NOT_FOUND
};

// One reference per memo in practice; priority resolves the rare ambiguous slip.
const PATTERNS: { type: PaymentReferenceType; re: RegExp }[] = [
  { type: "JOB_NO", re: /\bFOLK-BKK-\d{8}-\d{1,}\b/ },
  { type: "PAYOUT_ITEM_NO", re: /\bFP-PAY-\d{8}-G\d{1,}\b/ },
  { type: "PAYMENT_BATCH_NO", re: /\bFP-BATCH-\d{8}-\d{1,}\b/ },
  { type: "PEAK_EXPENSE_NO", re: /\bEXP-\d{6}-\d{1,}\b/ },
];

// Normalise for matching only. Strips zero-width chars, tidies spaced hyphens
// ("FOLK - BKK" -> "FOLK-BKK"), collapses whitespace, uppercases. Never stored over raw.
export function normalizeMemo(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

export function classifyReference(raw: string | null | undefined): ClassifiedReference {
  const rawStr = raw ?? "";
  const normalized = normalizeMemo(rawStr);
  for (const { type, re } of PATTERNS) {
    const m = normalized.match(re);
    if (m) return { raw: rawStr, normalized, type, value: m[0] };
  }
  if (normalized.length > 0) return { raw: rawStr, normalized, type: "OTHER", value: normalized };
  return { raw: rawStr, normalized, type: "NOT_FOUND", value: null };
}
