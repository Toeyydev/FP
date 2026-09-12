// The saved account chart, read once and shaped for the pure helpers in peak-sync.
//
// Lives here rather than in peak-accounts.ts (which is deliberately storage-agnostic)
// or inline in a route: the job-sheet screen and the PEAK sync endpoint must resolve
// an expense to the SAME account. Two copies of this mapping would drift, and the
// screen would then promise an account the posting used differently.
import { prisma } from "@/lib/db";
import { isMapped, type AccountMapping } from "@/lib/peak-accounts";
import type { PeakAccount, PeakAccountMap } from "@/lib/peak-sync";

const SELECT = { folkopsCategory: true, peakAccountCode: true, peakAccountName: true, isActive: true } as const;

// What makes a job sheet inherit the chart automatically instead of asking again per
// job. Unmapped stays unmapped — never a fallback account, and never a code inferred
// from anything. No PEAK call is made here.
//
// The job sheet's short expenseType keys → the chart's category codes.
//
// OTHER_TOUR_COST is deliberately absent: it has no standing account, and its row
// carries its own peakAccountCode chosen on the sheet (see lib/peak-sync).
// GUIDE_FEE is absent too — it is not a tour-expense category; read it with
// guideFeeAccount() below.
const TOUR_EXPENSE_CATEGORIES = [
  ["entrance", "ENTRANCE_TICKET"],
  ["transport", "TRANSPORTATION"],
  ["meal", "MEAL_REFRESHMENT"],
] as const;

const toAccount = (m: AccountMapping | undefined): PeakAccount | null =>
  isMapped(m) ? { code: m!.peakAccountCode!, name: m!.peakAccountName ?? undefined } : null;

export async function peakAccountMap(): Promise<PeakAccountMap> {
  const rows = await prisma.peakAccountMapping.findMany({ select: SELECT });
  const out: PeakAccountMap = {};
  for (const [expenseType, code] of TOUR_EXPENSE_CATEGORIES) {
    const account = toAccount(rows.find((r) => r.folkopsCategory === code));
    if (account) out[expenseType] = account;
  }
  return out;
}

/** The account the guide fee books to, or null when the chart has no code for it. */
export async function guideFeeAccount(): Promise<PeakAccount | null> {
  const rows = await prisma.peakAccountMapping.findMany({ where: { folkopsCategory: "GUIDE_FEE" }, select: SELECT });
  return toAccount(rows[0]);
}
