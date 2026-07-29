// K BIZ (KBank) transfer-slip parser.
//
// Pure, dependency-free: turns the *already-extracted* text of a K BIZ slip into
// structured payment fields. Text extraction (PDF-text vs OCR) happens upstream;
// this module only parses. Kept side-effect-free so it is trivially unit-tested
// against the sample fixture and reused by both the live upload flow and the
// historical importer.
//
// Money is returned as a STRING exactly as printed (e.g. "1695.00") so no float
// rounding is introduced before it reaches the Decimal column. Timestamps are
// returned as ISO-8601 with the fixed Asia/Bangkok offset (+07:00 — Thailand has
// had no DST since 1988), so "11/04/2026" is unambiguously 11 April 2026.

export type PaymentReferenceType =
  | "JOB_NO"
  | "PAYOUT_ITEM_NO"
  | "PAYMENT_BATCH_NO"
  | "PEAK_EXPENSE_NO"
  | "OTHER"
  | "NOT_FOUND";

export type KBizSlip = {
  transactionId: string | null;
  transactionStatus: string | null;
  /** true only when the slip clearly indicates a completed/successful transfer. */
  isCompleted: boolean;
  transactionChannel: string | null;

  /** Original "DD/MM/YYYY HH:mm" text, preserved for audit. */
  transactionDateRaw: string | null;
  /** ISO-8601 with +07:00, derived from the Transaction Date. THE authoritative paid_at. */
  paidAt: string | null;
  deductedAt: string | null;
  receivedAt: string | null;

  senderName: string | null;
  senderBank: string | null;
  recipientName: string | null;
  recipientBank: string | null;

  /** Strings, exactly as printed — never parsed to float. */
  transferAmount: string | null;
  transferFee: string | null;
  totalAmount: string | null;
  currency: string; // defaults to THB; only overridden when the slip states another

  /** Memo exactly as printed — never mutated. */
  paymentMemoRaw: string | null;
  /** Uppercased, whitespace/hyphen-normalized copy — for matching only. */
  paymentMemoNormalized: string | null;
  paymentReferenceType: PaymentReferenceType;
  paymentReferenceValue: string | null;

  detectedBank: string; // "KBANK" for K BIZ
};

// ---- reference patterns -----------------------------------------------------
// Job No.        FOLK-BKK-YYYYMMDD-NN
// Payout item    FP-PAY-YYYYMMDD-<GUIDEID>
// Payment batch  FP-BATCH-YYYYMMDD-NNN
// PEAK expense   EXP-YYYYMM-NNNNN
const RE_JOB_NO = /\bFOLK-BKK-\d{8}-\d{2,}\b/i;
const RE_PAYOUT_ITEM = /\bFP-PAY-\d{8}-[A-Z]?-?\d{1,}\b/i;
const RE_PAYMENT_BATCH = /\bFP-BATCH-\d{8}-\d{1,}\b/i;
const RE_PEAK_EXPENSE = /\bEXP-\d{6}-\d{1,}\b/i;

/** Trim, collapse whitespace, tidy spaces around hyphens, uppercase. Never stored over the raw memo. */
export function normalizeMemo(memo: string): string {
  return memo
    .replace(/[ ​　\s]+/g, " ") // nbsp / zero-width / ideographic / normal ws → single space
    .replace(/\s*-\s*/g, "-") // "FOLK - BKK" -> "FOLK-BKK"
    .trim()
    .toUpperCase();
}

/** Classify a memo into a reference type + the exact matched value. Priority: Job -> Payout -> Batch -> PEAK. */
export function classifyReference(memo: string | null | undefined): {
  type: PaymentReferenceType;
  value: string | null;
} {
  if (!memo || !memo.trim()) return { type: "NOT_FOUND", value: null };
  const norm = normalizeMemo(memo);
  let m: RegExpMatchArray | null;
  if ((m = norm.match(RE_JOB_NO))) return { type: "JOB_NO", value: m[0] };
  if ((m = norm.match(RE_PAYOUT_ITEM))) return { type: "PAYOUT_ITEM_NO", value: m[0] };
  if ((m = norm.match(RE_PAYMENT_BATCH))) return { type: "PAYMENT_BATCH_NO", value: m[0] };
  if ((m = norm.match(RE_PEAK_EXPENSE))) return { type: "PEAK_EXPENSE_NO", value: m[0] };
  return { type: "OTHER", value: memo.trim() };
}

