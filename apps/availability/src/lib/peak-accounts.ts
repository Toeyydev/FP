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

// Where a category's PEAK account is decided.
//
//  FIXED    — chosen once on the Account chart mapping page and reused by every
//             future job sheet. The operator never picks it again.
//  PER_JOB  — cannot have a standing account at all. OTHER_TOUR_COST is the
//             catch-all: a temple offering, flowers, a one-off local fee and a
//             miscellaneous guest item can each belong to a different account, so
//             a single default would silently misfile most of them. The account is
//             chosen on the expense row that actually uses it.
//
// This is internal vocabulary — the UI never says "scope", "global" or "per-job"
// mapping. It says "choose once here" or "choose on the Job Sheet".
export type MappingScope = "FIXED" | "PER_JOB";

export type CategorySpec = {
  key: AccountingCategory;
  label: string;
  th: string;
  example: string;
  scope: MappingScope;
  note?: string;
};

export const ACCOUNTING_CATEGORIES: CategorySpec[] = [
  { key: "GUIDE_FEE", label: "Guide Fee", th: "ค่าจ้างมัคคุเทศก์", example: "Guide service fee", scope: "FIXED" },
  { key: "ENTRANCE_TICKET", label: "Entrance Ticket", th: "ค่าบัตรเข้าชม", example: "Admission ticket, temple entry", scope: "FIXED" },
  { key: "TRANSPORTATION", label: "Transportation", th: "ค่าพาหนะ", example: "Boat, Ferry, Taxi, Grab, BTS, MRT, Bus", scope: "FIXED" },
  { key: "MEAL_REFRESHMENT", label: "Meal / Refreshment", th: "ค่าอาหารและเครื่องดื่ม", example: "Drinking water, guest snack, food", scope: "FIXED" },
  { key: "OTHER_TOUR_COST", label: "Other Tour Cost", th: "ค่าใช้จ่ายอื่นในการนำเที่ยว", example: "Anything not covered above", scope: "PER_JOB",
    note: "Select the PEAK account on the Job Sheet when this category is used." },
  // Consistently additional compensation to the guide, so it takes a standing
  // account like any other fixed category — asking per job created repetitive
  // accounting work for an answer that never changes.
  { key: "REVIEW_REWARD", label: "Review Reward / Additional Guide Payment", th: "ค่าตอบแทนรีวิว", example: "Reward paid to the guide for a guest review", scope: "FIXED" },
];

// The categories that gate accountChartReady: every FIXED one. OTHER_TOUR_COST is
// excluded by definition — it is resolved per job, so it can never be "missing".
export const FIXED_CATEGORIES: AccountingCategory[] =
  ACCOUNTING_CATEGORIES.filter((c) => c.scope === "FIXED").map((c) => c.key);

export const isPerJobCategory = (key: AccountingCategory): boolean =>
  ACCOUNTING_CATEGORIES.find((c) => c.key === key)?.scope === "PER_JOB";

// Whether this category may be given a standing account on the settings page.
export const canMapGlobally = (key: string): boolean =>
  isAccountingCategory(key) && !isPerJobCategory(key);

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

export type CategoryStatus = "MAPPED" | "NOT_MAPPED" | "REVIEW_PER_JOB";

export function categoryStatus(key: AccountingCategory, m?: AccountMapping | null): CategoryStatus {
  // A per-job category is never "not mapped" — there is nothing to map here, and
  // showing it as missing would read as a configuration error the operator can fix.
  if (isPerJobCategory(key)) return "REVIEW_PER_JOB";
  return isMapped(m) ? "MAPPED" : "NOT_MAPPED";
}

// The chart is configured when every FIXED category carries an account code.
// OTHER_TOUR_COST never blocks it — it is resolved on the job sheet by design.
export function accountChartReady(mappings: AccountMapping[]): boolean {
  return missingRequired(mappings).length === 0;
}

// Which fixed categories still need an account — the operator's to-do list, and
// what the "N mappings remaining" count is drawn from.
export function missingRequired(mappings: AccountMapping[]): AccountingCategory[] {
  const byKey = new Map(mappings.map((m) => [m.folkopsCategory, m]));
  return FIXED_CATEGORIES.filter((k) => !isMapped(byKey.get(k)));
}

// Human label for a category key, for blocking messages ("Transportation has no
// PEAK account mapping") rather than raw keys.
export const categoryLabel = (key: string): string =>
  ACCOUNTING_CATEGORIES.find((c) => c.key === key)?.label ?? key;

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
