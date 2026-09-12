// Turning a stored guest number into something the guide can act on.
//
// The channels hand us the number in three shapes, all seen in production:
//   "+393331112222"        — 120 of 133, clean international
//   "US+1 5551234567"      — 9 of 133, a country-code LABEL glued on the front (Viator)
//   "5551234567"           — 3 of 133, a bare 9–10 digits with no country code
//
// wa.me wants country code and number as digits with no punctuation, so the first two
// normalise cleanly. The third cannot: a link built from it opens a chat with whoever
// owns that number in a country wa.me had to guess, or with nobody at all. A wrong
// number looks like a working link and wastes the guide's time at the meeting point,
// so it gets no link and stays plain text for them to read and dial by hand.
const E164_MIN = 8; // shorter than this cannot carry a country code plus a number
const E164_MAX = 15; // E.164's hard ceiling

/** A https://wa.me/… link for an international number, or null when we can't be sure. */
export function whatsappUrl(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  if (!trimmed.includes("+")) return null; // no country code we can trust
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < E164_MIN || digits.length > E164_MAX) return null;
  return `https://wa.me/${digits}`;
}
