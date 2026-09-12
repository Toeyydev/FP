import { googleDriveEnabled, folkpathsDriveToken, saveBufferToDrive } from "@/lib/google-drive";

/**
 * The transfer slip that goes with a cash movement on a job — the company's
 * advance out, or the guide's return of what they didn't spend.
 *
 * Lifted out of /api/jobsheet/advance so FolkOPS Mobile files a slip into exactly
 * the same Drive folder, named the same way. Evidence that lands somewhere else is
 * evidence nobody finds.
 */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const OK_TYPES = /^(image\/(jpeg|jpg|png|webp)|application\/pdf)$/i;
export const MAX_SLIP_BYTES = 10 * 1024 * 1024;

const extOf = (mime: string) => (mime.includes("png") ? "png" : mime.includes("pdf") ? "pdf" : mime.includes("webp") ? "webp" : "jpg");

/** What a slip looks like whether it arrived from a browser form or a phone. */
export type SlipFile = { size?: number; type?: string; name?: string; arrayBuffer?: () => Promise<ArrayBuffer> };

export type SlipUpload = { url: string; fileId: string };
export type SlipFailure = { error: string; status: number };

export async function uploadSlip(userId: string | undefined, file: SlipFile, name: string, date: string): Promise<SlipUpload | SlipFailure> {
  const mime = file.type || "image/jpeg";
  if (!OK_TYPES.test(mime)) return { error: "bad-type", status: 400 };
  if ((file.size ?? 0) > MAX_SLIP_BYTES) return { error: "too-large", status: 400 };
  if (!googleDriveEnabled) return { error: "not-configured", status: 400 };
  const refreshToken = await folkpathsDriveToken(userId);
  if (!refreshToken) return { error: "not-connected", status: 400 };
  const base64 = Buffer.from(await file.arrayBuffer!()).toString("base64");
  const monthFolder = `${date.slice(0, 7)} ${MONTHS[Number(date.slice(5, 7)) - 1] ?? ""}`.trim();
  try {
    const up = await saveBufferToDrive({ refreshToken, name: `${name}.${extOf(mime)}`, base64, mimeType: mime, folderPath: ["Folkpaths Job Sheets", monthFolder, "Advances"] });
    return { url: up.link, fileId: up.id };
  } catch (e) {
    return { error: `drive-failed: ${(e as Error).message.slice(0, 160)}`, status: 502 };
  }
}
