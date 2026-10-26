import { json, readJson, rateLimit, verifyToken } from './_shared.js';

export async function onRequestGet({ env }) {
  if (!env.REVIEW_DB) return json({ reviews: [] }, 200, { 'cache-control': 'public, max-age=60' });
  const result = await env.REVIEW_DB.prepare(`SELECT display_name, rating, review_text, tour_name, tour_month, published_at
    FROM reviews WHERE status = 'published' AND display_consent = 1 ORDER BY published_at DESC LIMIT 50`).all();
  const reviews = (result.results || []).map((row) => ({ displayName: row.display_name, rating: row.rating, reviewText: row.review_text, tourName: row.tour_name, tourMonth: row.tour_month, publishedAt: row.published_at }));
  return json({ reviews }, 200, { 'cache-control': 'public, max-age=300' });
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.REVIEW_DB || !env.REVIEW_TOKEN_SECRET || !(await rateLimit(request, env, 20))) return json({ message: 'The review could not be submitted. Please try again later.' }, 429);
    const body = await readJson(request);
    const verified = await verifyToken(body.verificationToken, env.REVIEW_TOKEN_SECRET);
    const displayName = String(body.displayName || '').trim();
    const reviewText = String(body.reviewText || '').trim();
    const rating = Number(body.rating);
    if (!verified || !body.displayConsent || displayName.length < 1 || displayName.length > 60 || reviewText.length < 20 || reviewText.length > 1200 || !Number.isInteger(rating) || rating < 1 || rating > 5) {
      return json({ message: 'Check the name, rating, review, and publishing consent before submitting.' }, 422);
    }
    const id = crypto.randomUUID();
    await env.REVIEW_DB.prepare(`INSERT INTO reviews (id, booking_hash, display_name, rating, review_text, tour_name, tour_month, display_consent, status, submitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?)`).bind(id, verified.bookingHash, displayName, rating, reviewText, verified.tourName, verified.tourMonth, new Date().toISOString()).run();
    return json({ accepted: true }, 202);
  } catch (error) {
    if (/UNIQUE|constraint/i.test(String(error?.message))) return json({ message: 'A review has already been submitted for this booking.' }, 409);
    return json({ message: 'The review could not be submitted. Please try again later.' }, 500);
  }
}
