// Why an availability save failed, in words the guide can act on.
//
// Availability auto-saves on every tap, so a PUT that fails without being shown
// looks exactly like an app that quietly forgets: the guide taps, nothing moves,
// and nothing explains it. That is not hypothetical — after the site moved to
// ops.folkpaths.com on 2026-08-29 a guide spent two weeks unable to update her
// week. Her installed PWA still opened from its service-worker cache, so the app
// looked normal, while every /api call went to a host that no longer resolves —
// and putAvail ignored the result, so she was never told.
//
// Keys map onto STRINGS in i18n.ts.
export type AvailabilitySaveError =
  | "saveFailedSignedOut"
  | "completeProfileFirst"
  | "dayBlocked"
  | "slotAssigned"
  | "saveFailedOffline"
  | "saveFailed";

/**
 * The message key for a PUT /api/availability response that came back not-ok.
 * Anything unrecognised still returns a failure key — silence is the one outcome
 * that must never happen.
 */
export function availabilitySaveError(status: number, error?: string | null): AvailabilitySaveError {
  if (status === 401) return "saveFailedSignedOut";
  if (status === 403 && error === "profile-incomplete") return "completeProfileFirst";
  if (status === 409 && error === "date-blocked") return "dayBlocked";
  if (status === 409 && error === "slot-assigned") return "slotAssigned";
  return "saveFailed";
}
