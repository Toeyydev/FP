// Fuzzy product-name → tour matching. OTA titles drift across contexts (a review
// email, a booking, and our ProductMap can each spell the same tour differently), so
// exact-key matching misses. This scores candidates by shared meaningful tokens.

// Generic marketing / channel words that don't identify a specific tour.
const STOP = new Set([
  "bangkok", "thailand", "thai", "guided", "guide", "tour", "tours", "experience",
  "classic", "half", "day", "halfday", "full", "private", "group", "small", "the",
  "and", "with", "from", "city", "trip", "visit", "explore", "discover", "best",
  "getyourguide", "viator", "com",
]);

function sigTokens(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z]+/g) || []).filter((w) => w.length >= 3 && !STOP.has(w)));
}

// Best tour id for `product` among candidates, or null if nothing scores confidently.
// Jaccard (shared / union) is used so a shorter candidate that's merely a subset of a
// richer title can't tie the fuller, more specific match.
export function matchTourByProduct(product: string, candidates: { name: string; tourId: string }[]): string | null {
  const pt = sigTokens(product);
  if (pt.size === 0) return null;
  let best: { tourId: string; score: number; shared: number } | null = null;
  for (const c of candidates) {
    const ct = sigTokens(c.name);
    if (ct.size === 0) continue;
    let shared = 0;
    for (const t of pt) if (ct.has(t)) shared++;
    if (shared < 2) continue; // one shared word (e.g. just "wat") is too weak
    const union = pt.size + ct.size - shared;
    const score = shared / union;
    if (score >= 0.34 && (!best || score > best.score || (score === best.score && shared > best.shared))) {
      best = { tourId: c.tourId, score, shared };
    }
  }
  return best?.tourId ?? null;
}
