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
  // Tax presentation for the accounting export. Tour expenses are NOT taxed like the
  // guide fee: these are display/mapping metadata that deliberately feed NO total —
  // computeTotals still bills price × pax, and the guide fee's WHT stays in GuideFee.
  // Unset reads as "No VAT" / "No WHT", which is the case for every row today.
  vat?: string; // "none" | "vat7"
  wht?: string; // "none" | "wht3"
  // PEAK account mapping. Resolved from the CATEGORY through configuration and
  // recorded here once chosen, so a posted row keeps the account it was booked to
  // even if the category→account map is later re-pointed. Never inferred from the
  // description. See lib/peak-sync for the status rules.
  peakAccountCode?: string | null;
  peakAccountId?: string | null;
  peakAccountName?: string | null;
  mappingStatus?: string; // "READY" | "NEEDS_REVIEW" | "UNMAPPED" — derived; stored only when an operator overrides
  // Duplicate protection for company-direct costs that already reached PEAK by
  // their own supplier invoice or receipt. Such a row stays in this job's cost
  // reporting but is excluded from the expense payload, so it is never booked twice.
  sourceDocumentType?: string; // "JOB_SHEET" | "SUPPLIER_INVOICE" | "RECEIPT" | "OTHER"
  sourceDocumentNo?: string;
  peakExistingDocumentId?: string | null;
  alreadyRecordedInPeak?: boolean;
  // Review-reward rows only: the BOOKING the review came from (GYG ref etc.).
  // Empty = a guest of this job; a booking no. on this sheet's guest list =
  // earned here; any other booking no. = reward earned on an earlier job,
  // merely PAID OUT with this one and never a cost of it.
  relatedBookingNo?: string;
  relatedJobRef?: string; // legacy job-ref form, still honoured when present
};
export type GuideFee = { price: number | null; time: number | null; whtPct: number | null };

// The standard items that appear on every new sheet (prices editable per job).
// Categories are set HERE, at the source, because these are known company items —
// never inferred from the description at read time (see expenseCategory).
export const DEFAULT_EXPENSES: Expense[] = [
  { description: "Water (Inc. Guide)", price: 10, pax: null, expenseType: "meal" },
  { description: "Ferry (Inc. Guide)", price: null, pax: null, unit: "เที่ยว", expenseType: "transport" },
  { description: "Grand Palace", price: 500, pax: null, expenseType: "entrance" },
  { description: "Wat Pho", price: 300, pax: null, expenseType: "entrance" },
  { description: "Wat Arun", price: 200, pax: null, expenseType: "entrance" },
  { description: "Lotus (Inc. Guide)", price: 10, pax: null, expenseType: "other" },
  { description: "Bus (Inc. Guide)", price: 15, pax: null, expenseType: "transport" },
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
  // Review-reward rows are guide compensation, not per-guest tour costs — a
  // guest count must never overwrite their quantity.
  return (expenses ?? []).map((e) => (isReviewExpense(e) ? e : { ...e, pax: /inc\.?\s*guide/i.test(e.description) ? g + 1 : g }));
}

const n = (v: number | null | undefined) => (typeof v === "number" && isFinite(v) ? v : 0);

export function expenseAmount(e: Expense): number {
  return n(e.price) * n(e.pax);
}

// A "Review reward" expense line — the guide's reward for reviews, entered as a
// normal expense (rate × count, e.g. 2 × ฿50) but surfaced on its own line on the
// job sheet and the guide's Pay so they can see what a review earned them.
export function isReviewExpense(e: { description?: string | null }): boolean {
  const d = (e.description || "").trim().toLowerCase();
  // Thai counts too. Operators work in both languages, and a row typed
  // "ค่ารีวิว" used to fall through as an ordinary tour expense — booked to
  // ต้นทุนการให้บริการ instead of ค่ารีวิวลูกค้า, and left out of the guide's
  // reward. A silent misclassification of someone's pay is not an acceptable
  // outcome for choosing the wrong keyboard.
  return d.startsWith("review") || d.includes("รีวิว");
}
// What the GUIDE is shown they will receive.
//
// Two rules this exists to hold together:
//   * Tour expenses come from whichever list is authoritative right now — the
//     guide's own report while it is open, the operator's record once it is not.
//   * The review reward ALWAYS comes from the operator's record and is added
//     once. It is compensation the operator awards, not something a guide reports,
//     so it must not disappear when the guide files a report that has no review
//     lines in it — and must not be counted twice when their report was seeded
//     from the operator's rows, which already contained them.
export type GuidePayoutView = { tourExpenses: number; reviewReward: number; total: number };

