import { Prisma, type PrismaClient, type JobSheet } from "@prisma/client";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { expenseAmount, isReviewExpense, type Expense } from "@/lib/jobsheet";
import { canonicalPaidBy } from "@/lib/peak-sync";
import { effectivePayer, expenseKind, isOverride, MIN_PAYER_REASON, PAID_BY_VALUE, payerAllowed, type DefaultablePayer, type PayerRow } from "@/lib/payer-rules";
import { financialIdentity, mergeServerOwned, type ProtectedRow } from "@/lib/protected-expense-fields";
import { createCertificate, voidCertificate, CertificateRefused, type Actor, type Deps } from "@/lib/certificates/service";
import type { ExpenseSource } from "@/lib/certificates/source";
import { liveRequest, optInFor, type CertificateRequest, type RequestableRow } from "@/lib/certificates/request";
import { CAMPAIGN_CUTOFF, campaignWhere, inCampaign } from "@/lib/historical-evidence/campaign";
import { classifyJob, isNotRequiredReason, type CampaignCertificate, type CampaignReview, type Classification, type NotRequiredReason } from "@/lib/historical-evidence/classify";

// Reading the campaign, and the four things an admin may do about one job in it.
//
// Reading changes nothing. Every list and every detail view is a classification computed
// from the rows as stored — no review row is written, no audit row, no Drive call, no
// PEAK call — so the page can be opened a thousand times and the database is exactly as
// it was.
//
// Every write is an admin acting on ONE job, from their own session, against the version
// of the sheet they were shown:
//
//   decide          NOT_REQUIRED (with a reason), REVIEWED (a note), or reopen
//   confirmPayers   say who paid, on rows nobody has confirmed — through the same
//                   protected merge the Job Sheet save uses, stamped server-side
//   selectRows      choose which guide-paid rows under an older waiver or a receipt a
//                   certificate should cover (or take a row back out) — stamped on the row,
//                   server-side, so the certificate service sees the same rows unchanged
//   issue           prepare a certificate through lib/certificates/service, unchanged
//
// Each carries the sheet's evidence fingerprint as the admin saw it. If the sheet has
// moved since, the write is refused and nothing changes: an admin's decision is about
// what they looked at, and it is not transferable to a sheet they did not.
//
// Attesting, filing and linking are NOT here. They stay on the Job Sheet's certificate
// panel, the one path that has always done them, so the campaign cannot become a second
// way to put a name on a document.

type Db = PrismaClient;

export class HistoricalEvidenceRefused extends Error {
  constructor(public reasons: string[], public status = 409) {
    super(reasons[0] ?? "refused");
    this.name = "HistoricalEvidenceRefused";
  }
}
function refuse(reasons: string[], status = 409): never { throw new HistoricalEvidenceRefused(reasons, status); }

const SHEET_SELECT = {
  id: true, ref: true, guideId: true, date: true, slotIdx: true, status: true,
  expenses: true, guideExpenses: true, guideExpensesAt: true, guideExpensesNote: true,
  approvalStatus: true, approvedAt: true, peakDocumentNo: true, updatedAt: true,
} satisfies Prisma.JobSheetSelect;
type SheetRow = Prisma.JobSheetGetPayload<{ select: typeof SHEET_SELECT }>;

const CERT_SELECT = { id: true, jobSheetId: true, certificateNo: true, status: true, coveredRows: true } satisfies Prisma.ExpenseCertificateSelect;

function reviewOf(r: { decision: string; snapshotHash: string; reasonCode: string | null; note: string | null; decidedByName: string; decidedAt: Date; version: number } | null): CampaignReview {
  return r ? { decision: r.decision, snapshotHash: r.snapshotHash, reasonCode: r.reasonCode, note: r.note, decidedByName: r.decidedByName, decidedAt: r.decidedAt, version: r.version } : null;
}

const classify = (sheet: SheetRow, certs: CampaignCertificate[], review: CampaignReview) =>
  classifyJob({ sheet, certificates: certs, review });

export type CampaignJob = {
  id: string; ref: string | null; date: string; slotIdx: number; guideId: string; guideName: string;
  sheetStatus: string; approved: boolean; guideReported: boolean;
  jobSheetUrl: string;
  classification: Classification;
};

