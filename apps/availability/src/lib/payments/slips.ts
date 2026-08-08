// Split-payment slips for a single tour: a tour's payout can be settled in several
// bank transfers, each slip carrying its own amount. The slips must sum to the
// tour's payout total ("the right number"). This module holds the pure math used
// by both the API route and the UI so they always agree.

export type Slip = {
  amount: number; // baht paid on this slip
  url: string | null; // Google Drive link to the slip image/PDF (null if Drive save failed)
  at: string; // ISO timestamp the slip was added
  name?: string; // Drive file name (for display / dedupe)
};

// Round to whole baht for comparisons — slip amounts and payouts are baht figures,
// and computed payouts can carry tiny floating error (e.g. WHT %). Comparing at the
// baht level is what "matches exactly" means for the operator.
export const baht = (n: number): number => Math.round(Number(n) || 0);

export function slipsTotal(slips: Slip[] | null | undefined): number {
  return (slips ?? []).reduce((s, x) => s + (Number(x?.amount) || 0), 0);
}

export type MatchState = {
  paid: boolean; // slips exactly equal the payout
  warn: "over" | "under" | null; // mismatch direction (null when exact or nothing paid yet)
  delta: number; // signed baht: slipsTotal - payout (0 when exact)
  remaining: number; // payout - slipsTotal, floored at 0 (what's still owed)
  slipsTotal: number; // rounded sum of slip amounts
  payout: number; // rounded tour payout
};

// Decide where a tour stands given its slips and its payout. "Exact match → paid";
// any mismatch is flagged (over/under) and is NOT paid — the operator must correct
// it. With no slips yet, it's simply unpaid with nothing to warn about.
export function matchState(slips: Slip[] | null | undefined, payout: number): MatchState {
  const total = baht(slipsTotal(slips));
  const target = baht(payout);
  const delta = total - target;
  const has = (slips ?? []).length > 0;
  return {
    paid: has && delta === 0,
    warn: !has || delta === 0 ? null : delta > 0 ? "over" : "under",
    delta,
    remaining: Math.max(0, target - total),
    slipsTotal: total,
    payout: target,
  };
}
