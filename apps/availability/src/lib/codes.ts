import { randomBytes } from "crypto";

// Unambiguous alphabet (no 0/O/1/I/L).
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function randStr(len: number): string {
  const b = randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}

// Invite code shown to the user is `selector-secret`. The selector is an indexed
// lookup; only a bcrypt hash of the secret is stored.
export function newInviteParts() {
  const selector = randStr(6);
  const secret = randStr(10);
  return { selector, secret, code: `${selector}-${secret}` };
}

export function parseInviteCode(code: string): { selector: string; secret: string } | null {
  const cleaned = (code || "").trim().toUpperCase();
  const i = cleaned.indexOf("-");
  if (i < 0) return null;
  const selector = cleaned.slice(0, i).trim();
  const secret = cleaned.slice(i + 1).replace(/-/g, "").trim();
  if (!selector || !secret) return null;
  return { selector, secret };
}

export function newOtpCode(): string {
  return String(randomBytes(4).readUInt32BE(0) % 1000000).padStart(6, "0");
}

export function maskEmail(email: string): string {
  const [u, d] = email.split("@");
  if (!d) return "•••";
  const head = u.length <= 2 ? u[0] ?? "•" : `${u[0]}${"•".repeat(Math.min(u.length - 2, 4))}${u[u.length - 1]}`;
  return `${head}@${d}`;
}
