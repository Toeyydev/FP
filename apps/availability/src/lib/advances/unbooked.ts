// Costs the company really paid that no PEAK document is carrying.
//
// Two rules, both correct on their own, leave a gap between them: a job-sheet document
// is raised against the guide, so a row the company already settled must not go on it
// (lib/peak-sync.notGuidePayable); and a combined payment document only carries what is
// being transferred, so it skips those rows too (lib/peak-payment-document). The cost is
// real either way — it is simply not owed to the guide.
//
// Until Phase 3.1 gives the advance clearing account a home in PEAK, FolkOPS keeps the
// list and the accountant books from it. Nothing here writes anything.
//
// Only a payer a person stands behind is a company cost to book (lib/payer-rules
// payerStatement). A row whose "company" or "advance" is a suggestion nobody confirmed —
// a booked Rate's, the old after-tour default, a meal payer nobody chose — is listed as
// AWAITING_PAYER: visible for follow-up, never counted in the totals, never ready to book.
import { expenseAmount, type Expense } from "@/lib/jobsheet";
import { canonicalPaidBy, notGuidePayable } from "@/lib/peak-sync";
import { payerStatement } from "@/lib/payer-rules";

export type UnbookedRow = {
  guideId: string;
  jobNo: string | null;
  date: string;
  slotIdx: number;
  description: string;
  category: string | null;
  amount: number;
  /** Why it is not on the guide's document. */
  fundedBy: "COMPANY_DIRECT" | "GUIDE_ADVANCE";
  /** Was an advance actually recorded for this job? A GUIDE_ADVANCE row without one is an exception to review. */
  advanceNo: string | null;
  hasAdvanceRecord: boolean;
  /** The last PEAK document this sheet had, and what happened to it. */
  peakDocumentNo: string | null;
  peakSyncStatus: string | null;
  /** Filled in when the accountant books it, so it is never booked twice. */
  bookedAs: string | null;
  /** READY_TO_BOOK: a person confirmed who paid. AWAITING_PAYER: a suggestion — confirm it on the job sheet first. */
  state: "READY_TO_BOOK" | "AWAITING_PAYER";
};

type SheetLike = {
  guideId: string; date: string; slotIdx: number; ref: string | null;
  expenses: unknown; peakDocumentNo: string | null; peakSyncStatus: string | null;
};

/**
 * Pure: the caller supplies the sheets and whichever advances exist for them.
 * A row counts only when the app counts it — `expenseAmount` is price × pax, and a row
 * with no pax counts as zero everywhere else too, so it is not listed here either.
 * (That zero-pax behaviour is a separate defect; this report does not paper over it.)
 */
export function unbookedExpenses(input: {
  sheets: SheetLike[];
  advances: { guideId: string; date: string; slotIdx: number; advanceNo: string }[];
  bookedKeys?: Map<string, string>;
}): UnbookedRow[] {
  const out: UnbookedRow[] = [];
  for (const s of input.sheets) {
    const rows = (Array.isArray(s.expenses) ? s.expenses : []) as Expense[];
    for (const [i, e] of rows.entries()) {
      const amount = expenseAmount(e);
      if (!(amount > 0) || !notGuidePayable(e)) continue;
      const advance = input.advances.find((a) => a.guideId === s.guideId && a.date === s.date && a.slotIdx === s.slotIdx) ?? null;
      const key = `${s.guideId}|${s.date}|${s.slotIdx}|${i}`;
      out.push({
        guideId: s.guideId, jobNo: s.ref, date: s.date, slotIdx: s.slotIdx,
        description: (e.description ?? "").trim() || "an expense row",
        category: (e.expenseType ?? null) as string | null,
        amount,
        fundedBy: canonicalPaidBy(e) === "COMPANY_DIRECT" ? "COMPANY_DIRECT" : "GUIDE_ADVANCE",
        advanceNo: advance?.advanceNo ?? null,
        hasAdvanceRecord: !!advance,
        peakDocumentNo: s.peakDocumentNo, peakSyncStatus: s.peakSyncStatus,
        bookedAs: input.bookedKeys?.get(key) ?? null,
        state: payerStatement(e).awaiting ? "AWAITING_PAYER" : "READY_TO_BOOK",
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.jobNo ?? "").localeCompare(b.jobNo ?? ""));
}

/** Totals of what is ready to book. Rows awaiting payer confirmation are counted apart, never in these. */
export function unbookedTotals(all: UnbookedRow[]) {
  const round = (n: number) => Math.round(n * 100) / 100;
  const rows = all.filter((r) => r.state === "READY_TO_BOOK");
  const waiting = all.filter((r) => r.state === "AWAITING_PAYER");
  const sum = (f: (r: UnbookedRow) => boolean) => round(rows.filter(f).reduce((s, r) => s + r.amount, 0));
  return {
    awaitingPayer: { rows: waiting.length, total: round(waiting.reduce((s, r) => s + r.amount, 0)) },
    rows: rows.length,
    total: sum(() => true),
    fromAdvance: sum((r) => r.fundedBy === "GUIDE_ADVANCE"),
    companyDirect: sum((r) => r.fundedBy === "COMPANY_DIRECT"),
    /** The exception list: money said to come from an advance nobody recorded. */
    advanceWithoutRecord: sum((r) => r.fundedBy === "GUIDE_ADVANCE" && !r.hasAdvanceRecord),
    alreadyBooked: sum((r) => !!r.bookedAs),
  };
}
