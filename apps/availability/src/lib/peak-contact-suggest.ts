// Suggesting — never choosing — which PEAK contact a guide is.
//
// The mapping stays a deliberate human act: this only puts a candidate in front
// of the operator, who must still confirm it. Nothing here writes, and a payout
// still resolves through the stored peakContactId alone. There is no name
// fallback at posting time and no contact is ever created.
//
// Two signals are trusted, and only when they are unambiguous:
//   1. the TAX NUMBER is the same — the one identifier that does not depend on
//      language. FolkOPS holds the guide's legal name in English while PEAK holds
//      the contact in Thai, so names cannot be compared for these records at all;
//      a 13-digit tax number identifies the same legal person either way;
//   2. the PEAK contact code IS the FolkOPS guide id — someone already encoded
//      the link deliberately, so it is not a guess;
//   3. exactly ONE contact's English name normalises to the guide's legal name.
//      Two matches means two people share a name, which is exactly when a machine
//      must not pick. In practice this fires rarely: it needs a PEAK contact stored
//      in English, which most are not.

export type SuggestContact = { id: string; name: string; code?: string | null; taxNumber?: string | null };
export type ContactSuggestion = {
  contactId: string;
  reason: "tax-id-match" | "code-matches-guide-id" | "unique-name-match";
  /** Shown to the operator so they can see WHY it is being offered. */
  explanation: string;
};

/**
 * Names as compared, never as displayed: case-folded, accents stripped, anything
 * that is not a letter or digit reduced to a single space. This absorbs the ways
 * the same person is written in two systems — "Somchai Jai-dee", "SOMCHAI JAIDEE",
 * "Somchai  Jaidee" — without inventing a fuzzy match that could pair two
 * different people.
 */
export function normalizeName(raw: string): string {
  return (raw ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")   // combining accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * A tax number as compared: digits only, so "1-2345-67890-12-3", "1234567890123"
 * and " 1234567890123 " are the same number. Returns "" for anything too short to
 * BE a tax number — a stray "0" or a 4-digit fragment must never match, because a
 * suggestion that names the wrong legal person is worse than no suggestion.
 */
export function taxDigits(raw: string | null | undefined): string {
  const digits = (raw ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits : "";
}

export function suggestPeakContact(
  guide: { guideId: string; legalName?: string | null; taxId?: string | null },
  contacts: SuggestContact[],
): ContactSuggestion | null {
  const guideId = (guide.guideId ?? "").trim();
  if (!guideId || !contacts?.length) return null;

  // 1. The same tax number. Checked FIRST: a contact code is a convention someone
  //    typed and may have typed inconsistently, while a tax number is the legal
  //    identity of the same person in both systems, whatever language the name is in.
  const guideTax = taxDigits(guide.taxId);
  if (guideTax) {
    const byTax = contacts.filter((c) => taxDigits(c.taxNumber) === guideTax);
    if (byTax.length === 1) {
      return {
        contactId: byTax[0].id,
        reason: "tax-id-match",
        explanation: `This PEAK contact's tax number is the same as the guide's (…${guideTax.slice(-4)}).`,
      };
    }
    // Two PEAK contacts carrying one tax number is a duplicate supplier in PEAK —
    // a data problem to fix there, never a match to guess at from here.
    if (byTax.length > 1) return null;
  }

  // 2. An exact contact-code match. Strongest signal: a code equal to the guide
  //    id was typed by a person who meant these to be the same record.
  const byCode = contacts.filter((c) => (c.code ?? "").trim().toLowerCase() === guideId.toLowerCase());
  if (byCode.length === 1) {
    return {
      contactId: byCode[0].id,
      reason: "code-matches-guide-id",
      explanation: `PEAK contact code "${(byCode[0].code ?? "").trim()}" is this guide's FolkOPS id.`,
    };
  }
  // Two contacts carrying the same code is a data problem in PEAK, not a match.
  if (byCode.length > 1) return null;

  // 3. Exactly one name match, or nothing.
  const target = normalizeName(guide.legalName ?? "");
  if (!target) return null;
  const byName = contacts.filter((c) => normalizeName(c.name) === target);
  if (byName.length !== 1) return null;

  return {
    contactId: byName[0].id,
    reason: "unique-name-match",
    explanation: `"${byName[0].name}" is the only PEAK contact whose name matches this guide.`,
  };
}
