import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma as defaultDb } from "@/lib/db";
import { audit } from "@/lib/audit";
import { driveMonth } from "@/lib/drive-month";
import { isApproved, type Expense } from "@/lib/jobsheet";
import { isAccountant, isOps } from "@/lib/roles";
import { ensureRowIds, isRowId } from "@/lib/expense-row-id";
import { checkFile, driveFileName } from "@/lib/expense-attachments/validate";

// Files behind Tour Expense rows: several per row, filed by the row's stable id.
//
// Who may do what (checked here, on the server, whatever the screen shows):
//   GUIDE       sees and adds files on their OWN job only; removes only a file they added,
//               and only while the job is not approved.
//   OPERATOR /  see, add and remove on every job.
//   ADMIN
//   ACCOUNTANT  sees every job's files; adds and removes nothing.
//
// A file never changes an amount. The first live file on a row is mirrored into the
// row's legacy receipt* fields so everything that already reads "does this row have a
// receipt" (evidence, certificates, PEAK) keeps reading the same place.

export type Actor = { id: string | null; role: string | null | undefined; guideId?: string | null };
export type DriveSaver = {
  token(actorId: string | null): Promise<string | null>;
  save(o: { refreshToken: string; name: string; base64: string; mimeType: string; folderPath: string[] }): Promise<{ id: string; link: string; folderId?: string | null }>;
};
type Db = PrismaClient;
type Row = Expense & { receiptUrl?: string | null; receiptFileId?: string | null; receiptName?: string | null; receiptAt?: string | null; receiptBy?: string | null };
type SheetKey = { guideId: string; date: string; slotIdx: number };

export const canView = (a: Actor, sheetGuideId: string) => isOps(a.role) || isAccountant(a.role) || (a.role === "GUIDE" && !!a.guideId && a.guideId === sheetGuideId);
export const canAdd = (a: Actor, sheetGuideId: string) => isOps(a.role) || (a.role === "GUIDE" && !!a.guideId && a.guideId === sheetGuideId);
export function canRemove(a: Actor, sheet: { guideId: string; approvalStatus: string | null }, att: { uploadedById: string | null }): boolean {
  if (isOps(a.role)) return true;
  return a.role === "GUIDE" && !!a.guideId && a.guideId === sheet.guideId && !!a.id && att.uploadedById === a.id && !isApproved(sheet.approvalStatus);
}

const STALL_MS = 5 * 60_000; // an upload still "in flight" after this died with its request
export const RECEIPT_FIELDS = ["receiptUrl", "receiptFileId", "receiptName", "receiptAt", "receiptBy"] as const;

export type LiveFile = { driveFileId: string | null; driveLink: string | null; originalName: string; uploadedAt: Date; uploadedById: string | null };

/**
 * The row with its legacy receipt fields pointing at a live file. A row whose legacy
 * receipt is one of these attachments that was removed is repointed (or cleared); a row
 * with a legacy receipt from before attachments existed is left exactly as it is.
 */
export function mirrorRow<T extends Row>(row: T, live: readonly LiveFile[], removedFileIds: ReadonlySet<string>): T {
  const current = (row.receiptFileId ?? "").trim();
  const stillGood = current && !removedFileIds.has(current);
  if (stillGood) return row;
  const first = live.find((f) => f.driveFileId && f.driveLink);
  const out = { ...row } as Row;
  if (!current && !first) return row;
  for (const f of RECEIPT_FIELDS) delete out[f];
  if (first) {
    out.receiptUrl = first.driveLink!;
    out.receiptFileId = first.driveFileId!;
    out.receiptName = first.originalName.slice(0, 200);
    out.receiptAt = first.uploadedAt.toISOString();
    if (first.uploadedById) out.receiptBy = first.uploadedById;
  }
  return out as T;
}

