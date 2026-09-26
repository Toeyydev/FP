import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { driveFileIdOf, folkpathsDriveToken } from "@/lib/google-drive";
import { googleAccessToken } from "@/lib/google-calendar";

// Taking a payment slip off the job it was wrongly attached to.
//
// Before Payments v2, "upload e-slip" saved a slip to Drive and marked the job PAID in one
// step, with no amount. A slip uploaded to the wrong guide's job therefore made that job
// read as paid, and sent that guide a "your payment has been transferred" notice linking to
// somebody else's transfer. The retired path cannot do it again; this repairs a row it did.
//
// It is deliberately narrow. The caller names the exact row, the exact slip file on it, and
// the guide whose payment the slip really is — and every one of those is checked again
// against the database and Drive before anything moves:
//
//   - the row is PAID by that slip and nothing else: no PEAK reference or document, no
//     Payments v2 payment, no batch, no split slips, no recorded bank transaction
//   - the rightful guide's job on the same departure is PAID with a slip whose bytes are
//     identical (Drive md5) — the proof that this is their transfer, not this guide's
//
// Then, in one transaction: the row goes back to PENDING with the slip link removed, the
// unread notices to this guide that link that slip are withdrawn, and the audit row that
// records the previous values is written. The rightful guide's row is read before and after
// and must be byte-identical, or the whole thing rolls back.
//
// The Drive file is never deleted: it is the rightful guide's evidence. It may be renamed
// in place (same file id, so every link keeps working) to say whose transfer it is and that
// it was once attached to the wrong job; the old and new names are audited.

type Db = PrismaClient;

export class SlipCorrectionRefused extends Error {
  constructor(public reasons: string[], public status = 409) {
    super(reasons[0] ?? "refused");
    this.name = "SlipCorrectionRefused";
  }
}
function refuse(reasons: string[], status = 409): never { throw new SlipCorrectionRefused(reasons, status); }

export type CorrectionActor = { id: string | null; name: string; role: string };

export type DriveFileMeta = { id: string; name: string; md5Checksum: string | null; trashed: boolean };
export type DriveOps = {
  meta(fileId: string): Promise<DriveFileMeta | null>;
  rename(fileId: string, name: string, description: string): Promise<DriveFileMeta>;
};

export type CorrectionInput = {
  guideId: string;
  date: string;
  slotIdx: number;
  /** The TourPayment row as it was investigated. */
  tourPaymentId: string;
  /** The Drive file id of the slip wrongly attached to it. */
  driveFileId: string;
  /** Whose payment the slip really is: their job on the same departure. */
  rightfulGuideId: string;
  reason: string;
  renameDriveFile: boolean;
};

export const MIN_REASON = 20;

export async function liveDrive(): Promise<DriveOps> {
  const refresh = await folkpathsDriveToken();
  const token = refresh ? await googleAccessToken(refresh) : null;
  if (!token) refuse(["ไม่สามารถเชื่อมต่อ Google Drive ของบริษัทได้ จึงตรวจสลิปไม่ได้"], 503);
  const auth = { authorization: `Bearer ${token}` };
  const fields = "id,name,md5Checksum,trashed";
  return {
    async meta(fileId) {
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=${fields}`, { headers: auth });
      if (!r.ok) return null;
      const j = (await r.json()) as { id: string; name: string; md5Checksum?: string; trashed?: boolean };
      return { id: j.id, name: j.name, md5Checksum: j.md5Checksum ?? null, trashed: Boolean(j.trashed) };
    },
    async rename(fileId, name, description) {
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=${fields}`, {
        method: "PATCH", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ name, description }),
      });
      if (!r.ok) throw new Error(`Drive rename failed: HTTP ${r.status}`);
      const j = (await r.json()) as { id: string; name: string; md5Checksum?: string; trashed?: boolean };
      return { id: j.id, name: j.name, md5Checksum: j.md5Checksum ?? null, trashed: Boolean(j.trashed) };
    },
  };
}

