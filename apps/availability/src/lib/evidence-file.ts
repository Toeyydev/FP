import crypto from "crypto";
import { prisma } from "@/lib/db";
import { driveMonth } from "@/lib/drive-month";
import { folkpathsDriveToken, googleDriveEnabled, saveBufferToDrive } from "@/lib/google-drive";

// File one slip or statement to the Folkpaths Drive and record it as PaymentEvidence — the one way
// a correction gets evidence it can cite by id. The same file twice is the same evidence.

export type Upload = { size?: number; type?: string; name?: string; arrayBuffer?: () => Promise<ArrayBuffer> };
export type FiledEvidence = { ok: true; evidenceId: string; url: string } | { ok: false; status: number; reason: string };

const extOf = (mime: string) => (mime.includes("png") ? "png" : mime.includes("pdf") ? "pdf" : mime.includes("webp") ? "webp" : "jpg");

export async function fileEvidence(f: Upload | null, opts: { actorId: string; date: string; label: string; evidenceType: "K_BIZ_SLIP" | "BANK_STATEMENT" | "OTHER"; guideId?: string | null }): Promise<FiledEvidence> {
  if (!f || typeof f.arrayBuffer !== "function" || !(f.size ?? 0)) return { ok: false, status: 400, reason: "Attach the slip or statement" };
  if ((f.size ?? 0) > 10 * 1024 * 1024) return { ok: false, status: 400, reason: "The file is over 10 MB" };
  const mime = f.type || "image/jpeg";
  if (!/^image\//.test(mime) && mime !== "application/pdf") return { ok: false, status: 400, reason: "A slip or statement must be an image or a PDF" };
  if (!googleDriveEnabled) return { ok: false, status: 400, reason: "Connect Google Drive first — evidence is filed there" };
  const refreshToken = await folkpathsDriveToken(opts.actorId);
  if (!refreshToken) return { ok: false, status: 400, reason: "Connect the Folkpaths Google account first" };
  const bytes = Buffer.from(await f.arrayBuffer());
  const fileHash = crypto.createHash("sha256").update(bytes).digest("hex");
  const prior = await prisma.paymentEvidence.findFirst({ where: { fileHash }, select: { id: true, driveLink: true } });
  if (prior) return { ok: true, evidenceId: prior.id, url: prior.driveLink ?? "" };
  const name = `${opts.date} ${opts.label} ${fileHash.slice(0, 8)}.${extOf(mime)}`;
  let link: string, fileId: string;
  try {
    ({ link, id: fileId } = await saveBufferToDrive({ refreshToken, name, base64: bytes.toString("base64"), mimeType: mime, folderPath: ["Folkpaths E-slips", ...driveMonth(opts.date)] }));
  } catch (e) {
    return { ok: false, status: 502, reason: `Could not file it in Drive: ${(e as Error).message.slice(0, 160)}` };
  }
  const ev = await prisma.paymentEvidence.create({ data: {
    guideId: opts.guideId ?? null, evidenceType: opts.evidenceType, googleDriveFileId: fileId, fileHash, driveLink: link, originalFilename: name, mimeType: mime,
    fileSize: bytes.length, slipUploadedAt: new Date(), slipUploadedBy: opts.actorId, extractionMethod: "MANUAL_CORRECTION", processingStatus: "COMPLETED",
  }, select: { id: true } });
  return { ok: true, evidenceId: ev.id, url: link };
}