/** Apply mirrorRow to every row that has attachments, from what the table holds now. */
export async function mirrorAll<T extends Row>(db: Db | Prisma.TransactionClient, jobSheetId: string, rows: readonly T[]): Promise<T[]> {
  if (!db.expenseAttachment?.findMany) return [...rows]; // a stand-in client without the table
  const atts = await db.expenseAttachment.findMany({
    where: { jobSheetId, status: { in: ["UPLOADED", "REMOVED"] } },
    orderBy: { uploadedAt: "asc" },
    select: { expenseRowId: true, status: true, driveFileId: true, driveLink: true, originalName: true, uploadedAt: true, uploadedById: true },
  });
  if (!atts.length) return [...rows];
  const removed = new Set(atts.filter((a) => a.status === "REMOVED" && a.driveFileId).map((a) => a.driveFileId!));
  return rows.map((r) => {
    if (!r.rowId) return r;
    const live = atts.filter((a) => a.expenseRowId === r.rowId && a.status === "UPLOADED");
    return mirrorRow(r, live, removed);
  });
}

/** Rewrite a sheet's rows with a guard on updatedAt; a few retries if someone saved meanwhile. */
async function rewriteRows(db: Db, sheetId: string, change: (rows: Row[]) => Row[] | null): Promise<boolean> {
  for (let i = 0; i < 4; i++) {
    const s = await db.jobSheet.findUnique({ where: { id: sheetId }, select: { expenses: true, updatedAt: true } });
    if (!s) return false;
    const next = change(((s.expenses as unknown as Row[]) ?? []));
    if (!next) return true;
    const hit = await db.jobSheet.updateMany({ where: { id: sheetId, updatedAt: s.updatedAt }, data: { expenses: next as unknown as Prisma.InputJsonValue } });
    if (hit.count) return true;
  }
  return false;
}

/** The row's stable id, giving the row one if it has none yet. Null when the row is gone. */
async function rowIdFor(db: Db, sheetId: string, by: { rowId?: string | null; index?: number | null }): Promise<string | null> {
  const s = await db.jobSheet.findUnique({ where: { id: sheetId }, select: { expenses: true } });
  const rows = ((s?.expenses as unknown as Row[]) ?? []);
  if (by.rowId) return rows.some((r) => r?.rowId === by.rowId) ? by.rowId : null;
  const i = by.index ?? -1;
  if (!(i >= 0 && i < rows.length)) return null;
  if (isRowId(rows[i]?.rowId) && rows.filter((r) => r?.rowId === rows[i].rowId).length === 1) return rows[i].rowId!;
  // Give every row its id in one write, then read the one at the index back. The row at
  // the index is the one the person was looking at only if nobody reordered meanwhile, so
  // check its description too.
  const want = rows[i]?.description ?? "";
  let assigned: string | null = null;
  const ok = await rewriteRows(db, sheetId, (cur) => {
    if (!(i < cur.length) || (cur[i]?.description ?? "") !== want) { assigned = null; return null; }
    const { rows: withIds, added } = ensureRowIds(cur);
    assigned = withIds[i].rowId ?? null;
    return added ? withIds : null;
  });
  return ok ? assigned : null;
}

const safeErr = (e: unknown): string => {
  const m = String((e as Error)?.message ?? "");
  if (/drive-auth/.test(m)) return "drive-auth";
  const st = m.match(/drive-upload (\d{3})/)?.[1];
  return st ? `drive-${st}` : "drive-failed";
};

export type UploadResult =
  | { ok: true; attachment: Awaited<ReturnType<Db["expenseAttachment"]["findUniqueOrThrow"]>>; retried: boolean }
  | { ok: false; status: number; error: string; existing?: { rowId: string; name: string } };

