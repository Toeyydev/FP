import { prisma } from "@/lib/db";
import { encryptBuffer } from "@/lib/crypto";

// Store a payment slip (bank e-slip / bonus slip) in our own DB and return a stable
// in-app URL ("/api/eslip/<id>"). Replaces the previous Google Drive storage — same
// eslipUrl contract on the owning row, bytes AES-encrypted at rest.
export async function saveEslip(opts: { base64: string; mimeType: string; filename?: string | null; replaceUrl?: string | null }): Promise<{ id: string; link: string }> {
  const raw = Buffer.from(opts.base64, "base64");
  const row = await prisma.eslip.create({
    data: { data: new Uint8Array(encryptBuffer(raw)), mimeType: opts.mimeType, filename: opts.filename ?? null, size: raw.length },
  });
  // A re-upload replaces the previous slip: drop the old row so blobs don't pile up.
  // Only ever deletes our own /api/eslip rows — old Google Drive links are left alone.
  const oldId = eslipIdFromUrl(opts.replaceUrl);
  if (oldId && oldId !== row.id) await prisma.eslip.delete({ where: { id: oldId } }).catch(() => {});
  return { id: row.id, link: `/api/eslip/${row.id}` };
}

// Extract the Eslip id from an in-app eslipUrl ("/api/eslip/<id>"). Returns null for
// legacy Google Drive links (https://...) or empty input, so those are never touched.
export function eslipIdFromUrl(url?: string | null): string | null {
  const m = /^\/api\/eslip\/([A-Za-z0-9_-]+)/.exec((url || "").trim());
  return m ? m[1] : null;
}
