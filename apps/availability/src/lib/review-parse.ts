// Best-effort parser for an OTA "new review" notification email (GetYourGuide /
// Viator). These mails carry no booking, date, or customer — only the product, the
// star rating, and the short comment — so this just pre-fills the reward reason; the
// operator still supplies the tour date or reviewer name to find the guide.

export type ParsedReview = {
  product?: string;
  stars?: number;
  comment?: string;
  ota?: "GYG" | "Viator";
};

export function parseReviewEmail(text: string): ParsedReview {
  const raw = (text || "").replace(/\r/g, "");
  const clean = raw.replace(/\*\*/g, "").replace(/[*_`]/g, ""); // drop markdown emphasis
  const out: ParsedReview = {};

  // "...a new review for your product <NAME>." — capture up to the sentence end.
  const prod = clean.match(/for your product\s+([\s\S]+?)\.\s*(?:\n|$)/i);
  if (prod) out.product = prod[1].replace(/\s+/g, " ").trim();

  // Rating: count star glyphs, else "5 star" / "5/5".
  const glyphs = (clean.match(/[★⭐]/gu) || []).length;
  if (glyphs >= 1 && glyphs <= 5) out.stars = glyphs;
  else {
    const m = clean.match(/\b([1-5])\s*(?:stars?|\/\s*5)\b/i);
    if (m) out.stars = Number(m[1]);
  }

  // Comment: the line after the star line, else the last non-empty line that isn't
  // the greeting or the product sentence.
  const lines = clean.split("\n").map((l) => l.trim()).filter(Boolean);
  const starIdx = lines.findIndex((l) => /[★⭐]/u.test(l) || /\b[1-5]\s*stars?\b/i.test(l));
  if (starIdx >= 0 && lines[starIdx + 1]) out.comment = lines[starIdx + 1];
  else {
    const tail = [...lines].reverse().find((l) => !/^hi\b|supply partner|for your product|you have received/i.test(l));
    if (tail && !/[★⭐]/u.test(tail)) out.comment = tail;
  }
  if (out.comment) out.comment = out.comment.replace(/^["“”']|["“”']$/g, "").trim();

  if (/getyourguide|gyg/i.test(raw)) out.ota = "GYG";
  else if (/viator/i.test(raw)) out.ota = "Viator";

  return out;
}

// GYG notification subject: "You have a new review on GetYourGuide - 691771 (126357479)"
// → supplierRef 691771 (our GYG account), sourceReviewId 126357479 (the review).
// Both are dedup keys, so parse strictly — a subject that doesn't match yields {}.
export function parseGygSubject(subject: string): { supplierRef?: string; sourceReviewId?: string } {
  const m = (subject || "").match(/-\s*(\d+)\s*\(\s*(\d+)\s*\)\s*$/);
  return m ? { supplierRef: m[1], sourceReviewId: m[2] } : {};
}
