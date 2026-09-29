// Turning a stored guest number into something the guide can act on.
//
// The channels hand us the number in a few shapes, all seen in production:
//   "+393331112222"        — most of them: clean international
//   "US+1 5551234567"      — a country-code LABEL glued on the front (Viator)
//   "0812345678"           — a Thai mobile written the local way
//   "5551234567"           — bare digits with no country code
//
// wa.me wants country code and number as digits with no punctuation. The first two
// normalise cleanly, and a Thai local mobile has exactly one reading (66 + the number
// without its leading 0). Bare digits with no country code cannot be read safely: a link
// built from them opens a chat with whoever owns that number in a country wa.me had to
// guess, or with nobody at all. A wrong number looks like a working link and wastes the
// guide's time at the meeting point, so it gets no link.
const E164_MIN = 8; // shorter than this cannot carry a country code plus a number
const E164_MAX = 15; // E.164's hard ceiling

// A Thai mobile written locally: 06x / 08x / 09x and eight more digits. Landlines
// (02–07, nine digits) are left alone — WhatsApp lives on mobiles, and a nine-digit
// 0-number is as likely to be another country's local format.
const THAI_LOCAL_MOBILE = /^0([689]\d{8})$/;
// Thailand once the country code is on: 66 + a nine-digit mobile, or 66 + an eight-digit
// landline. Anything else starting with 66 is not a Thai number we can vouch for.
const THAI_INTL = /^66(?:[689]\d{8}|[2-7]\d{7})$/;

/**
 * The number as wa.me wants it — country code and number, digits only — or null when it
 * cannot be read with certainty.
 *
 *   "+66 81-234-5678" / "+66 (0)81 234 5678" / "+660812345678" → "66812345678"
 *   "0812345678"                                              → "66812345678"
 *   "0066812345678" / "US+1 555 123 4567"                      → international digits
 *   "5551234567", "812345678", "081 234 5678 ext 2", "abc"     → null
 */
export function normalizeWhatsAppNumber(phone: string | null | undefined): string | null {
  if (phone == null) return null;
  let s = String(phone).trim();
  if (!s) return null;
  // One number only. Two numbers, an extension or words mean a person has to read it.
  if (/[,;/#]|ext|\dx\d/i.test(s)) return null;
  // A two-letter country label in front of the + ("US+1 …") says nothing the digits don't.
  s = s.replace(/^[A-Za-z]{2}(?=\s*\+)/, "");
  // "(0)" is the trunk prefix some people write inside an international number.
  s = s.replace(/\(0\)/g, "");
  // Punctuation people type between digits.
  s = s.replace(/[\s\-.() ]/g, "");
  if (!/^\+?\d+$/.test(s)) return null;

  let digits: string;
  if (s.startsWith("+")) digits = s.slice(1);
  else if (s.startsWith("00")) digits = s.slice(2);
  else if (THAI_LOCAL_MOBILE.test(s)) digits = `66${s.slice(1)}`;
  else if (THAI_INTL.test(s)) digits = s; // "66812345678": Thai with its country code, no "+"
  else return null; // bare digits: no country code we can trust

  // "+66 0812345678": the local 0 kept after the country code.
  if (/^660\d{9}$/.test(digits)) digits = `66${digits.slice(3)}`;
  if (digits.startsWith("0")) return null; // no country code starts with 0
  if (digits.length < E164_MIN || digits.length > E164_MAX) return null;
  if (digits.startsWith("66") && !THAI_INTL.test(digits)) return null;
  return digits;
}

/** A https://wa.me/… link for a number we can read with certainty, or null. */
export function whatsappUrl(phone: string | null | undefined): string | null {
  const digits = normalizeWhatsAppNumber(phone);
  return digits ? `https://wa.me/${digits}` : null;
}

/** The number to show beside the button — the normalised one, as "+<digits>". */
export function whatsappDisplay(phone: string | null | undefined): string | null {
  const digits = normalizeWhatsAppNumber(phone);
  return digits ? `+${digits}` : null;
}
