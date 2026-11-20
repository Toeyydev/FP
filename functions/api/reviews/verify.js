import { fetchBokunBooking, genericVerificationFailure, json, normalizeCode, normalizeEmail, rateLimit, readJson, sha256, signToken, summarizeBooking, validCodeCandidate, validEmailCandidate, verifyTurnstile } from './_shared.js';

export async function onRequestPost({ request, env }) {
  try {
    if (!env.REVIEW_TOKEN_SECRET || !(await rateLimit(request, env))) return genericVerificationFailure();
    const body = await readJson(request);
    if (!(await verifyTurnstile(request, body.turnstileToken, env))) return genericVerificationFailure();
    const bookingCode = normalizeCode(body.bookingCode);
    const email = normalizeEmail(body.email);
    if (!validCodeCandidate(bookingCode) || !validEmailCandidate(email)) return genericVerificationFailure();

    const booking = await fetchBokunBooking(bookingCode, env);
    if (!booking) return genericVerificationFailure();
    const summary = summarizeBooking(booking);
    const complete = summary.tourDate instanceof Date && !Number.isNaN(summary.tourDate.valueOf()) && summary.tourDate.valueOf() < Date.now();
    const eligibleStatus = !/CANCELLED|ABORTED|REJECTED|TIMEOUT/i.test(summary.status);
    const directChannel = env.REVIEW_DIRECT_BOOKING_CHANNEL || 'Folkpaths.com';
    const isDirectBooking = summary.bookingChannel.localeCompare(directChannel, undefined, { sensitivity: 'accent' }) === 0;
    if (summary.email !== email || !complete || !eligibleStatus || !isDirectBooking) return genericVerificationFailure();

    const bookingHash = await sha256(`${env.REVIEW_HASH_SALT || env.REVIEW_TOKEN_SECRET}:${bookingCode}`);
    const existing = await env.REVIEW_DB.prepare('SELECT 1 FROM reviews WHERE booking_hash = ? LIMIT 1').bind(bookingHash).first();
    if (existing) return genericVerificationFailure();
    const tourMonth = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'Asia/Bangkok' }).format(summary.tourDate);
    const now = Math.floor(Date.now() / 1000);
    const verificationToken = await signToken({ bookingHash, tourName: summary.tourName, tourMonth, iat: now, exp: now + 900 }, env.REVIEW_TOKEN_SECRET);
    return json({ verificationToken, tourName: summary.tourName });
  } catch (error) {
    if (error.message === 'integration_unavailable') return json({ message: 'Review verification is temporarily unavailable. Please try again later.' }, 503);
    return genericVerificationFailure();
  }
}
