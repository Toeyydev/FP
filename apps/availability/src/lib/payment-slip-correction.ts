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
// Three entry points, all for a signed-in ADMIN pressing a button on the admin page:
//
//   planSlipDetach       reads only. Everything the page shows before anyone confirms:
//                        the row now and after, the rightful guide's row (unchanged), the
//                        notices that would be withdrawn, the Drive name now and after, and
//                        every reason it would be refused.
//   detachMisattributedSlip
//                        the same checks again, then ONE transaction: the row back to
//                        PENDING without the slip, the unread notices linking that slip
//                        withdrawn, the rightful row proven unchanged, and the audit row
//                        with the actor, reason and before/after values. Drive is renamed
//                        only after that transaction has committed.
//   retrySlipRename      if the rename failed, do exactly the rename the correction
//                        recorded — same file id, same new name — and nothing else.
//
// The actor must be an ADMIN in the database at the moment of the write. There is no system
// actor: a correction that nobody signed in to make is not one this module will record.
//
// The Drive file is never deleted: it is the rightful guide's evidence.

type Db = PrismaClient;

export class SlipCorrectionRefused extends Error {
  constructor(public reasons: string[], public status = 409) {
    super(reasons[0] ?? "refused");
    this.name = "SlipCorrectionRefused";
  }
}
function refuse(reasons: string[], status = 409): never { throw new SlipCorrectionRefused(reasons, status); }

export type CorrectionActor = { id: string; name: string; role: string };

export type DriveFileMeta = { id: string; name: string; md5Checksum: string | null; trashed: boolean };
export type DriveOps = {
  meta(fileId: string): Promise<DriveFileMeta | null>;
  rename(fileId: string, name: string, description: string): Promise<DriveFileMeta>;
};

export type CorrectionTarget = {
  guideId: string;
  date: string;
  slotIdx: number;
  /** The TourPayment row as it was investigated. */
  tourPaymentId: string;
  /** The Drive file id of the slip wrongly attached to it. */
  driveFileId: string;
  /** Whose payment the slip really is: their job on the same departure. */
  rightfulGuideId: string;
};
export type CorrectionInput = CorrectionTarget & { reason: string };

export const MIN_REASON = 20;

export async function liveDrive(): Promise<DriveOps> {
  const refresh = await folkpathsDriveToken();
  const token = refresh ? await googleAccessToken(refresh) : null;
  if (!token) refuse(["ไม่สามารถเชื่อมต่อ Google Drive ของบริษัทได้ จึงตรวจสลิปไม่ได้"], 503);
  const auth = { authorization: `Bearer ${token}` };
  const fields = "id,name,md5Checksum,trashed";
  const parse = async (r: Response): Promise<DriveFileMeta> => {
    const j = (await r.json()) as { id: string; name: string; md5Checksum?: string; trashed?: boolean };
    return { id: j.id, name: j.name, md5Checksum: j.md5Checksum ?? null, trashed: Boolean(j.trashed) };
  };
  return {
    async meta(fileId) {
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=${fields}`, { headers: auth });
      return r.ok ? parse(r) : null;
    },
    async rename(fileId, name, description) {
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=${fields}`, {
        method: "PATCH", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ name, description }),
      });
      if (!r.ok) throw new Error(`Drive rename failed: HTTP ${r.status}`);
      return parse(r);
    },
  };
}

const PAYMENT_SELECT = {
  id: true, guideId: true, date: true, slotIdx: true, tourId: true, status: true, approvedBy: true, approvedAt: true, paidAt: true,
  peakRef: true, eslipUrl: true, slips: true, paidBatchNo: true, peakPaymentRef: true, peakDocumentId: true, guidePaymentId: true, updatedAt: true,
} satisfies Prisma.TourPaymentSelect;
type PaymentRow = Prisma.TourPaymentGetPayload<{ select: typeof PAYMENT_SELECT }>;

