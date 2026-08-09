// Suggest which guide a review is about from the review TEXT (guide names are
// often mentioned: "Mai è molto gentile…"). Pure + deterministic like
// line-match.ts — the operator always confirms before any money moves.
//
// Matching is token-exact, not substring, so "Mai" never fires inside
// "maison". Short Latin names (< 3 chars) are skipped as too noisy; Thai
// script is allowed at 2+ because Thai nicknames are short but distinctive.

import { normalizeName } from "@/lib/line-match";

export type NamePoolEntry = { guideId: string; name: string };
export type ReviewSuggestion = { guideId: string; mention: string };

const THAI = /\p{Script=Thai}/u;

function usableToken(t: string): boolean {
  return t.length >= 3 || (THAI.test(t) && t.length >= 2);
}

// Distinct guides whose name/alias appears in the text. Multi-word names match
// as a consecutive token phrase; single words as token membership.
export function suggestGuidesFromText(reviewText: string, pool: NamePoolEntry[]): ReviewSuggestion[] {
  const textTokens = normalizeName(reviewText || "").split(" ").filter(Boolean);
  if (!textTokens.length) return [];
  const joined = ` ${textTokens.join(" ")} `;
  const out = new Map<string, ReviewSuggestion>();
  for (const entry of pool) {
    if (out.has(entry.guideId)) continue;
    const nameTokens = normalizeName(entry.name).split(" ").filter(usableToken);
    if (!nameTokens.length) continue;
    const phrase = ` ${nameTokens.join(" ")} `;
    if (joined.includes(phrase)) out.set(entry.guideId, { guideId: entry.guideId, mention: entry.name });
  }
  return [...out.values()];
}

// The single suggestion to store on the Review, or null when nothing (or more
// than one guide) matched — ambiguity goes to the operator, never auto-picked.
export function suggestGuideFromText(
  reviewText: string,
  pool: NamePoolEntry[],
): { guideId: string; mention: string; confidence: "high" } | null {
  const all = suggestGuidesFromText(reviewText, pool);
  return all.length === 1 ? { ...all[0], confidence: "high" } : null;
}