async function guideNames(db: Db | Prisma.TransactionClient, ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return {};
  const users = await db.user.findMany({ where: { guideId: { in: ids } }, select: { guideId: true, fullName: true, displayName: true } });
  return Object.fromEntries(users.map((u) => [u.guideId!, (u.fullName || u.displayName || u.guideId || "").trim()]));
}

const sheetUrl = (s: { guideId: string; date: string; slotIdx: number }) =>
  `/job-sheet?guideId=${encodeURIComponent(s.guideId)}&date=${s.date}&slotIdx=${s.slotIdx}`;

function jobOf(s: SheetRow, names: Record<string, string>, c: Classification): CampaignJob {
  return {
    id: s.id, ref: s.ref, date: s.date, slotIdx: s.slotIdx, guideId: s.guideId,
    guideName: names[s.guideId] ?? s.guideId,
    sheetStatus: s.status, approved: s.approvalStatus === "APPROVED", guideReported: Boolean(s.guideExpensesAt),
    jobSheetUrl: sheetUrl(s),
    classification: c,
  };
}

/** Every job in the campaign, classified. Reads only. */
export async function loadCampaign(db: Db = prisma): Promise<CampaignJob[]> {
  const sheets = await db.jobSheet.findMany({ where: campaignWhere, select: SHEET_SELECT, orderBy: [{ date: "asc" }, { slotIdx: "asc" }, { guideId: "asc" }] });
  const ids = sheets.map((s) => s.id);
  const [certs, reviews, names] = await Promise.all([
    db.expenseCertificate.findMany({ where: { jobSheetId: { in: ids } }, select: CERT_SELECT }),
    db.historicalEvidenceReview.findMany({ where: { jobSheetId: { in: ids } } }),
    guideNames(db, [...new Set(sheets.map((s) => s.guideId))]),
  ]);
  const certsBy = new Map<string, CampaignCertificate[]>();
  for (const c of certs) certsBy.set(c.jobSheetId, [...(certsBy.get(c.jobSheetId) ?? []), c]);
  const reviewBy = new Map(reviews.map((r) => [r.jobSheetId, r]));
  return sheets.map((s) => jobOf(s, names, classify(s, certsBy.get(s.id) ?? [], reviewOf(reviewBy.get(s.id) ?? null))));
}

export type JobDetail = CampaignJob & {
  guideExpensesAt: string | null;
  guideExpensesNote: string | null;
  guideReport: { description: string; price: number | null; pax: number | null; amountSatang: number; paidBy: string | null; inSheet: boolean }[] | null;
  peakDocumentNo: string | null;
  draftPdfUrl: Record<ExpenseSource, string>;
};

