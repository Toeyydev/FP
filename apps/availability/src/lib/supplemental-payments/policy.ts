// The withholding rate a supplemental payment takes — from configured accounting policy,
// never assumed.
//
//   SUPPLEMENTAL_WHT_PCT_REVIEW_INCENTIVE=3      (and _BONUS, _ADJUSTMENT, _OTHER)
//
// Set by the owner on the deployment, after the accountant confirms the rate. When a type
// has no rate configured, the operator must enter one explicitly on each payment, and the
// payment records that it was ENTERED rather than CONFIGURED. A value that is not a rate
// (blank, text, negative, over 100, more than two decimals) counts as not configured — and
// is reported, so a typo cannot quietly become a tax rate.
import { SUPPLEMENTAL_TYPES, validPct, type SupplementalType } from "@/lib/supplemental-payments/rules";

export type WhtPolicy = { pct: number | null; invalid: boolean };

export function configuredWhtPct(type: SupplementalType, env: Record<string, string | undefined> = process.env): WhtPolicy {
  const raw = (env[`SUPPLEMENTAL_WHT_PCT_${type}`] ?? "").trim();
  if (!raw) return { pct: null, invalid: false };
  const n = Number(raw);
  return validPct(n) && /^\d+(\.\d{1,2})?$/.test(raw) ? { pct: n, invalid: false } : { pct: null, invalid: true };
}

/** Every type's policy, for the form and for /api/health-style reporting. */
export function whtPolicies(env: Record<string, string | undefined> = process.env): Record<SupplementalType, WhtPolicy> {
  return Object.fromEntries(SUPPLEMENTAL_TYPES.map((t) => [t, configuredWhtPct(t, env)])) as Record<SupplementalType, WhtPolicy>;
}
