import { prisma as defaultDb } from "@/lib/db";
import { audit } from "@/lib/audit";
import { driveMonth } from "@/lib/drive-month";
import { folkpathsDriveToken, renameDriveFile, saveBufferToDrive } from "@/lib/google-drive";
import type { ExpenseCertificate, PrismaClient } from "@prisma/client";

// A READING copy of a filed certificate in the job's own folder, beside its receipts
// (owner, 2026-11-06: one folder per job, to trace it back later). The document of
// record stays the private one in Folkpaths Finance — attestation, read-back checks,
// PEAK and payment all keep using that. This copy is best-effort: if it fails, filing
// has still succeeded, and it is audited either way. Never throws.

export type JobCopyDeps = {
  db?: PrismaClient;
  token?: () => Promise<string | null>;
  save?: typeof saveBufferToDrive;
  rename?: (token: string, fileId: string, name: string) => Promise<void>;
};

const folderFor = (c: Pick<ExpenseCertificate, "jobRef" | "guideId" | "tourDate" | "slotIdx">) =>
  ["Folkpaths Job Sheets", ...driveMonth(c.tourDate), c.jobRef ?? `${c.guideId}-${c.tourDate}-${c.slotIdx}`];

export async function copyCertificateToJobFolder(cert: ExpenseCertificate, pdf: Uint8Array, deps: JobCopyDeps = {}): Promise<void> {
  const db = deps.db ?? defaultDb;
  const base = { actorId: null, actorRole: "SYSTEM", entityType: "ExpenseCertificate", entityId: cert.id };
  try {
    const token = await (deps.token ?? (() => folkpathsDriveToken()))();
    if (!token) { await audit({ ...base, action: "certificate.job_copy_skipped", detail: { certificateNo: cert.certificateNo, why: "drive-not-connected" } }); return; }
    const up = await (deps.save ?? saveBufferToDrive)({ refreshToken: token, name: `${cert.certificateNo}.pdf`, base64: Buffer.from(pdf).toString("base64"), mimeType: "application/pdf", folderPath: folderFor(cert) });
    await db.expenseCertificate.update({ where: { id: cert.id }, data: { jobCopyFileId: up.id, jobCopyLink: up.link, jobCopyAt: new Date() } });
    await audit({ ...base, action: "certificate.job_copy_saved", detail: { certificateNo: cert.certificateNo, driveFileId: up.id, folder: folderFor(cert).join(" / ") } });
  } catch (e) {
    const m = String((e as Error)?.message ?? "");
    await audit({ ...base, action: "certificate.job_copy_failed", detail: { certificateNo: cert.certificateNo, errorCode: m.match(/drive-upload (\d{3})/)?.[1] ? `drive-${m.match(/drive-upload (\d{3})/)![1]}` : /drive-auth/.test(m) ? "drive-auth" : "drive-failed" } });
  }
}

/** A voided certificate's copy is renamed VOID_… so nobody reads it as in force. Never throws. */
export async function markJobCopyVoid(cert: ExpenseCertificate, deps: JobCopyDeps = {}): Promise<void> {
  if (!cert.jobCopyFileId) return;
  const base = { actorId: null, actorRole: "SYSTEM", entityType: "ExpenseCertificate", entityId: cert.id };
  try {
    const token = await (deps.token ?? (() => folkpathsDriveToken()))();
    if (!token) return;
    await (deps.rename ?? renameDriveFile)(token, cert.jobCopyFileId, `VOID_${cert.certificateNo}.pdf`);
    await audit({ ...base, action: "certificate.job_copy_voided", detail: { certificateNo: cert.certificateNo, driveFileId: cert.jobCopyFileId } });
  } catch {
    await audit({ ...base, action: "certificate.job_copy_void_failed", detail: { certificateNo: cert.certificateNo, driveFileId: cert.jobCopyFileId } });
  }
}
