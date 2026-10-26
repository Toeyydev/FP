// What a Bókun Rate title says about the guests' entrance tickets. Pure, no imports: used by
// the payer suggestions (lib/rate-payer) and the job sheet's Tickets column (lib/sheet-bookings).
// Owner policy 2026-10-01: a Rate is a suggestion, never accounting evidence; a title that
// does not say is UNKNOWN and nothing is guessed from it ("Standard rate" says nothing).

export type RateKind = "TICKET_INCLUDED" | "GUIDED_EXPERIENCE" | "UNKNOWN";
export const RATE_KIND_LABEL: Record<RateKind, string> = {
  TICKET_INCLUDED: "tickets included",
  GUIDED_EXPERIENCE: "guided experience",
  UNKNOWN: "not recognised",
};

/** Rate titles verified (in Bókun's rate configuration) to be a guided experience without tickets. Empty until one is. */
export const GUIDED_TITLES: readonly string[] = [];
const NEGATED = /\b(no|not|without|excluding|excl\.?|except)\b[^.]*\btickets?\b|\btickets?\s+(are\s+)?not\s+included\b/i;
const TICKETS_INCLUDED = /\b(with|incl(?:uding|udes|uded)?)\s+(all\s+)?(the\s+)?(entrance\s+|entry\s+|admission\s+)?tickets?\b|\btickets?\s+(are\s+)?included\b/i;

/** The kind of a Rate by its title. No title, or one nothing here recognises, is UNKNOWN. */
export function rateKind(title: string | null | undefined): RateKind {
  const t = (title ?? "").trim().replace(/\s+/g, " ");
  if (!t) return "UNKNOWN";
  if (NEGATED.test(t)) return "GUIDED_EXPERIENCE";
  if (TICKETS_INCLUDED.test(t)) return "TICKET_INCLUDED";
  if (GUIDED_TITLES.includes(t.toLowerCase())) return "GUIDED_EXPERIENCE";
  return "UNKNOWN";
}

/**
 * The job sheet's Tickets value for a booking, from its Rate title — only where the title is
 * unambiguous. "with (all) entrance tickets" → "included"; a title that says there are no
 * tickets, or one on the verified guided list → "not"; anything else → "" (a person decides).
 */
export function ticketsFromRate(title: string | null | undefined): "included" | "not" | "" {
  const k = rateKind(title);
  return k === "TICKET_INCLUDED" ? "included" : k === "GUIDED_EXPERIENCE" ? "not" : "";
}
