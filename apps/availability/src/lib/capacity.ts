// Folkpaths guide capacity rule (per operator decision):
//   - hard cap of 12 pax per guide / per group,
//   - at 13+ the tour must be split across more guides and the operator is
//     alerted to do the split manually (whole bookings only, never splitting a party).
// This *suggests* a guide count — the operator still confirms the split.
// NOTE: raised from 10/11 to 12/13 per operator decision (7 Aug 2026). This is the
// single source of truth for the cap — API routes and UI import it, never hardcode.
export const PAX_PER_GUIDE = 12;
export const SPLIT_AT = 13;

export function guidesNeeded(pax: number): number {
  return Math.max(1, Math.ceil((pax || 0) / PAX_PER_GUIDE));
}
