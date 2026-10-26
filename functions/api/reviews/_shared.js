const encoder = new TextEncoder();

export const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
});

export const readJson = async (request) => {
  const type = request.headers.get('content-type') || '';
  if (!type.includes('application/json')) throw new Error('invalid_request');
  return request.json();
};

const bytesToHex = (bytes) => [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
const bytesToBase64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const bytesToBase64Url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const base64UrlToBytes = (value) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), (character) => character.charCodeAt(0));

export const sha256 = async (value) => bytesToHex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
const hmac = async (secret, value, algorithm = 'SHA-256') => {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: algorithm }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, encoder.encode(value));
};

export const signToken = async (payload, secret) => {
  const body = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${body}.${bytesToBase64Url(await hmac(secret, body))}`;
};

export const verifyToken = async (token, secret) => {
  const [body, signature] = String(token || '').split('.');
  if (!body || !signature) return null;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('HMAC', key, base64UrlToBytes(signature), encoder.encode(body));
  if (!valid) return null;
  const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(body)));
  return payload.exp > Math.floor(Date.now() / 1000) ? payload : null;
};

export const normalizeCode = (value) => String(value || '').trim().toUpperCase().replace(/\s+/g, '');
export const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
// Folkpaths direct bookings use the booking-level FOLK- reference. Do not
// accept the separate product-booking reference (observed with FOLK-T…).
// Bókun remains authoritative for the suffix length and booking existence.
export const validCodeCandidate = (value) => /^FOLK-[0-9]{3,64}$/.test(value);
export const validEmailCandidate = (value) => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const firstValue = (source, paths) => {
  for (const path of paths) {
    let value = source;
    for (const part of path.split('.')) value = value?.[part];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
};

const collectBookings = (booking) => {
  const groups = ['activityBookings', 'productBookings', 'bookings'];
  return groups.flatMap((key) => Array.isArray(booking?.[key]) ? booking[key] : []);
};

export const summarizeBooking = (booking) => {
  const child = collectBookings(booking).find((item) => !/CANCELLED|ABORTED/i.test(String(item.status || ''))) || collectBookings(booking)[0] || {};
  const email = firstValue(booking, ['customer.email', 'customer.emailAddress', 'customer.contactDetails.email', 'customerDetails.email', 'email']);
  const status = String(firstValue(child, ['status']) || firstValue(booking, ['status']) || '');
  const tourName = String(firstValue(child, ['activity.title', 'activity.name', 'product.title', 'product.name', 'title']) || 'Folkpaths tour');
  const dateValue = firstValue(child, ['endDateTime', 'endTime', 'date', 'startDateTime', 'startTime', 'startDate']) || firstValue(booking, ['endDateTime', 'startDateTime', 'date']);
  const bookingChannel = String(firstValue(booking, ['bookingChannel.title', 'bookingChannel.name', 'bookingChannel', 'channel.title', 'channel.name', 'channel']) || '');
  const tourDate = dateValue ? new Date(dateValue) : null;
  return { email: normalizeEmail(email), status, tourName: tourName.slice(0, 160), tourDate, bookingChannel };
};

export const fetchBokunBooking = async (code, env) => {
  if (!env.BOKUN_ACCESS_KEY || !env.BOKUN_SECRET_KEY) throw new Error('integration_unavailable');
  const origin = env.BOKUN_API_ORIGIN || 'https://api.bokun.io';
  const path = `/booking.json/booking/${encodeURIComponent(code)}`;
  const date = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
  const signed = `${date}${env.BOKUN_ACCESS_KEY}GET${path}`;
  const signature = bytesToBase64(await hmac(env.BOKUN_SECRET_KEY, signed, 'SHA-1'));
  const response = await fetch(`${origin}${path}`, { headers: { 'X-Bokun-Date': date, 'X-Bokun-AccessKey': env.BOKUN_ACCESS_KEY, 'X-Bokun-Signature': signature, Accept: 'application/json' } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('integration_unavailable');
  return response.json();
};

export const verifyTurnstile = async (request, token, env) => {
  if (!env.TURNSTILE_SECRET_KEY) return true;
  const form = new FormData();
  form.set('secret', env.TURNSTILE_SECRET_KEY);
  form.set('response', String(token || ''));
  form.set('remoteip', request.headers.get('CF-Connecting-IP') || '');
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  return response.ok && Boolean((await response.json()).success);
};

export const rateLimit = async (request, env, limit = 10) => {
  if (!env.REVIEW_DB) throw new Error('integration_unavailable');
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const keyHash = await sha256(`${env.REVIEW_HASH_SALT || env.REVIEW_TOKEN_SECRET}:${ip}`);
  const windowStart = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
  await env.REVIEW_DB.prepare(`INSERT INTO review_attempts (key_hash, window_start, count) VALUES (?, ?, 1)
    ON CONFLICT(key_hash, window_start) DO UPDATE SET count = count + 1`).bind(keyHash, windowStart).run();
  const row = await env.REVIEW_DB.prepare('SELECT count FROM review_attempts WHERE key_hash = ? AND window_start = ?').bind(keyHash, windowStart).first();
  return Number(row?.count || 0) <= limit;
};

export const genericVerificationFailure = () => json({ message: 'We could not verify those details. Check the complete code and booking email, then try again after the tour.' }, 422);
