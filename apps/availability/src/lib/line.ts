import { createHmac, timingSafeEqual } from "crypto";

// LINE Messaging API. Configured via env (set on Railway):
//   LINE_CHANNEL_SECRET        — verifies incoming webhook signatures
//   LINE_CHANNEL_ACCESS_TOKEN  — authorizes outgoing push/reply
const SECRET = process.env.LINE_CHANNEL_SECRET || "";
const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
export const lineEnabled = Boolean(SECRET && TOKEN);

// LINE Login (separate channel) — lets a guide link in one tap via OAuth instead of
// sending a code. Set LINE_LOGIN_CHANNEL_ID + LINE_LOGIN_CHANNEL_SECRET on Railway,
// and register the callback https://<host>/api/line/login/callback in the channel.
const LOGIN_ID = process.env.LINE_LOGIN_CHANNEL_ID || "";
const LOGIN_SECRET = process.env.LINE_LOGIN_CHANNEL_SECRET || "";
export const lineLoginEnabled = Boolean(LOGIN_ID && LOGIN_SECRET);
export function lineLoginConfig(): { id: string; secret: string } { return { id: LOGIN_ID, secret: LOGIN_SECRET }; }

export function verifyLineSignature(rawBody: string, signature: string | null): boolean {
  if (!SECRET || !signature) return false;
  const hash = createHmac("sha256", SECRET).update(rawBody).digest("base64");
  const a = Buffer.from(hash), b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function lineApi(path: string, body: unknown): Promise<void> {
  if (!TOKEN) { console.log(`[line:stub] ${path}`, JSON.stringify(body)); return; }
  try {
    const r = await fetch(`https://api.line.me/v2/bot/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    });
    if (!r.ok) console.error("[line:error]", r.status, await r.text().catch(() => ""));
  } catch (e) {
    console.error("[line:error]", (e as Error).message);
  }
}

// Fetch a follower's LINE profile (display name + photo) by their userId. Only
// works for users who have added the OA. Returns null on any failure so callers
// can degrade gracefully.
export async function lineGetProfile(userId: string): Promise<{ displayName: string | null; pictureUrl: string | null } | null> {
  if (!TOKEN || !userId) return null;
  try {
    const r = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { displayName?: string; pictureUrl?: string };
    return { displayName: j.displayName ?? null, pictureUrl: j.pictureUrl ?? null };
  } catch { return null; }
}

// List the OA's follower userIds (one page). Only Verified/Premium accounts may
// call this — a normal OA gets 403, which we surface as { ok:false, forbidden }.
// Used for an optional one-off backfill of guides who added the OA before capture
// existed. No profile data here (names come from lineGetProfile).
export async function lineGetFollowerIds(start?: string): Promise<{ ok: boolean; forbidden?: boolean; userIds: string[]; next?: string }> {
  if (!TOKEN) return { ok: false, userIds: [] };
  try {
    const q = new URLSearchParams({ limit: "300", ...(start ? { start } : {}) });
    const r = await fetch(`https://api.line.me/v2/bot/followers/ids?${q}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    if (r.status === 403) return { ok: false, forbidden: true, userIds: [] };
    if (!r.ok) return { ok: false, userIds: [] };
    const j = (await r.json()) as { userIds?: string[]; next?: string };
    return { ok: true, userIds: j.userIds ?? [], next: j.next };
  } catch { return { ok: false, userIds: [] }; }
}

export function lineReply(replyToken: string, text: string) {
  return lineApi("message/reply", { replyToken, messages: [{ type: "text", text }] });
}
export function linePush(to: string, text: string) {
  return lineApi("message/push", { to, messages: [{ type: "text", text }] });
}

// Push a LINE Flex message (a rich JSON bubble — e.g. the payment table). `altText`
// is what shows in the chat list / on clients that can't render Flex, so keep the
// plain-text summary there as a graceful fallback.
export function linePushFlex(to: string, altText: string, contents: object) {
  return lineApi("message/push", { to, messages: [{ type: "flex", altText: altText.slice(0, 400), contents }] });
}

type PostbackAction = { label: string; data: string; displayText?: string };
// Push a buttons template with tappable postback actions (e.g. Accept / Deny).
// `text` is the body shown above the buttons (max ~160 chars).
export function linePushButtons(to: string, altText: string, text: string, actions: PostbackAction[]) {
  return lineApi("message/push", {
    to,
    messages: [{
      type: "template",
      altText,
      template: {
        type: "buttons",
        text: text.slice(0, 160),
        actions: actions.map((a) => ({ type: "postback", label: a.label.slice(0, 20), data: a.data, displayText: a.displayText })),
      },
    }],
  });
}
// Reply to a postback/message with a buttons template.
export function lineReplyButtons(replyToken: string, altText: string, text: string, actions: PostbackAction[]) {
  return lineApi("message/reply", {
    replyToken,
    messages: [{
      type: "template",
      altText,
      template: { type: "buttons", text: text.slice(0, 160), actions: actions.map((a) => ({ type: "postback", label: a.label.slice(0, 20), data: a.data, displayText: a.displayText })) },
    }],
  });
}
