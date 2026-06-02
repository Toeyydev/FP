import { createHmac, timingSafeEqual } from "crypto";

// LINE Messaging API. Configured via env (set on Railway):
//   LINE_CHANNEL_SECRET        — verifies incoming webhook signatures
//   LINE_CHANNEL_ACCESS_TOKEN  — authorizes outgoing push/reply
const SECRET = process.env.LINE_CHANNEL_SECRET || "";
const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
export const lineEnabled = Boolean(SECRET && TOKEN);

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

export function lineReply(replyToken: string, text: string) {
  return lineApi("message/reply", { replyToken, messages: [{ type: "text", text }] });
}
export function linePush(to: string, text: string) {
  return lineApi("message/push", { to, messages: [{ type: "text", text }] });
}
