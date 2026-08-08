// Job-sheet types, the default Folkpaths expense catalogue, and the totals math.

export type Booking = {
  name: string;
  bookingNo: string;
  bookedPax: number | null;
  actualPax: number | null;
  tickets: "included" | "not" | ""; // hybrid: some bookings include tickets, some don't
  status: string; // "no-show" (all absent) | "partial" (some absent) | "" (all came)
  noShowPax?: number; // how many of this booking didn't arrive (0..bookedPax)
};

// The no-show status label for a booking of `pax` guests with `noShowPax` absent.
export function noShowStatus(noShowPax: number, pax: number | null): "no-show" | "partial" | "" {
  const p = Math.max(0, Math.floor(noShowPax || 0));
  if (p <= 0) return "";
  return pax != null && p < pax ? "partial" : "no-show";
}
// An operational expense line on a job sheet. `description/price/pax` are the billed
// reimbursement (amount = price × pax, see expenseAmount). The rest are OPTIONAL
// finance metadata — additive and fully back-compatible with old rows that carry
// only the first three. None of them change the payout math: computeTotals still
// bills price × pax. `unit` is display-only (คน/เที่ยว/ครั้ง); the accounting fields
// (operational category, who paid, whether the guide is reimbursed, estimate vs
// actual, a supporting receipt, a note) feed the later PEAK-sync flow.
export type ExpenseType = "guide_fee" | "entrance" | "transport" | "meal" | "other";
export type Expense = {
  description: string;
  price: number | null;
  pax: number | null;
  unit?: string;
  expenseType?: ExpenseType | string; // operational category (mapped to a PEAK account in the backend, not here)
  paidBy?: string; // "guide" | "operator" | "company"
  reimbursementRequired?: boolean;
  estimatedAmount?: number | null;
  actualAmount?: number | null;
  receiptUrl?: string | null; // Drive link to the supporting receipt (login-gated, not a signed URL)
  receiptFileId?: string | null; // Drive file id — for replace-in-place / audit
  receiptName?: string; // original filename
  receiptAt?: string; // ISO timestamp the receipt was attached
  receiptBy?: string; // User.id who attached it
  notes?: string;
};
export type GuideFee = { price: number | null; time: number | null; whtPct: number | null };

// The standard items that appear on every new sheet (prices editable per job).
export const DEFAULT_EXPENSES: Expense[] = [
  { description: "Water (Inc. Guide)", price: 10, pax: null },
  { description: "Ferry (Inc. Guide)", price: null, pax: null, unit: "เที่ยว" },
  { description: "Grand Palace", price: 500, pax: null },
  { description: "Wat Pho", price: 300, pax: null },
  { description: "Wat Arun", price: 200, pax: null },
  { description: "Lotus (Inc. Guide)", price: 10, pax: null },
  { description: "Bus (Inc. Guide)", price: 15, pax: null },
];
export const DEFAULT_GUIDE_FEE: GuideFee = { price: 1000, time: 1, whtPct: 3 };

// The lotus offering (dok bua) is only bought on tours that visit Wat Pho & Wat Arun.
// Grand-Palace-only, Wat Pho evening, and food tours never carry a lotus fee.
export function tourHasLotus(tourName?: string | null): boolean {
  const nm = (tourName ?? "").toLowerCase();
  return nm.includes("wat pho") && nm.includes("wat arun");
}

// The standard expense catalogue for a specific tour — drops the Lotus line when the
// tour doesn't visit Wat Pho & Wat Arun.
export function defaultExpensesForTour(tourName?: string | null): Expense[] {
  return tourHasLotus(tourName) ? DEFAULT_EXPENSES : DEFAULT_EXPENSES.filter((e) => !/lotus/i.test(e.description));
}

// Fill every expense line's pax from a single guest count — "(Inc. Guide)" lines
// get +1 (the guide joins). The operator triggers this on the sheet ("fill down");
// expense pax is NOT auto-filled on generation, so the column starts blank until
// they do this — keeping the operator in control of the ticket/inclusive counts.
export function fillDownExpensePax(expenses: Expense[], guests: number): Expense[] {
  const g = Math.max(0, Math.floor(guests || 0));
  return (expenses ?? []).map((e) => ({ ...e, pax: /inc\.?\s*guide/i.test(e.description) ? g + 1 : g }));
}

const n = (v: number | null | undefined) => (typeof v === "number" && isFinite(v) ? v : 0);

export function expenseAmount(e: Expense): number {
  return n(e.price) * n(e.pax);
}