/** One job, with the guide's report beside the operator's rows. Reads only. */
export async function loadJob(id: string, db: Db = prisma): Promise<JobDetail> {
  const s = await db.jobSheet.findUnique({ where: { id }, select: SHEET_SELECT });
  if (!s) refuse(["ไม่พบใบงานนี้"], 404);
  if (!inCampaign(s.date)) refuse([`ใบงานนี้ไม่อยู่ในขอบเขตงานย้อนหลัง (ก่อน ${CAMPAIGN_CUTOFF})`], 404);
  const [certs, review, names] = await Promise.all([
    db.expenseCertificate.findMany({ where: { jobSheetId: s.id }, select: CERT_SELECT }),
    db.historicalEvidenceReview.findUnique({ where: { jobSheetId: s.id } }),
    guideNames(db, [s.guideId]),
  ]);
  const c = classify(s, certs, reviewOf(review));
  const official = ((s.expenses as unknown as Expense[]) ?? []).filter((e) => !isReviewExpense(e));
  const norm = (v: unknown) => String(v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const report = s.guideExpensesAt && Array.isArray(s.guideExpenses)
    ? (s.guideExpenses as unknown as Expense[]).filter((g) => !isReviewExpense(g)).map((g) => ({
        description: (g.description ?? "").trim(),
        price: n(g.price), pax: n(g.pax),
        amountSatang: Math.round(expenseAmount(g) * 100),
        paidBy: (g.paidBy ?? "").trim() || null,
        inSheet: official.some((o) => norm(o.description) === norm(g.description) && n(o.price) === n(g.price) && n(o.pax) === n(g.pax)),
      }))
    : null;
  const q = `guideId=${encodeURIComponent(s.guideId)}&date=${s.date}&slotIdx=${s.slotIdx}`;
  return {
    ...jobOf(s, names, c),
    guideExpensesAt: s.guideExpensesAt ? s.guideExpensesAt.toISOString() : null,
    guideExpensesNote: s.guideExpensesNote ?? null,
    guideReport: report,
    peakDocumentNo: s.peakDocumentNo ?? null,
    // The existing preview: same renderer, watermarked, and it writes nothing.
    draftPdfUrl: {
      GUIDE_REPORTED: `/api/jobsheet/certificate/draft?${q}&source=GUIDE_REPORTED`,
      ADMIN_RECORDED: `/api/jobsheet/certificate/draft?${q}&source=ADMIN_RECORDED`,
    },
  };
}

/**
 * Who is acting, from the database rather than from the session alone. A session can be
 * older than a role change; a decision recorded under a role the person no longer holds
 * would be a claim nobody made.
 */
export async function actingAdmin(userId: string | null | undefined, db: Db = prisma): Promise<Actor> {
  if (!userId) refuse(["เซสชันนี้ไม่มีผู้ใช้ที่จะบันทึกเป็นผู้ตัดสิน"], 403);
  const me = await db.user.findUnique({ where: { id: userId }, select: { id: true, role: true, fullName: true, displayName: true, email: true } });
  if (!me || me.role !== "ADMIN") refuse(["เฉพาะ ADMIN เท่านั้น"], 403);
  return { id: me.id, name: (me.fullName || me.displayName || me.email || me.id).trim(), role: me.role };
}

// ── shared read-inside-a-transaction ────────────────────────────────────────

async function readForWrite(tx: Prisma.TransactionClient, id: string) {
  const sheet = await tx.jobSheet.findUnique({ where: { id }, select: SHEET_SELECT });
  if (!sheet) refuse(["ไม่พบใบงานนี้"], 404);
  if (!inCampaign(sheet.date)) refuse([`ใบงานนี้ไม่อยู่ในขอบเขตงานย้อนหลัง (ก่อน ${CAMPAIGN_CUTOFF})`], 409);
  const [certs, review] = await Promise.all([
    tx.expenseCertificate.findMany({ where: { jobSheetId: id }, select: CERT_SELECT }),
    tx.historicalEvidenceReview.findUnique({ where: { jobSheetId: id } }),
  ]);
  return { sheet, certs, review };
}

const STALE = "ใบงานนี้เปลี่ยนไปหลังจากที่เปิดดู จึงไม่ได้บันทึกอะไร — โหลดใหม่แล้วตรวจอีกครั้ง";
const RACE = "มีคนบันทึกผลของงานนี้ไปก่อนแล้ว จึงไม่ได้บันทึกอะไร — โหลดใหม่เพื่อดูผลล่าสุด";

// ── 1. decide ───────────────────────────────────────────────────────────────

export const MIN_NOTE = 10;
export type DecisionInput =
  | { kind: "NOT_REQUIRED"; snapshotHash: string; reviewVersion: number; reasonCode: NotRequiredReason; note?: string | null }
  | { kind: "REVIEWED"; snapshotHash: string; reviewVersion: number; note: string }
  | { kind: "REOPEN"; snapshotHash: string; reviewVersion: number; note: string };

export async function decide(id: string, actor: Actor, input: DecisionInput, db: Db = prisma, now: () => Date = () => new Date()) {
  const note = (input.note ?? "").trim() || null;
  if (input.kind === "NOT_REQUIRED") {
    if (!isNotRequiredReason(input.reasonCode)) refuse(["เหตุผลไม่ถูกต้อง"], 400);
    if (input.reasonCode === "OTHER" && (note ?? "").length < MIN_NOTE) refuse([`เหตุผลอื่นต้องมีหมายเหตุอย่างน้อย ${MIN_NOTE} ตัวอักษร`], 400);
  } else if ((note ?? "").length < MIN_NOTE) {
    refuse([`ต้องมีหมายเหตุอย่างน้อย ${MIN_NOTE} ตัวอักษร`], 400);
  }

  const result = await db.$transaction(async (tx) => {
    const { sheet, certs, review } = await readForWrite(tx, id);
    const prev = reviewOf(review);
    const current = classify(sheet, certs, prev);
    if (current.snapshotHash !== input.snapshotHash) refuse([STALE]);
    if ((review?.version ?? 0) !== input.reviewVersion) refuse([RACE]);

    // Whether an earlier NOT_REQUIRED stopped being true because the sheet moved. The
    // classification already treats it as undecided; this is where it is written down.
    const driftedFrom = prev && prev.decision === "NOT_REQUIRED" && prev.snapshotHash !== current.snapshotHash ? prev : null;

    if (input.kind === "NOT_REQUIRED") {
      // Judged on the data alone. An earlier decision — stale or not — is not evidence
      // that this one is right.
      const fresh = classify(sheet, certs, null);
      if (fresh.status !== "NOT_REQUIRED") {
        refuse([`งานนี้บันทึกว่าไม่ต้องใช้ใบรับรองไม่ได้ เพราะสถานะตามข้อมูลคือ ${fresh.status}`, ...fresh.reasons.slice(0, 5)]);
      }
      if (prev && prev.decision === "NOT_REQUIRED" && prev.snapshotHash === current.snapshotHash) refuse(["งานนี้บันทึกว่าไม่ต้องใช้ใบรับรองไว้แล้ว"]);
    }
    if (input.kind === "REVIEWED" && current.completed) refuse(["งานนี้เสร็จแล้ว ไม่ต้องบันทึกการตรวจ"]);
    if (input.kind === "REOPEN" && prev?.decision !== "NOT_REQUIRED") refuse(["ไม่มีผล NOT REQUIRED ให้เปิดใหม่"]);

    const decision = input.kind === "REOPEN" ? "REOPENED" : input.kind;
    const data = {
      campaign: CAMPAIGN_CUTOFF,
      decision,
      reasonCode: input.kind === "NOT_REQUIRED" ? input.reasonCode : null,
      note,
      snapshotHash: current.snapshotHash,
      decidedById: actor.id, decidedByName: actor.name, decidedByRole: actor.role,
      decidedAt: now(),
    };
    let row;
    if (review) {
      const hit = await tx.historicalEvidenceReview.updateMany({ where: { id: review.id, version: review.version }, data: { ...data, version: review.version + 1 } });
      if (hit.count !== 1) refuse([RACE]);
      row = await tx.historicalEvidenceReview.findUniqueOrThrow({ where: { id: review.id } });
    } else {
      try {
        row = await tx.historicalEvidenceReview.create({ data: { jobSheetId: sheet.id, ...data } });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") refuse([RACE]);
        throw e;
      }
    }
    return { row, sheet, statusBefore: current.status, driftedFrom };
  });

  const base = { jobSheetId: result.sheet.id, jobRef: result.sheet.ref, campaign: CAMPAIGN_CUTOFF, snapshotHash: result.row.snapshotHash, version: result.row.version };
  if (result.driftedFrom) {
    await audit({ actorId: actor.id, actorRole: actor.role, action: "historical_evidence.reopened", entityType: "JobSheet", entityId: result.sheet.id,
      detail: { ...base, why: "sheet_changed", previousSnapshotHash: result.driftedFrom.snapshotHash, previousDecidedAt: result.driftedFrom.decidedAt ? new Date(result.driftedFrom.decidedAt).toISOString() : null,
        note: "the sheet changed after it was decided that no certificate was needed, so that decision no longer applies" } });
  }
  const action = input.kind === "NOT_REQUIRED" ? "historical_evidence.not_required"
    : input.kind === "REVIEWED" ? "historical_evidence.reviewed" : "historical_evidence.reopened";
  await audit({ actorId: actor.id, actorRole: actor.role, action, entityType: "JobSheet", entityId: result.sheet.id,
    detail: { ...base, statusBefore: result.statusBefore, reasonCode: result.row.reasonCode, note: result.row.note,
      ...(input.kind === "REOPEN" ? { why: "admin" } : {}) } });
  return result.row;
}

// ── 2. confirm payers ───────────────────────────────────────────────────────

export type PayerConfirmation = { identity: string; payer: DefaultablePayer; reason?: string | null };

/**
 * Record who paid, on rows nobody has confirmed.
 *
 * Rows are found by what they say (financialIdentity), never by position: an index from
 * a browser is a guess about an array the server may have reordered since. A row that
 * reads like another is refused, not picked.
 *
 * The new rows go through `mergeServerOwned` — the same merge the Job Sheet save uses — so
 * anything the server owns on the sheet is carried across or the write is refused. The
 * stamp is added afterwards, on the confirmed rows only, with this admin and this moment.
 * No other row's payer, source or stamp is touched.
 */
export async function confirmPayers(id: string, actor: Actor, input: { snapshotHash: string; rows: PayerConfirmation[] }, db: Db = prisma, now: () => Date = () => new Date()) {
  if (!input.rows.length) refuse(["ไม่มีรายการให้ยืนยัน"], 400);
  if (new Set(input.rows.map((r) => r.identity)).size !== input.rows.length) refuse(["ส่งรายการเดียวกันมาซ้ำ"], 400);
  const at = now().toISOString();

  const result = await db.$transaction(async (tx) => {
    const { sheet, certs, review } = await readForWrite(tx, id);
    const current = classify(sheet, certs, reviewOf(review));
    if (current.snapshotHash !== input.snapshotHash) refuse([STALE]);
    if (certs.some((c) => c.status !== "VOID")) {
      refuse(["ใบงานนี้มีใบรับรองอยู่แล้ว การเปลี่ยน Paid By จะทำให้ใบรับรองไม่ตรงกับใบงาน — ยกเลิกใบรับรองก่อนถ้าจำเป็นต้องแก้"]);
    }

    const stored = ((sheet.expenses as unknown as ProtectedRow[]) ?? []);
    const next = stored.map((e) => ({ ...e })) as (ProtectedRow & { paidByReason?: string | null })[];
    const changed: { at: number; from: string; fromBasis: string; to: DefaultablePayer; override: boolean; reason: string | null; description: string; amountSatang: number }[] = [];

    for (const want of input.rows) {
      const hits = stored.map((e, i) => ({ e, i })).filter(({ e }) => !isReviewExpense(e) && financialIdentity(e) === want.identity);
      if (hits.length === 0) refuse(["ไม่พบรายการที่ต้องการยืนยันในใบงาน (ใบงานอาจเปลี่ยนไปแล้ว)"]);
      if (hits.length > 1) refuse([`"${hits[0].e.description}" มี ${hits.length} แถวที่เหมือนกัน แยกไม่ได้ว่าจะยืนยันแถวไหน — แก้ให้แต่ละแถวต่างกันใน Job Sheet ก่อน`]);
      const { e, i } = hits[0];
      if ((e as { evidenceWaiver?: unknown }).evidenceWaiver) refuse([`"${e.description}" มีหลักฐานผูกอยู่แล้ว แก้ Paid By จากหน้านี้ไม่ได้`]);
      if ((e.paidByBy ?? "").trim()) refuse([`"${e.description}" มีผู้บันทึก Paid By ไว้แล้ว ถ้าต้องแก้ให้แก้ใน Job Sheet`]);

      const kind = expenseKind(e);
      if (!payerAllowed(kind, want.payer)) refuse([`"${e.description}": ค่าอาหารจ่ายจากเงินทดรองไม่ได้ — เงินทดรองใช้ซื้อบัตรเข้าชม`]);
      const override = isOverride(kind, want.payer);
      const reason = (want.reason ?? "").trim() || null;
      if (override && (reason ?? "").length < MIN_PAYER_REASON) refuse([`"${e.description}": Paid By ต่างจากค่าปกติของประเภทนี้ ต้องระบุเหตุผลอย่างน้อย ${MIN_PAYER_REASON} ตัวอักษร`], 400);
      if (expenseAmount(e) <= 0) refuse([`"${e.description}" ไม่มียอดเงิน ไม่ต้องยืนยัน Paid By`], 400);

      const before = effectivePayer(e as PayerRow);
      next[i] = { ...next[i], paidBy: PAID_BY_VALUE[want.payer], paidBySource: "operator", ...(override ? { paidByReason: reason } : {}) };
      changed.push({ at: i, from: canonicalPaidBy(e), fromBasis: before.basis, to: want.payer, override, reason: override ? reason : null,
        description: (e.description ?? "").trim(), amountSatang: Math.round(expenseAmount(e) * 100) });
    }

    // The Job Sheet save's own merge. Rows nobody signed for pass through; anything the
    // server owns is carried across by identity, or the write is refused.
    const merged = mergeServerOwned(stored, next, sheet.ref || "This job sheet");
    if (merged.conflicts.length) refuse(merged.conflicts);
    const rows = merged.rows as (ProtectedRow & { paidByReason?: string | null })[];

    // Stamp the confirmed rows — found again by what they now say, and only those.
    for (const c of changed) {
      const id2 = financialIdentity(next[c.at]);
      const where = rows.map((r, i) => ({ r, i })).filter(({ r }) => financialIdentity(r) === id2);
      if (where.length !== 1) refuse([`"${c.description}" จะซ้ำกับแถวอื่นหลังเปลี่ยน Paid By แยกไม่ได้ว่าแถวไหนคือแถวไหน`]);
      rows[where[0].i] = { ...rows[where[0].i], paidByBy: actor.id, paidByAt: at };
    }

    const hit = await tx.jobSheet.updateMany({ where: { id: sheet.id, updatedAt: sheet.updatedAt }, data: { expenses: rows as unknown as Prisma.InputJsonValue } });
    if (hit.count !== 1) refuse([STALE]);
    return { sheet, changed };
  });

  await audit({ actorId: actor.id, actorRole: actor.role, action: "historical_evidence.payer_confirmed", entityType: "JobSheet", entityId: result.sheet.id,
    detail: { jobSheetId: result.sheet.id, jobRef: result.sheet.ref, campaign: CAMPAIGN_CUTOFF, recordedAt: at,
      rows: result.changed.map((c) => ({ row: c.at + 1, description: c.description, amountSatang: c.amountSatang, from: c.from, fromBasis: c.fromBasis, to: c.to, override: c.override, reason: c.reason })),
      note: "an admin confirmed who paid, from the historical evidence campaign; separate from certifying anything" } });
  return result.changed;
}

// ── 3. choose the rows a certificate covers ─────────────────────────────────

export type RowSelection = { identity: string; certify: boolean; acknowledgeReceipt?: boolean };

export const RECEIPT_WARNING = "รายการนี้มีใบเสร็จแนบอยู่แล้ว ใบรับรองแทนใบเสร็จจะซ้ำกับหลักฐานที่มีอยู่ — ยืนยันเฉพาะเมื่อใบเสร็จใช้ไม่ได้หรือไม่ครบ";

/**
 * Say which rows a certificate should cover, on a job whose data alone would not offer one.
 *
 * Rows that need a certificate by themselves (the guide's money, nothing behind it) are
 * always covered and are not chosen here. What is chosen is the opt-in kind: a guide-paid
 * row resting on an older admin waiver with no document, or one with a receipt — the
 * latter only with the receipt acknowledged in the request, because a certificate "in lieu
 * of a receipt" beside a receipt is a second piece of evidence somebody has to mean.
 *
 * Nothing is guessed. The row must already be the guide's own money, with an amount, and
 * with a payer a PERSON recorded; a payer the rules filled in is confirmed first, on its own
 * action, with its own audit. Rows are found by what they say, never by position. The
 * stamp names this admin and this moment and is written server-side; the sheet moves only
 * if it is still the version the admin saw (snapshot + updatedAt), and nothing else on the
 * row changes. Withdrawing a request is the same action with certify: false.
 */
export async function selectRows(id: string, actor: Actor, input: { snapshotHash: string; rows: RowSelection[] }, db: Db = prisma, now: () => Date = () => new Date()) {
  if (!input.rows.length) refuse(["ไม่มีรายการให้เลือก"], 400);
  if (new Set(input.rows.map((r) => r.identity)).size !== input.rows.length) refuse(["ส่งรายการเดียวกันมาซ้ำ"], 400);
  const at = now().toISOString();

  const result = await db.$transaction(async (tx) => {
    const { sheet, certs, review } = await readForWrite(tx, id);
    const current = classify(sheet, certs, reviewOf(review));
    if (current.snapshotHash !== input.snapshotHash) refuse([STALE]);
    const active = certs.find((c) => c.status !== "VOID");
    if (active) refuse([`ใบงานนี้มีใบรับรอง ${active.certificateNo} (${active.status}) อยู่แล้ว — ไม่สร้างซ้ำ ถ้าต้องเปลี่ยนรายการ ให้ยกเลิกใบรับรองนั้นใน Job Sheet ก่อน`]);

    const stored = ((sheet.expenses as unknown as RequestableRow[]) ?? []);
    const next = stored.map((e) => ({ ...e })) as (RequestableRow & ProtectedRow)[];
    const changed: { row: number; description: string; amountSatang: number; certify: boolean; optIn: string | null; receiptAcknowledged: boolean; supersedesWaiver: unknown }[] = [];

    for (const want of input.rows) {
      const hits = stored.map((e, i) => ({ e, i })).filter(({ e }) => !isReviewExpense(e) && financialIdentity(e as ProtectedRow) === want.identity);
      if (hits.length === 0) refuse(["ไม่พบรายการที่เลือกในใบงาน (ใบงานอาจเปลี่ยนไปแล้ว)"]);
      if (hits.length > 1) refuse([`"${hits[0].e.description}" มี ${hits.length} แถวที่เหมือนกัน แยกไม่ได้ว่าจะเลือกแถวไหน — แก้ให้แต่ละแถวต่างกันใน Job Sheet ก่อน`]);
      const { e, i } = hits[0];
      const what = (e.description ?? "").trim() || `แถว ${i + 1}`;
      const row = current.rows.find((r) => r.index === i);

      if (!want.certify) {
        if (!liveRequest(e) && !e.certificateRequest) refuse([`"${what}" ไม่ได้ถูกเลือกไว้`], 400);
        delete next[i].certificateRequest;
        changed.push({ row: i + 1, description: what, amountSatang: Math.round(expenseAmount(e) * 100), certify: false, optIn: null, receiptAcknowledged: false, supersedesWaiver: null });
        continue;
      }

      if (expenseAmount(e) <= 0) refuse([`"${what}" ไม่มียอดเงิน ออกใบรับรองยอดศูนย์ไม่ได้ — บันทึกจำนวนใน Job Sheet ก่อน`], 400);
      if (canonicalPaidBy(e) === "UNSPECIFIED") refuse([`"${what}" ยังไม่มี Paid By — เลือกและยืนยัน Paid By ก่อน`], 400);
      if (canonicalPaidBy(e) !== "GUIDE_PERSONAL") refuse([`"${what}" บันทึกว่าไม่ใช่เงินไกด์ ใบรับรองแทนใบเสร็จใช้กับเงินที่ไกด์สำรองจ่ายเท่านั้น — ถ้า Paid By ผิด แก้ใน Job Sheet ก่อน`], 400);
      if (!row || row.needsPayerConfirmation) refuse([`"${what}": Paid By ยังไม่มีคนยืนยัน — กดยืนยัน Paid By ก่อนเลือกรายการ`], 400);
      if (row.issues.length) refuse([`"${what}": ${row.issues[0]}`], 400);
      const opt = optInFor(e);
      if (!opt) {
        refuse([row.evidence === "NEEDS_CERTIFICATE"
          ? `"${what}" ต้องใช้ใบรับรองอยู่แล้ว ไม่ต้องเลือก`
          : `"${what}" เลือกให้ใบรับรองครอบคลุมไม่ได้ (${row.evidence})`], 400);
      }
      if (opt === "HAS_RECEIPT" && want.acknowledgeReceipt !== true) refuse([`"${what}": ${RECEIPT_WARNING}`], 400);
      if (liveRequest(e)) refuse([`"${what}" ถูกเลือกไว้แล้ว`], 409);

      const request: CertificateRequest = {
        by: actor.id, byName: actor.name, at,
        identity: financialIdentity(e as ProtectedRow),
        receiptAcknowledged: opt === "HAS_RECEIPT",
        supersedesWaiver: e.evidenceWaiver ?? null,
      };
      next[i].certificateRequest = request;
      changed.push({ row: i + 1, description: what, amountSatang: Math.round(expenseAmount(e) * 100), certify: true, optIn: opt, receiptAcknowledged: request.receiptAcknowledged, supersedesWaiver: request.supersedesWaiver });
    }

    // `next` is the stored rows with only certificateRequest set or removed — no figure,
    // payer, waiver or stamp is touched, so each row keeps its financial identity.
    const hit = await tx.jobSheet.updateMany({ where: { id: sheet.id, updatedAt: sheet.updatedAt }, data: { expenses: next as unknown as Prisma.InputJsonValue } });
    if (hit.count !== 1) refuse([STALE]);
    const after = classify({ ...sheet, expenses: next as unknown as Prisma.JsonValue }, certs, reviewOf(review));
    return { sheet, changed, statusBefore: current.status, statusAfter: after.status };
  });

  for (const certify of [true, false]) {
    const rows = result.changed.filter((c) => c.certify === certify);
    if (!rows.length) continue;
    await audit({ actorId: actor.id, actorRole: actor.role,
      action: certify ? "historical_evidence.certificate_rows_selected" : "historical_evidence.certificate_rows_withdrawn",
      entityType: "JobSheet", entityId: result.sheet.id,
      detail: { jobSheetId: result.sheet.id, jobRef: result.sheet.ref, campaign: CAMPAIGN_CUTOFF, recordedAt: at,
        statusBefore: result.statusBefore, statusAfter: result.statusAfter,
        rows: rows.map(({ certify: _c, ...r }) => r),
        note: certify
          ? "an admin chose these guide-paid rows for a certificate in lieu of receipt; no certificate is created by this, and no payer or amount changed"
          : "an admin took these rows back out of a certificate that had not been created yet" } });
  }
  return { changed: result.changed, statusBefore: result.statusBefore, statusAfter: result.statusAfter };
}

// ── 4. prepare a certificate ────────────────────────────────────────────────

/**
 * Hand a READY job to the certificate service, unchanged.
 *
 * The campaign's own checks — every guide-paid row confirmed by a person, the sheet
 * approved, the source matching what the guide actually reported — are made first, on the
 * sheet version the admin saw. The certificate service then makes its own, as it always
 * does. If the sheet moved in between, the draft it produced describes a sheet nobody
 * reviewed, so it is withdrawn at once with that reason, and the admin is told.
 *
 * This creates a draft (READY_TO_ATTEST) and nothing more. Attesting, filing and linking
 * happen on the Job Sheet, by a person, exactly as before.
 */
export async function prepareCertificate(id: string, actor: Actor, input: { snapshotHash: string; source: ExpenseSource }, deps: Deps = {}) {
  const db = deps.db ?? prisma;
  const { sheet, certs, review } = await db.$transaction((tx) => readForWrite(tx, id));
  const c = classify(sheet, certs, reviewOf(review));
  if (c.snapshotHash !== input.snapshotHash) refuse([STALE]);
  if (c.status !== "READY_TO_ISSUE") refuse([`งานนี้ยังออกใบรับรองไม่ได้ (สถานะ ${c.status})`, ...c.reasons.slice(0, 5)]);
  if (input.source === "GUIDE_REPORTED" && !c.source.guideReportedAvailable) {
    refuse([`เลือก "ไกด์ส่งรายงาน" ไม่ได้: ${c.source.guideReportedReason ?? "ไม่มีรายงานจากไกด์"} — ใช้ "ADMIN บันทึกแทน" แทน`]);
  }

  let cert;
  try {
    cert = await createCertificate({ guideId: sheet.guideId, date: sheet.date, slotIdx: sheet.slotIdx }, actor, deps, input.source);
  } catch (e) {
    if (e instanceof CertificateRefused) refuse(e.reasons, e.status);
    throw e;
  }
  if (cert.sourceSheetUpdatedAt.getTime() !== sheet.updatedAt.getTime()) {
    await voidCertificate(cert.id, "ใบงานเปลี่ยนระหว่างที่เตรียมใบรับรองจากหน้าหลักฐานย้อนหลัง จึงยกเลิกร่างนี้ทันที", actor, deps);
    refuse([STALE]);
  }
  await audit({ actorId: actor.id, actorRole: actor.role, action: "historical_evidence.certificate_prepared", entityType: "JobSheet", entityId: sheet.id,
    detail: { jobSheetId: sheet.id, jobRef: sheet.ref, campaign: CAMPAIGN_CUTOFF, certificateId: cert.id, certificateNo: cert.certificateNo, source: cert.source, snapshotHash: c.snapshotHash,
      note: "a draft only — attesting, filing and linking are done on the job sheet by a person" } });
  return cert;
}

export type { JobSheet };
