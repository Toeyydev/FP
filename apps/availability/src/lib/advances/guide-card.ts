// What a GUIDE is shown of the company advance (Company ADV) on their job — nothing more.
//
// Owner decisions 2026-11-11:
//   - A guide sees ONLY the advance amount and "✓ Transferred", plus "To return ฿X" while
//     they still hold unspent money. No ADV number, transfer date, bank or transfer
//     reference, PEAK document, slip link, note or purpose ever reaches a guide's browser.
//   - Company advances are paid by bank transfer only. "Transferred" means a live bank
//     advance in the ledger: one is recorded only after the money left the company bank
//     (bank reference + slip check), and a reversed one is VOID. An amount typed somewhere
//     never makes it "transferred". A record the ledger cannot reconcile (status null) is
//     not shown as transferred either.
//   - The guide still records their own return (job-number return reference); that is a
//     claim the office checks, so it lowers "To return" only by what is pending.
//
// Pure: built from the operator's view (lib/advances/job-view) on the server, so the guide's
// response is cut down before it leaves the server, never hidden in the browser.

import type { JobAdvanceView } from "@/lib/advances/job-view";

export type GuideAdvanceCard = {
  /** Sum of the live bank advances on this job, in baht. */
  amount: number;
  transferred: true;
  /** Unspent money the guide still holds, after returns already sent and awaiting a check. */
  toReturn: number;
  /** Recording is paused (ADVANCE_WRITES_FROZEN) — the guide cannot record a return now. */
  frozen: boolean;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The guide's card, or null when no transferred advance exists for this job. */
export function guideAdvanceCard(view: Pick<JobAdvanceView, "advances" | "returns" | "totals" | "frozen"> | null | undefined): GuideAdvanceCard | null {
  if (!view) return null;
  const live = view.advances.filter((a) => a.method === "bank" && a.status != null && a.status !== "VOID" && a.status !== "REVERSED");
  const amount = r2(live.reduce((s, a) => s + (a.amount || 0), 0));
  if (amount <= 0) return null;
  // Same arithmetic the guide's screen used before (returns sent but not counted yet).
  const claimed = view.returns.filter((r) => r.status === "CLAIMED").reduce((s, r) => s + (r.amount || 0), 0);
  const confirmedUncounted = view.returns.filter((r) => r.status === "VERIFIED" && (r.unallocated ?? 0) > 0).reduce((s, r) => s + (r.unallocated ?? 0), 0);
  const toReturn = Math.max(0, r2((view.totals?.outstanding ?? 0) - claimed - confirmedUncounted));
  return { amount, transferred: true, toReturn, frozen: !!view.frozen };
}