const bangkokDay = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** The values a correction changes, as they read — before, or as they will read after. */
export type PaymentValues = { status: string; paidAt: string | null; approvedBy: string | null; approvedAt: string | null; eslipUrl: string | null };
const valuesOf = (r: PaymentRow): PaymentValues => ({ status: r.status, paidAt: iso(r.paidAt), approvedBy: r.approvedBy, approvedAt: iso(r.approvedAt), eslipUrl: r.eslipUrl });
const AFTER: PaymentValues = { status: "PENDING", paidAt: null, approvedBy: null, approvedAt: null, eslipUrl: null };

/** The rename a correction asks for. Fixed at correction time, so a retry repeats it exactly. */
export type RenamePlan = { fileId: string; oldName: string; newName: string };
function renamePlan(t: CorrectionTarget, rightfulPeakRef: string | null, oldName: string, day: string): RenamePlan {
  const exp = rightfulPeakRef ? ` — ${rightfulPeakRef}` : "";
  return { fileId: t.driveFileId, oldName, newName: `${t.rightfulGuideId} — ${t.date} slot ${t.slotIdx}${exp} — e-slip (เคยแนบผิดกับ ${t.guideId} · แก้ ${day}).pdf` };
}
function renameDescription(t: { guideId: string; rightfulGuideId: string; date: string; slotIdx: number; peakRef: string | null; day: string; auditId: string; oldName: string }) {
  return [
    `สลิปการโอนให้ ${t.rightfulGuideId}${t.peakRef ? ` (${t.peakRef})` : ""} สำหรับงาน ${t.date} slot ${t.slotIdx}`,
    `เคยถูกแนบผิดกับงานของ ${t.guideId} และแก้แล้วเมื่อ ${t.day} (AuditLog pay.slip_detached ${t.auditId})`,
    `ชื่อเดิม: ${t.oldName}`,
    "เก็บไว้เป็นหลักฐาน ห้ามลบ",
  ].join("\n");
}

export type SlipPlan = {
  target: CorrectionTarget;
  canApply: boolean;
  problems: string[];
  jobRef: string | null;
  before: PaymentValues;
  after: PaymentValues;
  rightful: { guideId: string; tourPaymentId: string | null; status: string | null; peakRef: string | null; driveFileId: string | null; fileName: string | null };
  proof: { md5: string | null; sameBytes: boolean };
  notices: { id: string; kind: string; createdAt: string }[];
  drive: RenamePlan | null;
};

/**
 * Everything a correction would do, and every reason it would not — reading only.
 * `db` may be a transaction, so the correction can ask the same questions inside its own.
 */