export async function uploadAttachment(o: {
  db?: Db; drive: DriveSaver; actor: Actor; sheet: SheetKey;
  rowId?: string | null; expenseIndex?: number | null;
  file: { bytes: Uint8Array; mime?: string | null; name?: string | null };
  amountSatang?: number | null; documentDate?: string | null;
}, now: Date = new Date()): Promise<UploadResult> {
  const db = o.db ?? defaultDb;
  const sheet = await db.jobSheet.findUnique({ where: { guideId_date_slotIdx: o.sheet }, select: { id: true, ref: true, guideId: true, date: true, slotIdx: true, approvalStatus: true } });
  if (!sheet) return { ok: false, status: 404, error: "no-sheet" };
  if (!canAdd(o.actor, sheet.guideId)) return { ok: false, status: 403, error: "forbidden" };

  const fc = checkFile(o.file.bytes, o.file.mime, o.file.name);
  if (!fc.ok) return { ok: false, status: 400, error: fc.error };

  const rowId = await rowIdFor(db, sheet.id, { rowId: o.rowId, index: o.expenseIndex });
  if (!rowId) return { ok: false, status: 404, error: "row-not-found" };
  const rows = ((await db.jobSheet.findUnique({ where: { id: sheet.id }, select: { expenses: true } }))?.expenses as unknown as Row[]) ?? [];
  const row = rows.find((r) => r.rowId === rowId);
  const jobRef = sheet.ref ?? `${sheet.guideId}-${sheet.date}-${sheet.slotIdx}`;
  const base = { actorId: o.actor.id, actorRole: o.actor.role ?? null, entityType: "JobSheet", entityId: sheet.id };
  const what = { ref: jobRef, rowId, name: fc.name, size: fc.size, mime: fc.kind.mime, sha256: fc.sha256 };

  // Claim the file for this job. A failed earlier try of the same file on the same row is
  // picked up as a retry; a live copy anywhere on the job is a duplicate.
  let attId: string;
  let retried = false;
  const failed = await db.expenseAttachment.findFirst({ where: { jobSheetId: sheet.id, expenseRowId: rowId, sha256: fc.sha256, status: "FAILED" }, orderBy: { updatedAt: "desc" } });
  const stalled = await db.expenseAttachment.findFirst({ where: { jobSheetId: sheet.id, sha256: fc.sha256, status: "UPLOADING", updatedAt: { lt: new Date(now.getTime() - STALL_MS) } } });
  if (stalled) await db.expenseAttachment.update({ where: { id: stalled.id }, data: { status: "FAILED", errorCode: "stalled" } });
  try {
    if (failed || (stalled && stalled.expenseRowId === rowId)) {
      const prev = failed ?? stalled!;
      const r = await db.expenseAttachment.update({ where: { id: prev.id }, data: { status: "UPLOADING", errorCode: null, attempts: { increment: 1 }, uploadedById: o.actor.id, uploadedByRole: o.actor.role ?? null } });
      attId = r.id; retried = true;
    } else {
      const r = await db.expenseAttachment.create({ data: {
        jobSheetId: sheet.id, expenseRowId: rowId, jobRef, category: (row?.expenseType || row?.description || "").slice(0, 120) || null,
        amountSatang: o.amountSatang ?? null, documentDate: o.documentDate ?? null,
        originalName: fc.name, mimeType: fc.kind.mime, sizeBytes: fc.size, sha256: fc.sha256,
        status: "UPLOADING", uploadedById: o.actor.id, uploadedByRole: o.actor.role ?? null, uploadedAt: now,
      } });
      attId = r.id;
    }
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const live = await db.expenseAttachment.findFirst({ where: { jobSheetId: sheet.id, sha256: fc.sha256, status: { in: ["UPLOADING", "UPLOADED"] } }, select: { expenseRowId: true, originalName: true } });
      await audit({ ...base, action: "jobsheet.attachment_duplicate", detail: { ...what, existingRowId: live?.expenseRowId ?? null } });
      return { ok: false, status: 409, error: "duplicate", existing: live ? { rowId: live.expenseRowId, name: live.originalName } : undefined };
    }
    throw e;
  }
  await audit({ ...base, action: retried ? "jobsheet.attachment_retry" : "jobsheet.attachment_upload_started", detail: what });

  const fail = async (code: string, status: number): Promise<UploadResult> => {
    await db.expenseAttachment.update({ where: { id: attId }, data: { status: "FAILED", errorCode: code } });
    await audit({ ...base, action: "jobsheet.attachment_failed", detail: { ...what, errorCode: code } });
    return { ok: false, status, error: code };
  };

  const token = await o.drive.token(o.actor.id).catch(() => null);
  if (!token) return fail("drive-not-connected", 400);
  let up: { id: string; link: string; folderId?: string | null };
  try {
    up = await o.drive.save({
      refreshToken: token,
      name: driveFileName({ jobRef, rowId, at: now, sha256: fc.sha256, ext: fc.kind.ext }),
      base64: Buffer.from(o.file.bytes).toString("base64"), mimeType: fc.kind.mime,
      folderPath: ["Folkpaths Job Sheets", ...driveMonth(sheet.date), jobRef, "Receipts"],
    });
  } catch (e) {
    return fail(safeErr(e), 502);
  }
  const attachment = await db.expenseAttachment.update({ where: { id: attId }, data: { status: "UPLOADED", driveFileId: up.id, driveLink: up.link, driveFolderId: up.folderId ?? null, errorCode: null } });
  await audit({ ...base, action: "jobsheet.attachment_uploaded", detail: { ...what, driveFileId: up.id, attempts: attachment.attempts } });
  await rewriteRows(db, sheet.id, (cur) => {
    const next = cur.map((r) => (r.rowId === rowId ? mirrorRow(r, [attachment], new Set()) : r));
    return next.some((r, i) => r !== cur[i]) ? next : null;
  });
  return { ok: true, attachment, retried };
}