const PAYMENT_SELECT = {
  id: true, guideId: true, date: true, slotIdx: true, tourId: true, status: true, approvedBy: true, approvedAt: true, paidAt: true,
  peakRef: true, eslipUrl: true, slips: true, paidBatchNo: true, peakPaymentRef: true, peakDocumentId: true, guidePaymentId: true, updatedAt: true,
} satisfies Prisma.TourPaymentSelect;

const bangkokDay = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);

export type CorrectionResult = {
  tourPaymentId: string;
  status: "PENDING";
  revokedNotificationIds: string[];
  drive: { renamed: boolean; fileId: string; oldName: string; newName: string | null; error: string | null };
  auditId: string;
};

export async function detachMisattributedSlip(
  input: CorrectionInput,
  actor: CorrectionActor,
  deps: { db?: Db; drive?: DriveOps; now?: () => Date } = {},
): Promise<CorrectionResult> {
  const db = deps.db ?? prisma;
  const now = deps.now ?? (() => new Date());
  const reason = input.reason.trim();
  if (reason.length < MIN_REASON) refuse([`ต้องระบุเหตุผลการแก้ไขอย่างน้อย ${MIN_REASON} ตัวอักษร`], 400);
  if (input.rightfulGuideId === input.guideId) refuse(["ไกด์ที่เป็นเจ้าของสลิปต้องเป็นคนละคนกับแถวที่จะแก้"], 400);

  // ── what is there now, read before Drive is asked anything ────────────────
  const key = (guideId: string) => ({ guideId_date_slotIdx: { guideId, date: input.date, slotIdx: input.slotIdx } });
  const [row, rightful] = await Promise.all([
    db.tourPayment.findUnique({ where: key(input.guideId), select: PAYMENT_SELECT }),
    db.tourPayment.findUnique({ where: key(input.rightfulGuideId), select: PAYMENT_SELECT }),
  ]);
  if (!row) refuse(["ไม่พบแถวการจ่ายเงินของงานนี้"], 404);
  const problems: string[] = [];
  if (row.id !== input.tourPaymentId) problems.push("แถวการจ่ายเงินไม่ใช่แถวที่ตรวจไว้ (id ไม่ตรง)");
  if (row.status !== "PAID") problems.push(`แถวนี้ไม่ได้อยู่ในสถานะ PAID (ตอนนี้ ${row.status})`);
  if (driveFileIdOf(row.eslipUrl) !== input.driveFileId) problems.push("สลิปที่ผูกกับแถวนี้ไม่ใช่ไฟล์ที่ตรวจไว้");
  if (Array.isArray(row.slips) && row.slips.length) problems.push("แถวนี้มีสลิปแบบแบ่งจ่าย ต้องแก้ผ่านขั้นตอนของสลิปแบ่งจ่าย");
  if (row.peakRef || row.peakPaymentRef || row.peakDocumentId) problems.push("แถวนี้ผูกกับเอกสาร PEAK แล้ว");
  if (row.guidePaymentId) problems.push("แถวนี้จ่ายผ่าน Payments v2 — ต้องกลับรายการที่การจ่ายเงินนั้น");
  if (row.paidBatchNo) problems.push(`แถวนี้อยู่ในชุดการจ่าย ${row.paidBatchNo}`);

  const [v2Jobs, batchItems, sheet, evidence] = await Promise.all([
    db.guidePaymentJob.count({ where: { guideId: input.guideId, date: input.date, slotIdx: input.slotIdx } }),
    db.paymentBatchItem.count({ where: { guideId: input.guideId, date: input.date, slotIdx: input.slotIdx } }),
    db.jobSheet.findUnique({ where: key(input.guideId), select: { id: true, ref: true, peakDocumentNo: true } }),
    db.paymentEvidence.findMany({ where: { googleDriveFileId: input.driveFileId }, select: { id: true } }),
  ]);
  if (v2Jobs) problems.push("งานนี้มีรายการใน Payments v2 — ต้องกลับรายการที่การจ่ายเงินนั้น");
  if (batchItems) problems.push("งานนี้อยู่ในชุดการจ่าย (payment batch)");
  if (sheet?.peakDocumentNo) problems.push(`ใบงานนี้ผูกกับเอกสาร PEAK ${sheet.peakDocumentNo}`);
  if (evidence.length) problems.push("สลิปนี้ถูกบันทึกเป็นหลักฐานการโอน (PaymentEvidence) แล้ว");
  if (sheet) {
    const tx = await db.paymentTransaction.count({ where: { matchedJobSheetId: sheet.id } });
    if (tx) problems.push("งานนี้มีรายการโอนจากธนาคารที่จับคู่ไว้แล้ว");
  }

  if (!rightful) problems.push(`ไม่พบแถวการจ่ายเงินของ ${input.rightfulGuideId} ในรอบเดียวกัน`);
  else {
    if (rightful.status !== "PAID") problems.push(`แถวของ ${input.rightfulGuideId} ไม่ได้อยู่ในสถานะ PAID`);
    const rightfulFile = driveFileIdOf(rightful.eslipUrl);
    if (!rightfulFile) problems.push(`แถวของ ${input.rightfulGuideId} ไม่มีสลิป`);
    else if (rightfulFile === input.driveFileId) problems.push(`แถวของ ${input.rightfulGuideId} ชี้ไปที่ไฟล์เดียวกัน — ถ้าถอดจะทำให้หลักฐานของเขาหาย`);
  }
  if (problems.length) refuse(problems);

  // ── the proof: the two slips are the same bytes ───────────────────────────
  const drive = deps.drive ?? (await liveDrive());
  const rightfulFileId = driveFileIdOf(rightful!.eslipUrl)!;
  const [wrong, right] = await Promise.all([drive.meta(input.driveFileId), drive.meta(rightfulFileId)]);
  if (!wrong || !right) refuse(["เปิดไฟล์สลิปใน Drive ไม่ได้ จึงยืนยันไม่ได้ว่าเป็นสลิปเดียวกัน"]);
  if (wrong.trashed || right.trashed) refuse(["ไฟล์สลิปอยู่ในถังขยะของ Drive"]);
  if (!wrong.md5Checksum || wrong.md5Checksum !== right.md5Checksum) {
    refuse([`สลิปบนแถวนี้ไม่ใช่ไฟล์เดียวกับสลิปของ ${input.rightfulGuideId} (md5 ไม่ตรง) จึงไม่แก้`]);
  }

  // ── the correction, and its record, together ──────────────────────────────
  const at = now();
  const result = await db.$transaction(async (tx) => {
    const rightfulBefore = JSON.stringify(await tx.tourPayment.findUnique({ where: { id: rightful!.id } }));
    const moved = await tx.tourPayment.updateMany({
      where: { id: row.id, status: "PAID", eslipUrl: row.eslipUrl, updatedAt: row.updatedAt, peakRef: null, peakPaymentRef: null, guidePaymentId: null, paidBatchNo: null },
      data: { status: "PENDING", paidAt: null, approvedBy: null, approvedAt: null, eslipUrl: null },
    });
    if (moved.count !== 1) refuse(["แถวการจ่ายเงินเปลี่ยนไประหว่างตรวจ จึงไม่ได้แก้อะไร — โหลดใหม่แล้วตรวจอีกครั้ง"]);

    // Only this guide's own unread notices that point at this slip.
    const users = await tx.user.findMany({ where: { guideId: input.guideId }, select: { id: true } });
    const notices = users.length ? await tx.notification.findMany({
      where: { userId: { in: users.map((u) => u.id) }, readAt: null, message: { contains: input.driveFileId } },
      select: { id: true, kind: true, createdAt: true },
    }) : [];
    if (notices.length) await tx.notification.deleteMany({ where: { id: { in: notices.map((n) => n.id) }, readAt: null } });

    const rightfulAfter = JSON.stringify(await tx.tourPayment.findUnique({ where: { id: rightful!.id } }));
    if (rightfulAfter !== rightfulBefore) refuse(["แถวของไกด์เจ้าของสลิปเปลี่ยนระหว่างแก้ จึงยกเลิกทั้งหมด"]);

    const log = await tx.auditLog.create({ data: {
      actorId: actor.id, actorRole: actor.role, action: "pay.slip_detached", entityType: "TourPayment", entityId: row.id,
      detail: {
        guideId: input.guideId, date: input.date, slotIdx: input.slotIdx, jobRef: sheet?.ref ?? null,
        reason, actorName: actor.name, correctedAt: at.toISOString(),
        previous: { status: row.status, paidAt: row.paidAt?.toISOString() ?? null, approvedBy: row.approvedBy, eslipUrl: row.eslipUrl, driveFileId: input.driveFileId },
        now: { status: "PENDING", paidAt: null, eslipUrl: null },
        rightful: { guideId: input.rightfulGuideId, tourPaymentId: rightful!.id, driveFileId: rightfulFileId, peakRef: rightful!.peakRef, unchanged: true },
        proof: { md5: wrong.md5Checksum, sameBytes: true },
        revokedNotifications: notices.map((n) => ({ id: n.id, kind: n.kind, createdAt: n.createdAt.toISOString() })),
        driveFileKept: true,
      } as Prisma.InputJsonValue,
    } });
    return { notices, auditId: log.id };
  });

  // ── Drive: rename in place, never delete ──────────────────────────────────
  const out: CorrectionResult["drive"] = { renamed: false, fileId: input.driveFileId, oldName: wrong.name, newName: null, error: null };
  if (input.renameDriveFile) {
    const day = bangkokDay(at);
    const exp = rightful!.peakRef ? ` — ${rightful!.peakRef}` : "";
    const newName = `${input.rightfulGuideId} — ${input.date} slot ${input.slotIdx}${exp} — e-slip (เคยแนบผิดกับ ${input.guideId} · แก้ ${day}).pdf`;
    const description = [
      `สลิปการโอนให้ ${input.rightfulGuideId}${rightful!.peakRef ? ` (${rightful!.peakRef})` : ""} สำหรับงาน ${input.date} slot ${input.slotIdx}`,
      `เคยถูกแนบผิดกับงานของ ${input.guideId} และแก้แล้วเมื่อ ${day} (AuditLog pay.slip_detached ${result.auditId})`,
      `ชื่อเดิม: ${wrong.name}`,
      "เก็บไว้เป็นหลักฐาน ห้ามลบ",
    ].join("\n");
    try {
      const after = await drive.rename(input.driveFileId, newName, description);
      if (after.id !== input.driveFileId) throw new Error("Drive returned a different file id");
      out.renamed = true;
      out.newName = after.name;
      await db.auditLog.create({ data: {
        actorId: actor.id, actorRole: actor.role, action: "drive.slip_renamed", entityType: "TourPayment", entityId: row.id,
        detail: { fileId: input.driveFileId, oldName: wrong.name, newName: after.name, descriptionSet: true, sameFileId: true, correctionAuditId: result.auditId, actorName: actor.name } as Prisma.InputJsonValue,
      } });
    } catch (e) {
      out.error = (e as Error).message.slice(0, 200);
      await db.auditLog.create({ data: {
        actorId: actor.id, actorRole: actor.role, action: "drive.slip_rename_failed", entityType: "TourPayment", entityId: row.id,
        detail: { fileId: input.driveFileId, oldName: wrong.name, error: out.error, correctionAuditId: result.auditId, actorName: actor.name } as Prisma.InputJsonValue,
      } });
    }
  }

  return { tourPaymentId: row.id, status: "PENDING", revokedNotificationIds: result.notices.map((n) => n.id), drive: out, auditId: result.auditId };
}
