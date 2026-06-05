// Folkpaths guide capacity rule:
//   - ~10 pax is the comfortable target for one guide,
//   - small bookings can combine up to ~14 on one guide (e.g. 7 + a family of 5),
//   - at 15+ a tour must be split across more guides.
// This only *suggests* a guide count — the operator still decides (a single
// family of 15 might stay with one guide; a mixed group gets two).
export const PAX_PER_GUIDE = 14;
export const SPLIT_AT = 15;

export function guidesNeeded(pax: number): number {
  return Math.max(1, Math.ceil((pax || 0) / PAX_PER_GUIDE));
}