// ---- date parsing -----------------------------------------------------------
/**
 * "DD/MM/YYYY HH:mm[:ss]" (Thai day-first) -> ISO-8601 at +07:00.
 * Returns null on anything that doesn't parse or is out of range. Never guesses
 * MM/DD — K BIZ prints day first, so 11/04/2026 is 11 April 2026.
 */
export function kbizDateToIso(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.trim().match(/\b(\d{2})\/(\d{2})\/(\d{4})(?:[ T]+(\d{2}):(\d{2})(?::(\d{2}))?)?\b/);
  if (!m) return null;
  const dd = +m[1], mm = +m[2], yyyy = +m[3];
  const HH = m[4] != null ? +m[4] : 0;
  const MIN = m[5] != null ? +m[5] : 0;
  const SS = m[6] != null ? +m[6] : 0;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || HH > 23 || MIN > 59 || SS > 59) return null;
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${yyyy}-${p2(mm)}-${p2(dd)}T${p2(HH)}:${p2(MIN)}:${p2(SS)}+07:00`;
}

// ---- field extraction -------------------------------------------------------
// Match "Label: value" (or "Label value") on a line. Bilingual: English labels
// from the documented sample + common Thai aliases, best-effort.
function field(text: string, labels: string[]): string | null {
  for (const label of labels) {
    const re = new RegExp(`(?:^|\\n)\\s*${label}\\s*[:：]?\\s*(.+?)\\s*(?:\\n|$)`, "i");
    const m = text.match(re);
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

/** Extract a printed amount as a normalized decimal string ("1,695.00" -> "1695.00"). */
function amount(text: string, labels: string[]): string | null {
  const v = field(text, labels);
  if (v == null) return null;
  const m = v.replace(/[^0-9.,]/g, "").match(/\d[\d,]*(?:\.\d+)?/);
  if (!m) return null;
  return m[0].replace(/,/g, "");
}

export function parseKBizSlip(rawText: string): KBizSlip {
  const text = (rawText ?? "").replace(/\r\n?/g, "\n");

  const transactionStatus = field(text, ["Transfer Status", "Transaction Status"]);
  const isCompleted = /\b(completed|success|successful)\b/i.test(transactionStatus ?? "");

  const transactionDateRaw = field(text, ["Transaction Date", "Transfer Date"]);
  const deductedRaw = field(text, ["Deducted Date", "Debited Date"]);
  const receivedRaw = field(text, ["Received Date"]);

  const memoRaw = field(text, ["Memo", "Note", "Reference"]);
  const ref = classifyReference(memoRaw);

  const currencyField = field(text, ["Currency"]);
  const currency = currencyField && /^[A-Za-z]{3}$/.test(currencyField.trim()) ? currencyField.trim().toUpperCase() : "THB";

  return {
    transactionId: field(text, ["Transaction ID", "Transaction No", "Reference No"]),
    transactionStatus,
    isCompleted,
    transactionChannel: field(text, ["Transaction Channel", "Channel"]),

    transactionDateRaw,
    paidAt: kbizDateToIso(transactionDateRaw),
    deductedAt: kbizDateToIso(deductedRaw),
    receivedAt: kbizDateToIso(receivedRaw),

    senderName: field(text, ["Sender", "From"]),
    senderBank: field(text, ["Sender Bank", "From Bank"]),
    recipientName: field(text, ["Recipient", "To"]),
    recipientBank: field(text, ["Recipient Bank", "To Bank"]),

    transferAmount: amount(text, ["Transfer Amount", "Amount"]),
    transferFee: amount(text, ["Transfer Fee", "Fee"]),
    totalAmount: amount(text, ["Total Amount", "Total"]),
    currency,

    paymentMemoRaw: memoRaw,
    paymentMemoNormalized: memoRaw ? normalizeMemo(memoRaw) : null,
    paymentReferenceType: ref.type,
    paymentReferenceValue: ref.value,

    detectedBank: "KBANK",
  };
}