async function inspect(t: CorrectionTarget, db: Db | Prisma.TransactionClient, drive: DriveOps | null, day: string) {
  const key = (guideId: string) => ({ guideId_date_slotIdx: { guideId, date: t.date, slotIdx: t.slotIdx } });
  const [row, rightful] = await Promise.all([
    db.tourPayment.findUnique({ where: key(t.guideId), select: PAYMENT_SELECT }),
    db.tourPayment.findUnique({ where: key(t.rightfulGuideId), select: PAYMENT_SELECT }),
  ]);
  if (!row) refuse(["ไม่พบแถวการจ่ายเงินของงานนี้"], 404);
  const problems: string[] = [];
  if (t.rightfulGuideId === t.guideId) problems.push("ไกด์ที่เป็นเจ้าของสลิปต้องเป็นคนละคนกับแถวที่จะแก้");
  if (row.id !== t.tourPaymentId) problems.push("แถวการจ่ายเงินไม่ใช่แถวที่ตรวจไว้ (id ไม่ตรง)");
  if (row.status !== "PAID") problems.push(`แถวนี้ไม่ได้อยู่ในสถานะ PAID (ตอนนี้ ${row.status})`);
  if (driveFileIdOf(row.eslipUrl) !== t.driveFileId) problems.push("สลิปที่ผูกกับแถวนี้ไม่ใช่ไฟล์ที่ตรวจไว้");
  if (Array.isArray(row.slips) && row.slips.length) problems.push("แถวนี้มีสลิปแบบแบ่งจ่าย ต้องแก้ผ่านขั้นตอนของสลิปแบ่งจ่าย");
  if (row.peakRef || row.peakPaymentRef || row.peakDocumentId) problems.push("แถวนี้ผูกกับเอกสาร PEAK แล้ว");
  if (row.guidePaymentId) problems.push("แถวนี้จ่ายผ่าน Payments v2 — ต้องกลับรายการที่การจ่ายเงินนั้น");
  if (row.paidBatchNo) problems.push(`แถวนี้อยู่ในชุดการจ่าย ${row.paidBatchNo}`);

  const [v2Jobs, batchItems, sheet, evidence, users] = await Promise.all([
    db.guidePaymentJob.count({ where: { guideId: t.guideId, date: t.date, slotIdx: t.slotIdx } }),
    db.paymentBatchItem.count({ where: { guideId: t.guideId, date: t.date, slotIdx: t.slotIdx } }),
    db.jobSheet.findUnique({ where: key(t.guideId), select: { id: true, ref: true, peakDocumentNo: true } }),
    db.paymentEvidence.count({ where: { googleDriveFileId: t.driveFileId } }),
    db.user.findMany({ where: { guideId: t.guideId }, select: { id: true } }),
  ]);
  if (v2Jobs) problems.push("งานนี้มีรายการใน Payments v2 — ต้องกลับรายการที่การจ่ายเงินนั้น");
  if (batchItems) problems.push("งานนี้อยู่ในชุดการจ่าย (payment batch)");
  if (sheet?.peakDocumentNo) problems.push(`ใบงานนี้ผูกกับเอกสาร PEAK ${sheet.peakDocumentNo}`);
  if (evidence) problems.push("สลิปนี้ถูกบันทึกเป็นหลักฐานการโอน (PaymentEvidence) แล้ว");
  if (sheet && (await db.paymentTransaction.count({ where: { matchedJobSheetId: sheet.id } }))) problems.push("งานนี้มีรายการโอนจากธนาคารที่จับคู่ไว้แล้ว");

  const rightfulFileId = driveFileIdOf(rightful?.eslipUrl);
  if (!rightful) problems.push(`ไม่พบแถวการจ่ายเงินของ ${t.rightfulGuideId} ในรอบเดียวกัน`);
  else {
    if (rightful.status !== "PAID") problems.push(`แถวของ ${t.rightfulGuideId} ไม่ได้อยู่ในสถานะ PAID`);
    if (!rightfulFileId) problems.push(`แถวของ ${t.rightfulGuideId} ไม่มีสลิป`);
    else if (rightfulFileId === t.driveFileId) problems.push(`แถวของ ${t.rightfulGuideId} ชี้ไปที่ไฟล์เดียวกัน — ถ้าถอดจะทำให้หลักฐานของเขาหาย`);
  }

  // Only this guide's own unread notices that point at this slip.
  const notices = users.length ? await db.notification.findMany({
    where: { userId: { in: users.map((u) => u.id) }, readAt: null, message: { contains: t.driveFileId } },
    select: { id: true, kind: true, createdAt: true }, orderBy: { createdAt: "asc" },
  }) : [];

  // The proof: the two slips are the same bytes.
  let wrong: DriveFileMeta | null = null, right: DriveFileMeta | null = null;
  if (drive && rightfulFileId && rightfulFileId !== t.driveFileId) {
    [wrong, right] = await Promise.all([drive.meta(t.driveFileId), drive.meta(rightfulFileId)]);
    if (!wrong || !right) problems.push("เปิดไฟล์สลิปใน Drive ไม่ได้ จึงยืนยันไม่ได้ว่าเป็นสลิปเดียวกัน");
    else if (wrong.trashed || right.trashed) problems.push("ไฟล์สลิปอยู่ในถังขยะของ Drive");
    else if (!wrong.md5Checksum || wrong.md5Checksum !== right.md5Checksum) problems.push(`สลิปบนแถวนี้ไม่ใช่ไฟล์เดียวกับสลิปของ ${t.rightfulGuideId} (md5 ไม่ตรง) จึงไม่แก้`);
  }
  const sameBytes = Boolean(wrong?.md5Checksum && wrong.md5Checksum === right?.md5Checksum);

  const plan: SlipPlan = {
    target: t,
    canApply: problems.length === 0,
    problems,
    jobRef: sheet?.ref ?? null,
    before: valuesOf(row),
    after: AFTER,
    rightful: { guideId: t.rightfulGuideId, tourPaymentId: rightful?.id ?? null, status: rightful?.status ?? null, peakRef: rightful?.peakRef ?? null, driveFileId: rightfulFileId, fileName: right?.name ?? null },
    proof: { md5: wrong?.md5Checksum ?? null, sameBytes },
    notices: notices.map((n) => ({ id: n.id, kind: n.kind, createdAt: n.createdAt.toISOString() })),
    drive: wrong ? renamePlan(t, rightful?.peakRef ?? null, wrong.name, day) : null,
  };
  return { plan, row, rightful };
}

