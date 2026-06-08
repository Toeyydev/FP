// Folkpaths guide capacity rule (per operator decision):
//   - hard cap of 10 pax per guide / per group,
//   - at 11+ the tour must be split across more guides and the operator is
//     alerted to do the split manually (whole bookings only, never splitting a party).
// This *suggests* a guide count — the operator still confirms the split.
// NOTE: changed from 14/15 back to 10/11 to match the agreed 10-seat cap.
export const PAX_PER_GUIDE = 10;
export const SPLIT_AT = 11;

export function guidesNeeded(pax: number): number {
  return Math.max(1, Math.ceil((pax || 0) / PAX_PER_GUIDE));
}
