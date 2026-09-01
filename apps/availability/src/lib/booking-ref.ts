// The booking reference FolkOPS works from.
//
//  - GetYourGuide puts its GYG… code in externalRef.
//  - Viator sends TWO: an internal booking number in externalRef (e.g. 1440878485)
//    and a voucher code in confirmationCode (e.g. VIA-102007809).
//
// externalRef wins. Per the operator (2026-09-01), Viator's internal number is the
// one their reports and settlements are keyed on, so it is the number to reconcile
// against; the VIA-… voucher code is not needed operationally. Preferring one
// field for every channel also removes the split where a GetYourGuide row showed
// externalRef while a Viator row beside it showed confirmationCode.
//
// Sheets saved before this change hold the VIA-… code. They keep matching: the
// no-show and dedupe lookups register BOTH fields as keys.
export function bookingRef(externalRef?: string | null, confirmationCode?: string | null): string {
  const e = (externalRef || "").trim(), c = (confirmationCode || "").trim();
  return e || c;
}