/** What the page shows before anyone confirms. Reads only — no row, notice, audit or Drive write. */
export async function planSlipDetach(t: CorrectionTarget, deps: { db?: Db; drive?: DriveOps; now?: () => Date } = {}): Promise<SlipPlan> {
  const drive = deps.drive ?? (await liveDrive());
  return (await inspect(t, deps.db ?? prisma, drive, bangkokDay((deps.now ?? (() => new Date()))()))).plan;
}

/** The acting person, from the database: an ADMIN now, or nobody. */
async function assertAdmin(actor: CorrectionActor, db: Db | Prisma.TransactionClient): Promise<CorrectionActor> {
  if (!actor.id) refuse(["ต้องเข้าสู่ระบบในฐานะ ADMIN"], 403);
  const me = await db.user.findUnique({ where: { id: actor.id }, select: { id: true, role: true, fullName: true, displayName: true, email: true } });
  if (!me || me.role !== "ADMIN") refuse(["เฉพาะ ADMIN เท่านั้น"], 403);
  return { id: me.id, role: me.role, name: (me.fullName || me.displayName || me.email || me.id).trim() };
}

export type DriveOutcome = { status: "RENAMED" | "FAILED" | "ALREADY_RENAMED"; fileId: string; oldName: string; newName: string; error: string | null; retry: string | null };
export type CorrectionResult = { tourPaymentId: string; status: "PENDING"; revokedNotificationIds: string[]; auditId: string; drive: DriveOutcome };

const RETRY_HINT = "ฐานข้อมูลแก้เรียบร้อยแล้ว เหลือเพียงการเปลี่ยนชื่อไฟล์ใน Drive — กด \"ลองเปลี่ยนชื่อไฟล์อีกครั้ง\" ได้อย่างปลอดภัย: ใช้ไฟล์เดิม (file id เดิม) และชื่อใหม่เดิมที่บันทึกไว้ ไม่สร้างหรือลบไฟล์ และจะไม่แก้ฐานข้อมูลซ้ำ";