export function guidePayoutView(args: {
  operatorExpenses: Expense[];
  reportedExpenses: Expense[];
  netGuideFee: number;
  /** true while the guide's own report is the live figure (tour done, not yet paid) */
  useReported: boolean;
}): GuidePayoutView {
  const tourOnly = (rows: Expense[]) =>
    (rows ?? []).filter((e) => !isReviewExpense(e)).reduce((sum, e) => sum + expenseAmount(e), 0);
  const tourExpenses = tourOnly(args.useReported ? args.reportedExpenses : args.operatorExpenses);
  const reviewReward = reviewRewardTotal(args.operatorExpenses);
  return { tourExpenses, reviewReward, total: args.netGuideFee + tourExpenses + reviewReward };
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

// A booking's true no-show pax: the recorded per-booking count when present,
// else the booked−actual difference (covers rows where only Actual Pax was
// zeroed), else the legacy whole-booking "no-show" status.
export function bookingNoShowPax(b: Booking): number {
  if (typeof b.noShowPax === "number") return Math.max(0, Math.floor(b.noShowPax));
  if (b.bookedPax != null && b.actualPax != null) return Math.max(0, b.bookedPax - b.actualPax);
  return b.status === "no-show" ? (b.bookedPax ?? 0) : 0;
}
// No-show PAX (จำนวนผู้เดินทางที่ไม่มาใช้บริการ) and no-show BOOKINGS (จำนวนการจอง
// ที่ไม่มาใช้บริการ) are different units — a 13-booked/8-came job is 5 pax across
// maybe 2 fully-absent bookings. Never display one number as the other.
// Owner rule: a "no-show" is a booking that did not come AT ALL — pax counts the
// BOOKED pax of fully-absent bookings only. Partial reductions (2 booked → 1 came)
// are guests leaving early / trimming, not no-shows, and stay out of both numbers.
export function noShowStats(bookings: Booking[]): { pax: number; bookings: number } {
  let pax = 0, count = 0;
  for (const b of bookings ?? []) {
    const booked = b.bookedPax ?? 0;
    if (booked <= 0) continue;
    const fullyAbsent = b.actualPax === 0 || bookingNoShowPax(b) >= booked;
    if (fullyAbsent) { pax += booked; count++; }
  }
  return { pax, bookings: count };
}

// Tour OPERATING expenses = the expense rows minus Review-reward lines. Review
// Reward is guide compensation (shown with the Guide Fee on documents), not an
// operating cost — but it stays an expense row in the data, stays reimbursed in
// the payout, stays OUT of the WHT base, and still posts to the PEAK expenses
// account: this split is presentation only.
export function tourOperatingExpenses(expenses: Expense[]): number {
  return (expenses ?? []).reduce((s, e) => s + (isReviewExpense(e) ? 0 : expenseAmount(e)), 0);
}

// ── Accounting presentation (Job Sheet / PDF / Drive) ────────────────────────
// Total Job Expenses = actual tour expenses + GROSS guide fee. WHT reduces the
// cash paid to the guide (Net Payable), never the gross fee expense — so this is
// deliberately NOT computeTotals().grandTotal (which is the guide-payout figure:
// expenses + NET fee, used by Payments and left untouched).
export function totalJobExpenses(t: { totalExpenses: number; gross: number }): number {
  return t.totalExpenses + t.gross;
}

// A review reward belongs to THIS job when its related booking is one of this
// job's own guests (booking-no.-first: a review comes from a guest, the guest's
// booking pins the job — no hand-typed job refs to get wrong). Blank = earned
// here. Legacy rows carrying relatedJobRef are honoured by ref comparison.
export function reviewBelongsToJob(e: Expense, jobRef?: string | null, bookings?: Booking[]): boolean {
  const norm = (x?: string | null) => (x ?? "").trim().toLowerCase();
  const bookingNo = norm(e.relatedBookingNo);
  if (bookingNo) return (bookings ?? []).some((b) => norm(b.bookingNo) === bookingNo);
  const rel = norm(e.relatedJobRef);
  return !rel || rel === norm(jobRef);
}

// The document's cost figures. Tour Expenses are operating rows only; a review
// reward counts as this job's cost ONLY when it belongs here — a reward carried
// over from another job increases the transfer to the guide, never this job's
// expenses.
export function jobCostBreakdown(expenses: Expense[], guideFee: GuideFee, jobRef?: string | null, bookings?: Booking[]) {
  const t = computeTotals(expenses, guideFee);
  const reviews = (expenses ?? []).filter(isReviewExpense);
  const reviewOwn = reviews.filter((e) => reviewBelongsToJob(e, jobRef, bookings)).reduce((s, e) => s + expenseAmount(e), 0);
  const reviewOther = reviews.filter((e) => !reviewBelongsToJob(e, jobRef, bookings)).reduce((s, e) => s + expenseAmount(e), 0);
  const tourExpenses = tourOperatingExpenses(expenses);
  return { ...t, tourExpenses, reviewOwn, reviewOther, jobExpenses: tourExpenses + reviewOwn + t.gross };
}
// ── Tour-expense categories (accounting mapping) ─────────────────────────────
// The STORED key is Expense.expenseType — the short keys this app has always
// written. They stay the storage format, so no existing sheet needs migrating.
// `code` is the stable accounting identifier the business/spec uses when talking
// about a category outside the app; `label` is display only.
//
// Rule: an expense is mapped to an account by its CATEGORY KEY, never by its
// description. Descriptions are free text an operator retypes per job — using one
// as an accounting key silently misfiles the expense the first time it changes.
//
// All four categories are expected to land on the same PEAK account group
// (ต้นทุนการให้บริการ), but they stay separate here for operational reporting.
// No PEAK account code is hard-coded: there is no account-mapping mechanism yet,
// and inventing one now would be a guess (see PEAK_SERVICE_COST_LABEL).
export type ExpenseCategoryKey = "entrance" | "transport" | "meal" | "other";
export const EXPENSE_CATEGORIES = [
  { key: "entrance", code: "ENTRANCE_TICKET", label: "Entrance Ticket", th: "ค่าบัตรเข้าชม" },
  { key: "transport", code: "TRANSPORTATION", label: "Transportation", th: "ค่าพาหนะ" },
  { key: "meal", code: "MEAL_REFRESHMENT", label: "Meal / Refreshment", th: "ค่าอาหารและเครื่องดื่ม" },
  { key: "other", code: "OTHER_TOUR_COST", label: "Other Tour Cost", th: "ค่าใช้จ่ายอื่นในการนำเที่ยว" },
] as const;
// The PEAK account group these categories are expected to map to. A LABEL, not a
// code — displayed so the accountant can confirm the intent; nothing posts on it.
export const PEAK_SERVICE_COST_LABEL = "ต้นทุนการให้บริการ";

// Resolve a stored expenseType to a category key. Accepts the short storage key
// and the canonical CODE form, so a row written either way reads back the same.
// Returns null when the row has never been categorised — which is "needs review",
// never a silent default.
export function expenseCategory(e: Pick<Expense, "expenseType">): ExpenseCategoryKey | null {
  const raw = (e.expenseType ?? "").trim().toLowerCase();
  if (!raw) return null;
  const hit = EXPENSE_CATEGORIES.find((c) => c.key === raw || c.code.toLowerCase() === raw);
  return hit ? (hit.key as ExpenseCategoryKey) : null;
}
export function expenseCategoryLabel(e: Pick<Expense, "expenseType">): string {
  const k = expenseCategory(e);
  return EXPENSE_CATEGORIES.find((c) => c.key === k)?.label ?? "Uncategorised";
}

// Is this row's category settled enough to go to accounting unattended?
// OTHER_TOUR_COST is deliberately NOT auto-approved (it is the catch-all — what
// belongs in it can only be decided per job), and neither is an untagged row.
export type ExpenseAccountingStatus = "READY" | "REVIEW";
export function expenseAccountingStatus(e: Pick<Expense, "expenseType">): ExpenseAccountingStatus {
  const k = expenseCategory(e);
  return k && k !== "other" ? "READY" : "REVIEW";
}
// Sheet-level readiness: every tour-expense row carrying an amount is READY.
// Review-reward rows are guide compensation, not tour cost — they are not counted.
// A sheet with no billed expense rows is not "ready", it is simply empty.
export function tourExpenseAccountingReady(expenses: Expense[]): boolean {
  const rows = (expenses ?? []).filter((e) => !isReviewExpense(e) && expenseAmount(e) > 0);
  return rows.length > 0 && rows.every((e) => expenseAccountingStatus(e) === "READY");
}

// Expenses the guide paid with PERSONAL money — the only category that can
// create a reimbursement due to the guide (advance-paid rows were company money
// already in the guide's hands and must never be reimbursed twice).
export function guidePersonalTotal(expenses: Expense[]): number {
  return (expenses ?? []).filter((e) => e.paidBy === "guide").reduce((s, e) => s + expenseAmount(e), 0);
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
