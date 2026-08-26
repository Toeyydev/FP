// Account chart mapping: which PEAK account each FolkOPS category books to.
//
// Pure and storage-agnostic — the rules live here, the rows live in the
// PeakAccountMapping table. No PEAK call, no posting.
//
// The central rule: a category is mapped by an operator CHOOSING a PEAK account,
// never by this code inferring one from an account's name. Several categories are
// expected to land on the same account (ต้นทุนการให้บริการ) but they stay separate
// keys so operational reporting can still tell a boat fare from a temple ticket.

export type AccountingCategory =
  | "GUIDE_FEE"
  | "ENTRANCE_TICKET"
  | "TRANSPORTATION"
  | "MEAL_REFRESHMENT"
  | "OTHER_TOUR_COST"
  | "REVIEW_REWARD";

export type CategorySpec = {
  key: AccountingCategory;
  label: string;
  th: string;
  example: string;
  // Required = must be mapped before the chart counts as configured. The two
  // non-required ones are deliberate, not oversights:
  //  · OTHER_TOUR_COST is the catch-all — what belongs in it can only be decided
  //    per job, so it must never be auto-approved into an account.
  //  · REVIEW_REWARD is guide compensation, not a tour cost, and its accounting
  //    treatment has not been decided yet.
  required: boolean;
  note?: string;
};

export const ACCOUNTING_CATEGORIES: CategorySpec[] = [
  { key: "GUIDE_FEE", label: "Guide Fee", th: "ค่าจ้างมัคคุเทศก์", example: "Guide service fee", required: true },
  { key: "ENTRANCE_TICKET", label: "Entrance Ticket", th: "ค่าบัตรเข้าชม", example: "Admission ticket, temple entry", required: true },
  { key: "TRANSPORTATION", label: "Transportation", th: "ค่าพาหนะ", example: "Boat, Ferry, Taxi, Grab, BTS, MRT, Bus", required: true },
  { key: "MEAL_REFRESHMENT", label: "Meal / Refreshment", th: "ค่าอาหารและเครื่องดื่ม", example: "Drinking water, guest snack, food", required: true },
  { key: "OTHER_TOUR_COST", label: "Other Tour Cost", th: "ค่าใช้จ่ายอื่นในการนำเที่ยว", example: "Anything not covered above", required: false,
    note: "Other expenses may belong to different accounting accounts — an operator must choose per job." },
  { key: "REVIEW_REWARD", label: "Review Reward / Additional Guide Payment", th: "ค่าตอบแทนรีวิว", example: "Reward paid to the guide for a guest review", required: false,
    note: "Guide compensation, not a tour cost. Its accounting treatment is still to be decided." },
];

// The four that gate accountChartReady.
export const REQUIRED_CATEGORIES: AccountingCategory[] =
  ACCOUNTING_CATEGORIES.filter((c) => c.required).map((c) => c.key);

export const isAccountingCategory = (v: string): v is AccountingCategory =>
  ACCOUNTING_CATEGORIES.some((c) => c.key === v);

export type AccountMapping = {
  folkopsCategory: string;
  peakAccountCode: string | null;
  peakAccountName: string | null;
  isActive?: boolean;
};

// A mapping only counts when it carries a real account CODE. A name alone is a
// label someone typed; the code is what PEAK books against.
export function isMapped(m?: AccountMapping | null): boolean {
  return !!(m && m.isActive !== false && (m.peakAccountCode ?? "").trim());
}

export type CategoryStatus = "MAPPED" | "NEEDS_REVIEW" | "NOT_MAPPED";

export function categoryStatus(key: AccountingCategory, m?: AccountMapping | null): CategoryStatus {
  if (isMapped(m)) return "MAPPED";
  // The two optional categories are not "missing" — they are awaiting a human
  // decision, which is a different thing and should read differently.
  const spec = ACCOUNTING_CATEGORIES.find((c) => c.key === key);
  return spec && !spec.required ? "NEEDS_REVIEW" : "NOT_MAPPED";
}

// The chart is ready when the four REQUIRED categories carry an account code.
// OTHER_TOUR_COST and REVIEW_REWARD never block it — by design (see CategorySpec).
export function accountChartReady(mappings: AccountMapping[]): boolean {
  const byKey = new Map(mappings.map((m) => [m.folkopsCategory, m]));
  return REQUIRED_CATEGORIES.every((k) => isMapped(byKey.get(k)));
}

// Which required categories still need an account — the operator's to-do list.
export function missingRequired(mappings: AccountMapping[]): AccountingCategory[] {
  const byKey = new Map(mappings.map((m) => [m.folkopsCategory, m]));
  return REQUIRED_CATEGORIES.filter((k) => !isMapped(byKey.get(k)));
}

// ── Job-sheet bridge ─────────────────────────────────────────────────────────
// The job sheet stores its own short expenseType keys ("entrance", "transport",
// "meal", "other"). Map those to accounting categories by KEY — never by reading
// the row's description, which is free text an operator retypes per job.
const FROM_EXPENSE_TYPE: Record<string, AccountingCategory> = {
  entrance: "ENTRANCE_TICKET",
  transport: "TRANSPORTATION",
  meal: "MEAL_REFRESHMENT",
  other: "OTHER_TOUR_COST",
  guide_fee: "GUIDE_FEE",
};

export function categoryForExpenseType(expenseType?: string | null): AccountingCategory | null {
  const raw = (expenseType ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (FROM_EXPENSE_TYPE[raw]) return FROM_EXPENSE_TYPE[raw];
  const upper = raw.toUpperCase();
  return isAccountingCategory(upper) ? upper : null;
}

// The account a job-sheet expense row would book to, given the saved chart.
// Returns null when the category is unknown or unmapped — never a fallback.
export function accountForExpenseType(
  expenseType: string | null | undefined,
  mappings: AccountMapping[],
): AccountMapping | null {
  const cat = categoryForExpenseType(expenseType);
  if (!cat) return null;
  const m = mappings.find((x) => x.folkopsCategory === cat);
  return isMapped(m) ? m! : null;
}
