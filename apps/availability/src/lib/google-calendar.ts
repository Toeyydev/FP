// Google Calendar OAuth + event CRUD. One-way sync (app → calendar); the app is
// the source of truth. Set on Railway: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.
// Redirect URI in the Google Cloud console must be:
//   https://guide.folkpaths.com/api/google/callback
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
export const googleEnabled = Boolean(CLIENT_ID && CLIENT_SECRET);

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const REDIRECT = (host: string) => `https://${host}/api/google/callback`;

export function authUrl(host: string, state: string): string {
  const p = new URLSearchParams({
    client_id: CLIENT_ID!, redirect_uri: REDIRECT(host), response_type: "code",
    scope: SCOPE, access_type: "offline", prompt: "consent", state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

// Exchange the OAuth code for tokens. Returns refreshToken (+ the account email).
export async function exchangeCode(host: string, code: string): Promise<{ refreshToken: string | null; accessToken: string; email: string | null }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID!, client_secret: CLIENT_SECRET!, code, grant_type: "authorization_code", redirect_uri: REDIRECT(host) }),
  });
  const j = await res.json();
  let email: string | null = null;
  try { if (j.id_token) email = JSON.parse(Buffer.from(j.id_token.split(".")[1], "base64").toString()).email ?? null; } catch { /* ignore */ }
  return { refreshToken: j.refresh_token ?? null, accessToken: j.access_token, email };
}

async function accessToken(refreshToken: string): Promise<string | null> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID!, client_secret: CLIENT_SECRET!, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  if (!res.ok) return null;
  return (await res.json()).access_token ?? null;
}

export type CalEvent = {
  summary: string; description?: string; location?: string;
  start: { dateTime: string; timeZone: string }; end: { dateTime: string; timeZone: string };
  reminders?: { useDefault: false; overrides: { method: string; minutes: number }[] };
};

export async function insertEvent(refreshToken: string, calendarId: string, event: CalEvent): Promise<string | null> {
  const tok = await accessToken(refreshToken); if (!tok) return null;
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify(event),
  });
  if (!res.ok) return null;
  return (await res.json()).id ?? null;
}

export async function patchEvent(refreshToken: string, calendarId: string, eventId: string, event: Partial<CalEvent>): Promise<boolean> {
  const tok = await accessToken(refreshToken); if (!tok) return false;
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`, {
    method: "PATCH", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify(event),
  });
  return res.ok;
}

export async function deleteEvent(refreshToken: string, calendarId: string, eventId: string): Promise<boolean> {
  const tok = await accessToken(refreshToken); if (!tok) return false;
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`, {
    method: "DELETE", headers: { authorization: `Bearer ${tok}` },
  });
  return res.ok || res.status === 410; // 410 = already gone
}
