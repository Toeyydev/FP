import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { mayAttest } from "@/lib/certificates/attester";
import { resolveSignature, type SignatureDeps } from "@/lib/certificates/signature";
import type { VoucherApprover } from "./voucher";

// Whose signature goes in "Approved by" on an advance voucher.
//
// The admin who RECORDED the advance — recording it is the approval, done by that person,
// so it is their own hand on their own act. It is the same registered signature that goes
// on a certificate in lieu of a receipt, read and checked the same way every time
// (lib/certificates/signature: still private, still the registered bytes).
//
// Nobody else's signature is ever borrowed: an advance recorded by someone who is not an
// authorised signer, or who has no signature on file, gets a voucher with the line left
// blank, exactly as before.
export async function voucherApprover(recordedById: string | null, deps: SignatureDeps & { db?: PrismaClient } = {}): Promise<VoucherApprover | null> {
  if (!recordedById) return null;
  const db = deps.db ?? prisma;
  const u = await db.user.findUnique({ where: { id: recordedById }, select: { role: true, email: true, state: true, fullName: true, displayName: true } });
  if (!u || u.state !== "ACTIVE" || !mayAttest({ role: u.role, email: u.email })) return null;
  const sig = await resolveSignature(recordedById, deps, recordedById);
  if (!sig.ok) return null;
  return { name: (u.fullName || u.displayName || "").trim() || "Admin", signatureDataUri: sig.signature.dataUri };
}