export async function detachMisattributedSlip(input: CorrectionInput, actorIn: CorrectionActor, deps: { db?: Db; drive?: DriveOps; now?: () => Date } = {}): Promise<CorrectionResult> {
  const db = deps.db ?? prisma;
  const at = (deps.now ?? (() => new Date()))();
  const day = bangkokDay(at);
  const reason = input.reason.trim();
  if (reason.length < MIN_REASON) refuse([`ต้องระบุเหตุผลการแก้ไขอย่างน้อย ${MIN_REASON} ตัวอักษร`], 400);
  const actor = await assertAdmin(actorIn, db);

  // Drive is asked first (it cannot be asked inside a transaction), then everything is asked
  // again inside the transaction, where the answer is the one the write acts on.
  const drive = deps.drive ?? (await liveDrive());
  const first = await inspect(input, db, drive, day);
  if (!first.plan.canApply) refuse(first.plan.problems);
  const rename = first.plan.drive!;

  const result = await db.$transaction(async (tx) => {
    await assertAdmin(actor, tx);
    const again = await inspect(input, tx, null, day);
    const moved = again.plan.problems.length ? { count: 0 } : await tx.tourPayment.updateMany({
      where: { id: first.row.id, status: "PAID", eslipUrl: first.row.eslipUrl, updatedAt: first.row.updatedAt, peakRef: null, peakPaymentRef: null, guidePaymentId: null, paidBatchNo: null },
      data: { status: AFTER.status, paidAt: null, approvedBy: null, approvedAt: null, eslipUrl: null },
    });
    if (moved.count !== 1) refuse(["แถวการจ่ายเงินเปลี่ยนไประหว่างตรวจ จึงไม่ได้แก้อะไร — โหลดหน้านี้ใหม่แล้วตรวจอีกครั้ง"]);

    const noticeIds = again.plan.notices.map((n) => n.id);
    if (noticeIds.length) await tx.notification.deleteMany({ where: { id: { in: noticeIds }, readAt: null } });

    const rightfulAfter = await tx.tourPayment.findUnique({ where: { id: first.rightful!.id }, select: PAYMENT_SELECT });
    if (JSON.stringify(rightfulAfter) !== JSON.stringify(first.rightful)) refuse(["แถวของไกด์เจ้าของสลิปเปลี่ยนระหว่างแก้ จึงยกเลิกทั้งหมด"]);

    const log = await tx.auditLog.create({ data: {
      actorId: actor.id, actorRole: actor.role, action: "pay.slip_detached", entityType: "TourPayment", entityId: first.row.id,
      detail: {
        guideId: input.guideId, date: input.date, slotIdx: input.slotIdx, jobRef: first.plan.jobRef,
        actorName: actor.name, correctedAt: at.toISOString(), reason,
        before: first.plan.before, after: AFTER,
        rightful: { ...first.plan.rightful, fileName: undefined, unchanged: true },
        proof: first.plan.proof,
        revokedNotifications: again.plan.notices,
        drive: { ...rename, kept: true },
      } as Prisma.InputJsonValue,
    } });
    return { auditId: log.id, noticeIds };
  });

  // Only now, with the correction committed, does Drive change.
  const outcome = await applyRename(db, drive, actor, {
    rename, auditId: result.auditId, tourPaymentId: first.row.id,
    description: renameDescription({ guideId: input.guideId, rightfulGuideId: input.rightfulGuideId, date: input.date, slotIdx: input.slotIdx, peakRef: first.plan.rightful.peakRef, day, auditId: result.auditId, oldName: rename.oldName }),
  });
  return { tourPaymentId: first.row.id, status: "PENDING", revokedNotificationIds: result.noticeIds, auditId: result.auditId, drive: outcome };
}

async function applyRename(db: Db, drive: DriveOps, actor: CorrectionActor, o: { rename: RenamePlan; auditId: string; tourPaymentId: string; description: string; retry?: boolean }): Promise<DriveOutcome> {
  const base = { fileId: o.rename.fileId, oldName: o.rename.oldName, newName: o.rename.newName };
  try {
    const after = await drive.rename(o.rename.fileId, o.rename.newName, o.description);
    if (after.id !== o.rename.fileId) throw new Error("Drive returned a different file id");
    await db.auditLog.create({ data: {
      actorId: actor.id, actorRole: actor.role, action: "drive.slip_renamed", entityType: "TourPayment", entityId: o.tourPaymentId,
      detail: { ...base, newName: after.name, sameFileId: true, descriptionSet: true, correctionAuditId: o.auditId, actorName: actor.name, retry: Boolean(o.retry) } as Prisma.InputJsonValue,
    } });
    return { status: "RENAMED", ...base, newName: after.name, error: null, retry: null };
  } catch (e) {
    const error = (e as Error).message.slice(0, 200);
    await db.auditLog.create({ data: {
      actorId: actor.id, actorRole: actor.role, action: "drive.slip_rename_failed", entityType: "TourPayment", entityId: o.tourPaymentId,
      detail: { ...base, error, correctionAuditId: o.auditId, actorName: actor.name, retry: Boolean(o.retry) } as Prisma.InputJsonValue,
    } });
    return { status: "FAILED", ...base, error, retry: RETRY_HINT };
  }
}

