// The customer-recognizable OTA reference for a booking.
//  - GetYourGuide: the GYG… code lives in externalRef
//  - Viator: the VIA-… code lives in confirmationCode (externalRef is an internal id)
// So prefer whichever field carries a known OTA prefix; otherwise fall back to either
// (manual / direct bookings).
const OTA = /^(GYG|VIA)/i;
export function bookingRef(externalRef?: string | null, confirmationCode?: string | null): string {
  const e = (externalRef || "").trim(), c = (confirmationCode || "").trim();
  if (OTA.test(e)) return e;
  if (OTA.test(c)) return c;
  return e || c;
}
