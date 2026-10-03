// Is the file attached to an expense row a ticket/receipt — or a bank transfer slip?
//
// A row paid from a company advance sometimes carries the slip of the advance going OUT
// (owner case 2026-10-04: three temple tickets each "receipted" with the transfer slip).
// That slip proves the company sent money to the guide; it says nothing about the ticket
// the money bought, so the row still needs a ticket or a certificate in lieu of receipt.
//
// The file is read in-process with the slip reader (lib/advances/slip-read — PDF text
// layer, no OCR, no network beyond Drive itself). A K BIZ transfer slip is TRANSFER_SLIP;
// anything else, photos included, is DOCUMENT — never guessed to be a slip. The answer is
// kept by Drive file id (ReceiptClassification), outside the row the browser round-trips.
import type { PrismaClient } from "@prisma/client";
import { audit } from "@/lib/audit";
import { readSlip } from "@/lib/advances/slip-read";
import { downloadDriveFile, folkpathsDriveToken } from "@/lib/google-drive";
import { advanceFundedConfirmed } from "@/lib/certificates/payload";
import type { Expense } from "@/lib/jobsheet";

export type ReceiptKind = "TRANSFER_SLIP" | "DOCUMENT";
type Row = Expense & { receiptUrl?: string | null; receiptFileId?: string | null };
type Db = Pick<PrismaClient, "receiptClassification">;

export async function classifyBytes(bytes: Uint8Array, mime: string | null | undefined, name?: string | null): Promise<{ kind: ReceiptKind; txRef: string | null }> {
  const r = await readSlip(bytes, mime, name);
  return r.ok ? { kind: "TRANSFER_SLIP", txRef: r.read.transactionId } : { kind: "DOCUMENT", txRef: null };
}

export async function recordClassification(db: Db, fileId: string, c: { kind: ReceiptKind; txRef: string | null }, checkedBy: string | null) {
  await db.receiptClassification.upsert({ where: { fileId }, create: { fileId, kind: c.kind, txRef: c.txRef, checkedBy }, update: { kind: c.kind, txRef: c.txRef, checkedBy, checkedAt: new Date() } });
}

const fileIdsOf = (rows: readonly Row[]) => [...new Set(rows.map((r) => String(r.receiptFileId ?? "").trim()).filter(Boolean))];

/** The attachments on these rows already known to be transfer slips. */
export async function transferSlipFileIds(db: Db, rows: readonly Row[]): Promise<Set<string>> {
  const ids = fileIdsOf(rows);
  if (!ids.length || !db.receiptClassification?.findMany) return new Set();
  const found = await db.receiptClassification.findMany({ where: { fileId: { in: ids }, kind: "TRANSFER_SLIP" }, select: { fileId: true } });
  return new Set(found.map((f) => f.fileId));
}

/** Advance-paid rows whose attachment has not been looked at yet. */
export async function uncheckedAdvanceAttachments(db: Db, rows: readonly Row[]): Promise<Row[]> {
  const candidates = rows.filter((r) => advanceFundedConfirmed(r) && String(r.receiptFileId ?? "").trim() && String(r.receiptUrl ?? "").trim());
  if (!candidates.length) return [];
  const known = new Set((await db.receiptClassification.findMany({ where: { fileId: { in: fileIdsOf(candidates) } }, select: { fileId: true } })).map((k) => k.fileId));
  return candidates.filter((r) => !known.has(String(r.receiptFileId)));
}

/**
 * An admin's "check the attachments" on one job sheet: read each unchecked advance-paid
 * attachment from Drive and record what it is. Reads Drive; writes only classifications
 * and an audit row — never the job sheet.
 */
export async function checkSheetAttachments(db: PrismaClient, key: { guideId: string; date: string; slotIdx: number }, actor: { actorId: string | null; actorRole: string | null }) {
  const sheet = await db.jobSheet.findUnique({ where: { guideId_date_slotIdx: key }, select: { id: true, ref: true, expenses: true } });
  if (!sheet) return { ok: false as const, status: 404, reasons: ["No such job sheet"] };
  const rows = ((sheet.expenses as unknown as Row[]) ?? []);
  const todo = await uncheckedAdvanceAttachments(db, rows);
  if (!todo.length) return { ok: true as const, checked: 0, transferSlips: 0, unreadable: 0 };
  const token = await folkpathsDriveToken(actor.actorId ?? undefined);
  if (!token) return { ok: false as const, status: 503, reasons: ["Connect the company Google Drive first"] };
  let slips = 0, unreadable = 0;
  const results: { fileId: string; kind: ReceiptKind | "UNREADABLE"; txRef: string | null }[] = [];
  for (const r of todo) {
    const fileId = String(r.receiptFileId);
    const file = await downloadDriveFile(token, String(r.receiptUrl)).catch(() => null);
    if (!file) { unreadable++; results.push({ fileId, kind: "UNREADABLE", txRef: null }); continue; }
    const c = await classifyBytes(new Uint8Array(Buffer.from(file.base64, "base64")), file.mime, file.name);
    await recordClassification(db, fileId, c, actor.actorId);
    if (c.kind === "TRANSFER_SLIP") slips++;
    results.push({ fileId, kind: c.kind, txRef: c.txRef });
  }
  await audit({ ...actor, action: "certificate.attachments_checked", entityType: "JobSheet", entityId: sheet.id, detail: { jobRef: sheet.ref, results } });
  return { ok: true as const, checked: todo.length - unreadable, transferSlips: slips, unreadable };
}