export async function removeAttachment(o: { db?: Db; actor: Actor; id: string; reason: string }): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const db = o.db ?? defaultDb;
  const reason = (o.reason ?? "").trim();
  if (reason.length < 3) return { ok: false, status: 400, error: "reason-required" };
  const att = await db.expenseAttachment.findUnique({ where: { id: o.id }, include: { jobSheet: { select: { id: true, guideId: true, approvalStatus: true, ref: true } } } });
  if (!att || att.status === "REMOVED") return { ok: false, status: 404, error: "not-found" };
  if (!canRemove(o.actor, att.jobSheet, att)) return { ok: false, status: 403, error: "forbidden" };
  await db.expenseAttachment.update({ where: { id: att.id }, data: { status: "REMOVED", removedById: o.actor.id, removedAt: new Date(), removeReason: reason.slice(0, 500) } });
  await audit({ actorId: o.actor.id, actorRole: o.actor.role ?? null, action: "jobsheet.attachment_removed", entityType: "JobSheet", entityId: att.jobSheetId,
    detail: { ref: att.jobRef, rowId: att.expenseRowId, attachmentId: att.id, name: att.originalName, driveFileId: att.driveFileId, reason: reason.slice(0, 500), driveFileKept: true } });
  // Repoint the row's legacy receipt if it was this file.
  const sheetId = att.jobSheetId;
  const live = await db.expenseAttachment.findMany({ where: { jobSheetId: sheetId, expenseRowId: att.expenseRowId, status: "UPLOADED" }, orderBy: { uploadedAt: "asc" } });
  const removed = new Set(att.driveFileId ? [att.driveFileId] : []);
  await rewriteRows(db, sheetId, (cur) => {
    const next = cur.map((r) => (r.rowId === att.expenseRowId ? mirrorRow(r, live, removed) : r));
    return next.some((r, i) => r !== cur[i]) ? next : null;
  });
  return { ok: true };
}

export type AttachmentView = { id: string; rowId: string; name: string; mime: string; size: number; link: string | null; uploadedAt: string; uploadedByRole: string | null; mine: boolean; removable: boolean };

/** Live files on a sheet, grouped by row id, for someone allowed to see them. */
export async function attachmentsFor(db: Db, sheet: { id: string; guideId: string; approvalStatus: string | null }, actor: Actor): Promise<Record<string, AttachmentView[]>> {
  if (!canView(actor, sheet.guideId)) return {};
  if (!db.expenseAttachment?.findMany) return {};
  const rows = await db.expenseAttachment.findMany({ where: { jobSheetId: sheet.id, status: "UPLOADED" }, orderBy: { uploadedAt: "asc" } });
  const out: Record<string, AttachmentView[]> = {};
  for (const a of rows) {
    (out[a.expenseRowId] ??= []).push({
      id: a.id, rowId: a.expenseRowId, name: a.originalName, mime: a.mimeType, size: a.sizeBytes, link: a.driveLink,
      uploadedAt: a.uploadedAt.toISOString(), uploadedByRole: a.uploadedByRole, mine: !!actor.id && a.uploadedById === actor.id,
      removable: canRemove(actor, sheet, a),
    });
  }
  return out;
}
