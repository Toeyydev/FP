// Suggest which guide a LINE follower is, by comparing their LINE display name to
// the guide roster. Pure + deterministic so it's unit-testable and safe to run on
// every admin load. The operator always makes the final call — this only pre-picks
// the dropdown, so a fuzzy-but-wrong guess costs one click to correct.

export type GuideName = { userId: string; displayName: string; fullName?: string | null };

// Lowercase, strip diacritics + emoji + punctuation, collapse spaces. Keeps Thai
// and Latin letters/digits so "โต้ง" or "Nok (Folkpaths)" normalize cleanly.
export function normalizeName(s: string): string {
  return (s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")           // combining diacritics
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")          // drop emoji/punctuation
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  return normalizeName(s).split(" ").filter(Boolean);
}

// 0..100. Exact match wins; then substring; then shared-token overlap.
export function nameScore(a: string, b: string): number {
  const na = normalizeName(a), nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  if (na.length >= 3 && nb.length >= 3 && (na.includes(nb) || nb.includes(na))) return 80;
  const ta = new Set(tokens(a)), tb = tokens(b);
  if (!ta.size || !tb.length) return 0;
  const shared = tb.filter((t) => t.length >= 2 && ta.has(t)).length;
  if (!shared) return 0;
  const ratio = shared / Math.max(ta.size, tb.length);
  return Math.round(60 * ratio);
}

// Best guide for a LINE display name, or null if nothing clears the threshold.
// Compares against both the nickname and the full name; ties break to the higher
// score, then to whichever guide sorts first (stable).
export function suggestGuide(lineName: string, guides: GuideName[], threshold = 50): { userId: string; score: number } | null {
  let best: { userId: string; score: number } | null = null;
  for (const g of guides) {
    const score = Math.max(nameScore(lineName, g.displayName), g.fullName ? nameScore(lineName, g.fullName) : 0);
    if (score >= threshold && (!best || score > best.score)) best = { userId: g.userId, score };
  }
  return best;
}
