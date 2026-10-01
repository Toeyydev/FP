// Which PEAK account an advance-funded cost books to — and the settlement lines that say
// how much. Pure: shared by the manual link check (lib/advances/peak-link) and the dormant
// sender (lib/advances/peak-sync), so the two can never read a settlement differently.
//
// Phase 1E (owner 2026-10-02):
//   * A settlement's explicit `lines` (written by lib/advances/service settleFromExpenses) are
//     the only financial authority. The older `rows` copy is kept for reading, never trusted
//     for an amount, and the job sheet as it is NOW is never re-added.
//   * An advance may fund entrance / meal / transport / other. Each line's category goes
//     through the saved chart (PeakAccountMapping, the same chart the job sheet uses —
//     lib/peak-account-map). No mapping → refused, naming the category. Never a guess.
import { isMapped, type AccountMapping } from "@/lib/peak-accounts";
import { ADVANCE_ELIGIBLE } from "./categories";

/** The job sheet's expense keys → the chart's category codes (also used by lib/peak-account-map). */
export const CATEGORY_CHART_CODE = {
  entrance: "ENTRANCE_TICKET",
  transport: "TRANSPORTATION",
  meal: "MEAL_REFRESHMENT",
  other: "OTHER_TOUR_COST",
} as const;
export type ExpenseCategoryKey = keyof typeof CATEGORY_CHART_CODE;

/** category key → PEAK account code, for the categories the chart has a live code for. */
export function expenseAccountsFrom(mappings: readonly Pick<AccountMapping, "folkopsCategory" | "peakAccountCode" | "isActive">[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, code] of Object.entries(CATEGORY_CHART_CODE)) {
    const m = mappings.find((x) => x.folkopsCategory === code);
    if (m && isMapped(m as AccountMapping)) out[key] = m.peakAccountCode!.trim();
  }
  return out;
}

export type SettlementLine = { index: number; identity: string; category: string; amountSatang: number; advanceId: string; description: string };

/**
 * The explicit lines of an EXPENSE_SETTLEMENT entry, checked against the entry itself.
 * Refuses — never repairs — a settlement whose lines are missing, malformed, for another
 * advance, for a category the advance may not pay for, or that do not add up to the ledger.
 */
export function settlementLines(
  entry: { advanceId: string; amountSatang: number; snapshot: unknown },
  advance: { allowedCategories: readonly string[]; advanceNo: string },
): { ok: true; lines: SettlementLine[]; totalSatang: number } | { ok: false; reasons: string[] } {
  const snap = (entry.snapshot ?? {}) as { lines?: unknown; total?: unknown };
  if (!Array.isArray(snap.lines) || !snap.lines.length) {
    return { ok: false, reasons: ["This settlement has no explicit lines (it was written before settlements recorded them) — it cannot be matched to a PEAK document by amount. An accountant has to review it."] };
  }
  const reasons: string[] = [];
  const lines: SettlementLine[] = [];
  for (const raw of snap.lines as Record<string, unknown>[]) {
    const l = raw as Partial<SettlementLine>;
    const label = `"${String(l.description ?? "").trim() || `row ${Number(l.index) + 1}`}"`;
    if (!Number.isSafeInteger(l.amountSatang) || (l.amountSatang ?? 0) <= 0) { reasons.push(`Line ${label} has no valid amount`); continue; }
    if (l.advanceId !== entry.advanceId) { reasons.push(`Line ${label} belongs to another advance`); continue; }
    const cat = String(l.category ?? "");
    if (!(ADVANCE_ELIGIBLE as readonly string[]).includes(cat)) { reasons.push(`Line ${label} has category "${cat || "none"}", which no advance may pay for`); continue; }
    if (!advance.allowedCategories.includes(cat)) { reasons.push(`Line ${label} is ${cat}, which ${advance.advanceNo} may not pay for`); continue; }
    lines.push({ index: Number(l.index), identity: String(l.identity ?? ""), category: cat, amountSatang: l.amountSatang!, advanceId: entry.advanceId, description: String(l.description ?? "") });
  }
  if (reasons.length) return { ok: false, reasons };
  const total = lines.reduce((s, l) => s + l.amountSatang, 0);
  if (total !== entry.amountSatang) reasons.push(`The settlement's lines add up to ${total / 100}, but the ledger entry is ${entry.amountSatang / 100} — they must agree exactly`);
  if (snap.total != null && Number(snap.total) !== entry.amountSatang) reasons.push(`The settlement's recorded total (${Number(snap.total) / 100}) is not the ledger entry (${entry.amountSatang / 100})`);
  return reasons.length ? { ok: false, reasons } : { ok: true, lines, totalSatang: total };
}

/** Each line's account, summed per account. Any category without a mapped account refuses the whole settlement. */
export function amountsByAccount(lines: readonly SettlementLine[], accounts: Record<string, string>): { ok: true; byAccount: Map<string, number> } | { ok: false; reasons: string[] } {
  const missing = [...new Set(lines.filter((l) => !accounts[l.category]).map((l) => l.category))];
  if (missing.length) {
    return { ok: false, reasons: missing.map((c) => `No PEAK account is mapped for ${c} (${CATEGORY_CHART_CODE[c as ExpenseCategoryKey] ?? c}) — map it in the account chart first; FolkOPS will not guess one`) };
  }
  const byAccount = new Map<string, number>();
  for (const l of lines) byAccount.set(accounts[l.category], (byAccount.get(accounts[l.category]) ?? 0) + l.amountSatang);
  return { ok: true, byAccount };
}