// A "Review reward" expense line — the guide's reward for reviews, entered as a
// normal expense (rate × count, e.g. 2 × ฿50) but surfaced on its own line on the
// job sheet and the guide's Pay so they can see what a review earned them.
export function isReviewExpense(e: { description?: string | null }): boolean {
  return (e.description || "").trim().toLowerCase().startsWith("review");
}
export function reviewRewardTotal(expenses: Expense[]): number {
  return (expenses ?? []).filter(isReviewExpense).reduce((s, e) => s + expenseAmount(e), 0);
}

export function computeTotals(expenses: Expense[], guideFee: GuideFee) {
  const totalExpenses = (expenses ?? []).reduce((s, e) => s + expenseAmount(e), 0);
  const gross = n(guideFee?.price) * n(guideFee?.time);
  const wht = gross * (n(guideFee?.whtPct) / 100);
  const netGuideFee = gross - wht;
  const grandTotal = totalExpenses + netGuideFee;
  return { totalExpenses, gross, wht, netGuideFee, grandTotal };
}

export const thb = (v: number) =>
  `฿${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// FOLK-BKK-YYYYMMDD-NN  (NN = nth sheet for that tour date)
export function makeRef(date: string, seq: number) {
  return `FOLK-BKK-${date.replace(/-/g, "")}-${String(seq).padStart(2, "0")}`;
}

// ── Finance approval ─────────────────────────────────────────────────────────
// A job sheet's operator sign-off state. Deliberately minimal for now: a sheet is
// either unapproved (null) or APPROVED. The lifecycle can grow later (DRAFT →
// READY_FOR_REVIEW → APPROVED → SYNCED_TO_PEAK) without changing existing callers.
// Approval is the gate a later PEAK sync will require; it never moves money itself.
export type ApprovalStatus = "APPROVED" | null;
export const isApproved = (status?: string | null): boolean => status === "APPROVED";
// Pure, reversible toggle so an accidental approval can be undone before payout.
export function toggleApproval(current?: string | null): ApprovalStatus {
  return isApproved(current) ? null : "APPROVED";
}

// Drive file name for an expense receipt. Unique per expense row (ref + E<n>) so a
// re-upload replaces only that row's receipt and never another's. The description is
// sanitised (Drive/query-safe) and clipped; falls back to guideId-date when a sheet
// has no ref yet.
export function receiptDriveName(opts: { ref?: string | null; guideId: string; date: string; index: number; description?: string | null; ext: string }): string {
  const base = (opts.ref || `${opts.guideId}-${opts.date}`).trim();
  const desc = (opts.description || "").replace(/[\\/'"\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  return `${base}-E${opts.index + 1}${desc ? ` ${desc}` : ""} — receipt.${opts.ext}`;
}

// Apply a guide's reported attendance to a job sheet: remove `absent` guests
// (no-show + left-early) from the booking rows — taking them from the largest
// groups first — then re-sync the attraction (Grand Palace / Wat Pho / Wat Arun)
// ticket expenses to who actually showed up. The fixed guide fee is untouched.
const ATTRACTION_PREFIXES = ["grand palace", "wat pho", "wat arun"];

// Re-sync the attraction (Grand Palace / Wat Pho / Wat Arun) ticket expenses to the
// number of ticket-included guests who actually showed up (sum of actualPax).
export function syncAttractionTickets(bookings: Booking[], expenses: Expense[]): Expense[] {
  const inclPax = bookings.reduce((s, b) => s + (b.tickets === "included" ? (b.actualPax ?? 0) : 0), 0);
  return expenses.map((e) =>
    ATTRACTION_PREFIXES.some((a) => (e.description ?? "").trim().toLowerCase().startsWith(a)) ? { ...e, pax: inclPax } : e,
  );
}

export function applyReportedAttendance(bookings: Booking[], expenses: Expense[], absent: number): { bookings: Booking[]; expenses: Expense[] } {
  const rows = bookings.map((b) => ({ ...b, actualPax: b.actualPax ?? b.bookedPax ?? 0 }));
  let remaining = Math.max(0, Math.floor(absent));
  while (remaining > 0) {
    let idx = -1, max = 0;
    rows.forEach((b, i) => { const p = b.actualPax ?? 0; if (p > max) { max = p; idx = i; } });
    if (idx < 0) break; // nobody left to remove
    rows[idx].actualPax = (rows[idx].actualPax ?? 0) - 1;
    remaining--;
  }
  return { bookings: rows, expenses: syncAttractionTickets(rows, expenses) };
}
