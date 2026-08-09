// Review-reward domain: statuses, settlement periods, and refs. A confirmed GYG
// review mints a ReviewReward settled per the guide's policy (weekly/monthly).
// Pure helpers live up top (unit-tested); the two DB lookups are at the bottom.

import { prisma } from "@/lib/db";

export const REVIEW_STATUSES = ["NEW", "NEEDS_REVIEW", "CONFIRMED", "REJECTED"] as const;
export const MATCH_STATUSES = ["UNMATCHED", "SUGGESTED", "AUTO_MATCHED", "MANUAL_MATCHED"] as const;
export const REWARD_STATUSES = ["UNPAID", "IN_SETTLEMENT", "PAID", "CANCELLED"] as const;
export const SETTLEMENT_STATUSES = ["OPEN", "PAID", "CANCELLED"] as const;
export const POLICY_COST_TYPES = ["GUIDE_FEE", "TOUR_EXPENSE", "REVIEW_REWARD"] as const;
export const POLICY_FREQUENCIES = ["WEEKLY", "MONTHLY"] as const;

export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export type PolicyFrequency = (typeof POLICY_FREQUENCIES)[number];

export const isReviewStatus = (s: string): s is ReviewStatus => (REVIEW_STATUSES as readonly string[]).includes(s);
export const isPolicyFrequency = (s: string): s is PolicyFrequency => (POLICY_FREQUENCIES as readonly string[]).includes(s);

// Default reward per confirmed review (THB). Env-overridable so the owner can
// change it without a deploy; per-guide amounts can become a policy column later.
export function defaultRewardAmount(): number {
  const n = Number(process.env.REVIEW_REWARD_DEFAULT_THB);
  return Number.isFinite(n) && n > 0 ? n : 100;
}

// ── Settlement periods ──────────────────────────────────────────────────────
// MONTHLY → "2026-08" (calendar month, same shape as PayrollStatus.period).
// WEEKLY  → "2026-W33" (ISO week: Monday-based, week 1 contains the first
// Thursday). All inputs/outputs are "YYYY-MM-DD" strings, house style.

const pad = (n: number) => String(n).padStart(2, "0");

function isoWeekOf(dateYMD: string): { year: number; week: number } {
  const [y, m, d] = dateYMD.split("-").map(Number);
  const x = new Date(Date.UTC(y, m - 1, d));
  x.setUTCDate(x.getUTCDate() + 3 - ((x.getUTCDay() + 6) % 7)); // Thursday of this ISO week
  const year = x.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week1Mon = new Date(jan4);
  week1Mon.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  const week = 1 + Math.round((x.getTime() - week1Mon.getTime()) / (7 * 86400 * 1000));
  return { year, week };
}

export function periodFor(dateYMD: string, freq: PolicyFrequency): string {
  if (freq === "WEEKLY") {
    const { year, week } = isoWeekOf(dateYMD);
    return `${year}-W${pad(week)}`;
  }
  return dateYMD.slice(0, 7);
}

// First/last day of a period label. Monthly bounds are the calendar month;
// weekly bounds are Monday..Sunday of that ISO week.
export function periodBounds(period: string): { start: string; end: string } {
  const wk = period.match(/^(\d{4})-W(\d{2})$/);
  if (wk) {
    const year = Number(wk[1]), week = Number(wk[2]);
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const week1Mon = new Date(jan4);
    week1Mon.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
    const mon = new Date(week1Mon);
    mon.setUTCDate(week1Mon.getUTCDate() + (week - 1) * 7);
    const sun = new Date(mon);
    sun.setUTCDate(mon.getUTCDate() + 6);
    const ymdUTC = (dt: Date) => `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
    return { start: ymdUTC(mon), end: ymdUTC(sun) };
  }
  const [y, m] = period.split("-").map(Number);
  return { start: `${period}-01`, end: `${period}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}` };
}

// FOLK-RR-202608-G001 (monthly) / FOLK-RR-2026W33-G001 (weekly). Deterministic
// from (period, guide) — the DB unique on (guideId, periodLabel) is the real
// guard, so no allocator scan is needed (unlike nextJobRef).
export function makeSettlementRef(period: string, guideId: string): string {
  return `FOLK-RR-${period.replace(/-/g, "")}-${guideId}`;
}

// A review a human should look at: confirmed reviews need a guide first — the
// API enforces it, but keep the rule in one testable place.
export function canConfirm(review: { guideId: string | null; status: string }): boolean {
  return Boolean(review.guideId) && review.status !== "CONFIRMED" && review.status !== "REJECTED";
}

// ── DB lookups ──────────────────────────────────────────────────────────────

// The guide's review-reward payout frequency; MONTHLY when no policy row exists
// (the safest default — fewer, larger transfers).
export async function reviewRewardFrequency(guideId: string): Promise<PolicyFrequency> {
  const p = await prisma.guidePaymentPolicy
    .findUnique({ where: { guideId_costType: { guideId, costType: "REVIEW_REWARD" } } })
    .catch(() => null);
  return p?.frequency === "WEEKLY" ? "WEEKLY" : "MONTHLY";
}

// All alias entries for matching: every guide's displayName + fullName + any
// GuideAlias rows, normalized by the caller (review-suggest normalizes itself).
export async function guideNamePool(): Promise<{ guideId: string; name: string }[]> {
  const [guides, aliases] = await Promise.all([
    prisma.user.findMany({ where: { guideId: { not: null } }, select: { guideId: true, displayName: true, fullName: true } }),
    prisma.guideAlias.findMany({ select: { guideId: true, alias: true } }),
  ]);
  const pool: { guideId: string; name: string }[] = [];
  for (const g of guides) {
    if (!g.guideId) continue;
    if (g.displayName) pool.push({ guideId: g.guideId, name: g.displayName });
    if (g.fullName) pool.push({ guideId: g.guideId, name: g.fullName });
  }
  for (const a of aliases) pool.push({ guideId: a.guideId, name: a.alias });
  return pool;
}
