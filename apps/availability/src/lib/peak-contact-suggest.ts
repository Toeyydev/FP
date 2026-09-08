// Suggesting — never choosing — which PEAK contact a guide is.
//
// The mapping stays a deliberate human act: this only puts a candidate in front
// of the operator, who must still confirm it. Nothing here writes, and a payout
// still resolves through the stored peakContactId alone. There is no name
// fallback at posting time and no contact is ever created.
//
// Two signals are trusted, and only when they are unambiguous:
//   1. the PEAK contact code IS the FolkOPS guide id — someone already encoded
//      the link deliberately, so it is not a guess;
//   2. exactly ONE contact's English name normalises to the guide's legal name.
//      Two matches means two people share a name, which is exactly when a machine
//      must not pick.

export type SuggestContact = { id: string; name: string; code?: string | null };
export type ContactSuggestion = {
  contactId: string;
  reason: "code-matches-guide-id" | "unique-name-match";
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

export function suggestPeakContact(
  guide: { guideId: string; legalName?: string | null },
  contacts: SuggestContact[],
): ContactSuggestion | null {
  const guideId = (guide.guideId ?? "").trim();
  if (!guideId || !contacts?.length) return null;

  // 1. An exact contact-code match. Strongest signal: a code equal to the guide
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

  // 2. Exactly one name match, or nothing.
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