/** The correction recorded for this row, and whether its rename is done. Reads only. */
export async function renameState(tourPaymentId: string, db: Db = prisma) {
  const corr = await db.auditLog.findFirst({ where: { action: "pay.slip_detached", entityType: "TourPayment", entityId: tourPaymentId }, orderBy: { createdAt: "desc" } });
  if (!corr) return null;
  const done = await db.auditLog.findFirst({ where: { action: "drive.slip_renamed", entityType: "TourPayment", entityId: tourPaymentId }, orderBy: { createdAt: "desc" } });
  const d = corr.detail as { drive: RenamePlan; guideId: string; rightful: { guideId: string; peakRef: string | null }; date: string; slotIdx: number; correctedAt: string };
  return { auditId: corr.id, correctedAt: d.correctedAt, rename: { fileId: d.drive.fileId, oldName: d.drive.oldName, newName: d.drive.newName }, renamed: Boolean(done && (done.detail as { correctionAuditId?: string }).correctionAuditId === corr.id), detail: d };
}

/**
 * Repeat the rename a correction recorded — the same file id, the same new name — and only
 * that. Refused when there is no correction, when it is already renamed, or when the file
 * now carries a name that is neither the old one nor the new one (somebody renamed it by
 * hand; overwriting that is a decision for a person, not a retry).
 */
export async function retrySlipRename(tourPaymentId: string, actorIn: CorrectionActor, deps: { db?: Db; drive?: DriveOps } = {}): Promise<DriveOutcome> {
  const db = deps.db ?? prisma;
  const actor = await assertAdmin(actorIn, db);
  const state = await renameState(tourPaymentId, db);
  if (!state) refuse(["ยังไม่มีการแก้ไขที่บันทึกไว้สำหรับแถวนี้ จึงไม่มีอะไรให้ลองใหม่"], 404);
  if (state.renamed) refuse(["ไฟล์นี้เปลี่ยนชื่อเรียบร้อยแล้ว ไม่ต้องทำซ้ำ"]);
  const drive = deps.drive ?? (await liveDrive());
  const now = await drive.meta(state.rename.fileId);
  if (!now) refuse(["เปิดไฟล์ใน Drive ไม่ได้ ลองใหม่ภายหลัง"], 503);
  if (now.trashed) refuse(["ไฟล์อยู่ในถังขยะของ Drive — กู้คืนก่อน ห้ามสร้างไฟล์ใหม่แทน"]);
  const d = state.detail;
  if (now.name === state.rename.newName) {
    await db.auditLog.create({ data: {
      actorId: actor.id, actorRole: actor.role, action: "drive.slip_renamed", entityType: "TourPayment", entityId: tourPaymentId,
      detail: { ...state.rename, sameFileId: true, correctionAuditId: state.auditId, actorName: actor.name, retry: true, alreadyRenamed: true } as Prisma.InputJsonValue,
    } });
    return { status: "ALREADY_RENAMED", ...state.rename, error: null, retry: null };
  }
  if (now.name !== state.rename.oldName) refuse([`ชื่อไฟล์ใน Drive ตอนนี้ไม่ใช่ทั้งชื่อเดิมและชื่อใหม่ (มีคนเปลี่ยนเอง) จึงไม่เขียนทับ: "${now.name}"`]);
  return applyRename(db, drive, actor, {
    rename: state.rename, auditId: state.auditId, tourPaymentId, retry: true,
    description: renameDescription({ guideId: d.guideId, rightfulGuideId: d.rightful.guideId, date: d.date, slotIdx: d.slotIdx, peakRef: d.rightful.peakRef, day: bangkokDay(new Date(d.correctedAt)), auditId: state.auditId, oldName: state.rename.oldName }),
  });
}
