import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

// AES-256-GCM encryption for PII at rest (Tax ID, bank details, uploaded documents).
// Key is derived from AUTH_SECRET so there's no extra env var to manage.
// Format: base64(iv[12] | authTag[16] | ciphertext).
//
// Guard: in production we refuse to fall back to the hard-coded dev key, because
// that would make all encrypted PII trivially decryptable. Set AUTH_SECRET
// (openssl rand -base64 33) in the production environment.
//
// IMPORTANT: this guard is evaluated LAZILY, on first cryptographic use — NOT at
// module import. `next build` walks the module graph of every route ("collect page
// data"); a throw at import time there fails the whole build. Any service that
// imports this module (e.g. the payment worker) but never sets AUTH_SECRET and
// never encrypts must be able to load it cleanly. `decrypt` stays non-throwing.
let cachedKey: Buffer | null = null;
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  if (process.env.NODE_ENV === "production" && !process.env.AUTH_SECRET) {
    throw new Error("AUTH_SECRET must be set in production — it derives the PII encryption key.");
  }
  cachedKey = scryptSync(process.env.AUTH_SECRET || "dev-secret-change-me", "folkpath-enc-v1", 32);
  return cachedKey;
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

export function decrypt(payload: string | null | undefined): string {
  if (!payload) return "";
  try {
    const buf = Buffer.from(payload, "base64");
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), data = buf.subarray(28);
    const d = createDecipheriv("aes-256-gcm", getKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString("utf8");
  } catch {
    return "";
  }
}

export function encryptBuffer(buf: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

export function decryptBuffer(buf: Buffer): Buffer {
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), data = buf.subarray(28);
  const d = createDecipheriv("aes-256-gcm", getKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]);
}

// Encrypt a value only if present; returns null for empty so we don't store blanks.
export const encOpt = (v?: string | null) => (v && v.trim() ? encrypt(v.trim()) : null);
