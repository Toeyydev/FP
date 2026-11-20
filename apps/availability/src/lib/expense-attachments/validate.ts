import { createHash } from "node:crypto";

// What may be attached to a Tour Expense row, judged from the bytes as well as the label.
// A browser's MIME type and a filename's extension are both claims; the first bytes of
// the file are what it is.

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export type AttachmentKind = { mime: "image/jpeg" | "image/png" | "image/webp" | "application/pdf"; ext: "jpg" | "png" | "webp" | "pdf" };

const KINDS: Record<AttachmentKind["ext"], AttachmentKind & { exts: string[]; mimes: string[] }> = {
  jpg: { mime: "image/jpeg", ext: "jpg", exts: ["jpg", "jpeg"], mimes: ["image/jpeg", "image/jpg", "image/pjpeg"] },
  png: { mime: "image/png", ext: "png", exts: ["png"], mimes: ["image/png"] },
  webp: { mime: "image/webp", ext: "webp", exts: ["webp"], mimes: ["image/webp"] },
  pdf: { mime: "application/pdf", ext: "pdf", exts: ["pdf"], mimes: ["application/pdf"] },
};

/** The kind the first bytes say the file is, or null. */
export function sniff(bytes: Uint8Array): AttachmentKind["ext"] | null {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return "png";
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "webp";
  if (b.length >= 5 && String.fromCharCode(...b.slice(0, 5)) === "%PDF-") return "pdf";
  return null;
}

export type FileCheck =
  | { ok: true; kind: AttachmentKind; name: string; sha256: string; size: number }
  | { ok: false; error: "empty" | "too-large" | "bad-type" | "type-mismatch" };

/**
 * Accept a file only when its bytes, its MIME type and its extension all agree on one of
 * JPEG, PNG, WebP or PDF, and it is not empty or over the limit.
 */
export function checkFile(bytes: Uint8Array, mime: string | null | undefined, originalName: string | null | undefined): FileCheck {
  if (!bytes.length) return { ok: false, error: "empty" };
  if (bytes.length > MAX_ATTACHMENT_BYTES) return { ok: false, error: "too-large" };
  const real = sniff(bytes);
  if (!real) return { ok: false, error: "bad-type" };
  const k = KINDS[real];
  const name = safeOriginalName(originalName, k.ext);
  const ext = (name.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? "").toLowerCase();
  const m = (mime ?? "").toLowerCase().trim();
  if (m && !k.mimes.includes(m)) return { ok: false, error: "type-mismatch" };
  if (ext && !k.exts.includes(ext)) return { ok: false, error: "type-mismatch" };
  return { ok: true, kind: { mime: k.mime, ext: k.ext }, name, sha256: sha256Hex(bytes), size: bytes.length };
}

export const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * The name the person gave the file, kept for display only: no folders, no control
 * characters, no leading dots, at most 120 characters. Never used as a path.
 */
export function safeOriginalName(name: string | null | undefined, fallbackExt: string): string {
  let n = String(name ?? "").normalize("NFC");
  n = n.split(/[\\/]/).pop() ?? "";
  n = n.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").replace(/^\.+/, "").replace(/\s+/g, " ").trim();
  if (!n) n = `receipt.${fallbackExt}`;
  if (n.length > 120) {
    const ext = n.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] ?? "";
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n;
}

/**
 * The file's name on Drive, in the job's folder: built only from values the server
 * controls (never the uploaded name), numbered in upload order for the job, and unique
 * by the content hash. e.g. Receipt_03_Grand-Palace_ab12cd34.pdf
 */
export function receiptFileName(o: { seq: number; description: string | null | undefined; sha256: string; ext: string }): string {
  const what = String(o.description ?? "").normalize("NFC").replace(/[^\p{L}\p{M}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "Expense";
  return `Receipt_${String(Math.max(1, o.seq)).padStart(2, "0")}_${what}_${o.sha256.slice(0, 8)}.${o.ext}`;
}
