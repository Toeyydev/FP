// Upsell money is an integer number of satang everywhere — in the database (CHECKs refuse
// anything else) and in code. Baht appear only at the edges: what a person types and what a
// person reads.

export type PricingBasis = "PER_GUEST" | "PER_GROUP";

/** True for a whole, non-negative, safe number of satang. */
export const isSatang = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * Baht as typed by a person → satang. Refuses anything that is not an exact amount of at most
 * two decimals (no silent rounding of 12.345) and anything negative or not finite.
 */
export function bahtToSatang(baht: number | string): number {
  const text = typeof baht === "number" ? String(baht) : baht.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new RangeError(`Not an amount in baht: ${JSON.stringify(baht)}`);
  const [whole, frac = ""] = text.split(".");
  const satang = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(satang)) throw new RangeError(`Amount too large: ${text}`);
  return satang;
}

/** Satang → baht, for display and for systems that take baht. */
export function satangToBaht(satang: number): number {
  if (!Number.isSafeInteger(satang)) throw new RangeError(`Not a whole number of satang: ${satang}`);
  return satang / 100;
}

/** "1,050.00" — baht with two decimals and thousands separators. */
export const formatBaht = (satang: number) =>
  satangToBaht(satang).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A sale's gross, the same rule the database checks (UpsellSale_gross_check). */
export function grossSatang(basis: PricingBasis, guests: number, unitPriceSatang: number): number {
  if (!Number.isSafeInteger(guests) || guests <= 0) throw new RangeError(`Guests must be a positive whole number: ${guests}`);
  if (!Number.isSafeInteger(unitPriceSatang) || unitPriceSatang <= 0) throw new RangeError(`Unit price must be positive satang: ${unitPriceSatang}`);
  const gross = basis === "PER_GUEST" ? guests * unitPriceSatang : unitPriceSatang;
  if (!Number.isSafeInteger(gross)) throw new RangeError("Gross too large");
  return gross;
}

/** Sum of satang amounts, refusing anything that is not whole satang. */
export function sumSatang(amounts: readonly number[]): number {
  let total = 0;
  for (const a of amounts) {
    if (!Number.isSafeInteger(a)) throw new RangeError(`Not a whole number of satang: ${a}`);
    total += a;
  }
  if (!Number.isSafeInteger(total)) throw new RangeError("Total too large");
  return total;
}
