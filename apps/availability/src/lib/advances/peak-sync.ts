import { Prisma, type PrismaClient } from "@prisma/client";
import { createDailyJournal, sanitizePeakError } from "@/lib/peak-api";
import { advanceJournal, type AdvancePeakConfig, type JournalSource } from "./peak-journal";
import { advanceWritesFrozen } from "./freeze";

// Explicit configuration is shared by web and worker. Never infer bank IDs or journal
// type numbers from a label. Only the deployment owner can enable automatic posting.
export function advancePeakConfig(): AdvancePeakConfig {
  const raw = process.env.PEAK_ADVANCE_CONFIG;
  if (!raw) throw new Error("Configure the advance account, bank subaccount and journal books before syncing");
  return JSON.parse(raw) as AdvancePeakConfig;
}

async function sourceFor(db: PrismaClient, kind: string, id: string, config: AdvancePeakConfig): Promise<JournalSource> {
  let source: Omit<JournalSource, "guideContactId">;
  let guideId: string;
  if (kind === "ADVANCE") {
    const a = await db.guideAdvance.findUniqueOrThrow({ where: { id } });
    if (a.reversedAt) throw new Error("Advance was reversed");
    if (a.peakRef || a.peakDocumentNo) throw new Error("An existing PEAK reference needs reconciliation; do not post again");
    if (!a.txRef) throw new Error("Add the bank transaction reference before syncing");
    if (await db.guideAdvance.count({ where: { txRef: a.txRef } }) !== 1) throw new Error("Duplicate advance bank reference; reconcile before syncing");
    if (a.bankAccount !== config.bankAccountSubId) throw new Error("Confirm the advance bank account before syncing");
    if (a.method !== "bank") throw new Error("Only bank transfers are configured for automatic sync");
    guideId = a.guideId;
    source = { kind, amountSatang: a.amountSatang, date: a.advanceDate, reference: a.advanceNo, jobNo: a.jobNo ?? "", slipUrl: a.slipUrl };
  } else if (kind === "RETURN") {
    const r = await db.guideAdvanceReceipt.findUniqueOrThrow({ where: { id }, include: { entries: { where: { type: "RETURN_ALLOCATION", reversedByEntryId: null }, include: { advance: true } } } });
    if (r.peakDocumentNo) throw new Error("An existing PEAK reference needs reconciliation; do not post again");
    if (r.status !== "VERIFIED" || r.method !== "bank") throw new Error("Confirm the bank return before syncing");
    if (r.allocatedSatang !== r.amountSatang) throw new Error("Allocate this return to its Job No. before syncing");
    if (!r.bankRef || await db.guideAdvanceReceipt.count({ where: { bankRef: r.bankRef } }) !== 1) throw new Error("Missing or duplicate return bank reference");
    if (r.entries.some(e => !e.advance.peakDocumentNo && !e.advance.peakRef)) throw new Error("Sync or reconcile the original advances first");
    const jobs = [...new Set(r.entries.map(e => e.advance.jobNo).filter((x): x is string => !!x))];
    if (!jobs.length || r.entries.some(e => !e.advance.jobNo)) throw new Error("Return allocations need a Job No.");
    // A single configured bank must be stated on receipts; ambiguous accounts block.
    if (r.bankAccount !== config.bankAccountSubId) throw new Error("Confirm the return's PEAK bank subaccount before syncing");
    guideId = r.guideId;
    source = { kind, amountSatang: r.amountSatang, date: r.receivedDate, reference: r.receiptNo, jobNo: jobs.join(", "), slipUrl: r.slipUrl };
  } else if (kind === "EXPENSE") {
    const e = await db.guideAdvanceEntry.findUniqueOrThrow({ where: { id }, include: { advance: true } });
    if (e.type !== "EXPENSE_SETTLEMENT" || e.reversedByEntryId || e.peakDocumentNo) throw new Error("Expense settlement is reversed or already has a PEAK reference");
    const issued = await db.advancePeakSync.findUnique({ where: { id: `ADVANCE:${e.advanceId}` } });
    if (issued?.status !== "POSTED" && !e.advance.peakDocumentNo && !e.advance.peakRef) throw new Error("Sync or reconcile the original advance first");
    const sheet = await db.jobSheet.findUniqueOrThrow({ where: { id: e.sourceId } });
    if (sheet.approvalStatus !== "APPROVED") throw new Error("Job sheet must remain approved before posting");
    const siblings = await db.guideAdvanceEntry.count({ where: { sourceId: e.sourceId, type: "EXPENSE_SETTLEMENT", reversedByEntryId: null } });
    if (siblings !== 1) throw new Error("Multiple settlements on this job need consolidated accounting review");
    const snapshot = e.snapshot as { rows?: JournalSource["expenses"] } | null;
    guideId = e.advance.guideId;
    source = { kind, amountSatang: e.amountSatang, date: e.effectiveDate, reference: `FOLK-SET-${e.id}`, jobNo: e.jobNo ?? "", expenses: snapshot?.rows };
  } else throw new Error("Unsupported advance event");
  const guide = await db.user.findUnique({ where: { guideId }, select: { peakContactId: true } });
  return { ...source, guideContactId: guide?.peakContactId ?? "" };
}

/** Atomic claims plus an immutable payload. A timeout or process death never retries a POST. */
export async function syncAdvanceBatch(db: PrismaClient, post = createDailyJournal): Promise<number> {
  if (process.env.PEAK_ADVANCE_AUTO_SYNC !== "1" || advanceWritesFrozen()) return 0;
  let config: AdvancePeakConfig;
  try { config = advancePeakConfig(); } catch { return 0; }
  const mappings = await db.peakAccountMapping.findMany({ where: { isActive: true } });
  // This ledger is only for ticket money sent to a guide. Other tour costs follow
  // their normal company-direct or guide-reimbursement workflows.
  const categoryKeys: Record<string,string> = { entrance: "ENTRANCE_TICKET" };
  config.expenseAccounts = Object.fromEntries(Object.entries(categoryKeys).flatMap(([key, value]) => {
    const account = mappings.find(m => m.folkopsCategory === value)?.peakAccountCode;
    return account ? [[key, account]] : [];
  }));
  // A crashed sender may have created a document. Human reconciliation is mandatory.
  await db.advancePeakSync.updateMany({ where: { status: "SENDING", updatedAt: { lt: new Date(Date.now() - 10 * 60_000) } }, data: { status: "UNCERTAIN", error: "Sender interrupted; check PEAK before any further action" } });
  const queue = await db.advancePeakSync.findMany({ where: { status: { in: ["PENDING", "BLOCKED"] }, nextAttemptAt: { lte: new Date() } }, orderBy: { createdAt: "asc" }, take: 10 });
  let done = 0;
  for (const row of queue) {
    // Claim BEFORE reading the source: the DB reversal trigger sees SENDING and refuses.
    const claim = await db.advancePeakSync.updateMany({ where: { id: row.id, status: row.status, updatedAt: row.updatedAt }, data: { status: "SENDING", attempts: { increment: 1 }, error: null } });
    if (!claim.count) continue;
    // Someone recorded an existing PEAK document for this event. Close the item
    // against that document instead of creating a second one. Checked after the
    // claim, so a link written while this row was being claimed still wins.
    const linked = await db.advancePeakDocumentLink?.findUnique?.({ where: { kind_sourceId: { kind: row.kind, sourceId: row.sourceId } } });
    if (linked) {
      await db.advancePeakSync.update({ where: { id: row.id }, data: { status: "POSTED", documentNo: linked.documentNo, documentId: linked.documentId, error: null } });
      continue;
    }
    let payload;
    try {
      payload = advanceJournal(await sourceFor(db, row.kind, row.sourceId, config), config);
      await db.advancePeakSync.update({ where: { id: row.id }, data: { payload: payload as unknown as Prisma.InputJsonValue } });
    } catch (e) {
      await db.advancePeakSync.update({ where: { id: row.id }, data: { status: "BLOCKED", error: sanitizePeakError(e), nextAttemptAt: new Date(Date.now() + 5 * 60_000) } });
      continue;
    }
    try {
      const result = await post(payload);
      if (!result.ok || !result.id || !result.code) {
        await db.advancePeakSync.update({ where: { id: row.id }, data: { status: result.uncertain || result.ok ? "UNCERTAIN" : "BLOCKED", error: result.desc ?? "No confirmed document returned", nextAttemptAt: new Date(Date.now() + 5 * 60_000) } });
        continue;
      }
      await db.$transaction(async tx => {
        await tx.advancePeakSync.update({ where: { id: row.id }, data: { status: "POSTED", documentId: result.id, documentNo: result.code, error: null } });
        if (row.kind === "ADVANCE") await tx.guideAdvance.update({ where: { id: row.sourceId }, data: { peakDocumentNo: result.code, peakRef: result.code, peakReference: payload.reference } });
        if (row.kind === "EXPENSE") await tx.guideAdvanceEntry.update({ where: { id: row.sourceId }, data: { peakDocumentNo: result.code, peakReference: payload.reference } });
      });
      done++;
    } catch {
      // Includes a successful PEAK POST followed by a failed local save.
      await db.advancePeakSync.update({ where: { id: row.id }, data: { status: "UNCERTAIN", error: "PEAK outcome needs reconciliation; automatic resend stopped" } }).catch(() => {});
    }
  }
  return done;
}

export async function advanceSyncStates(db: PrismaClient, ids: string[]) {
  // Some read-only renderers and tests use a deliberately small Prisma facade.
  // Missing sync metadata must not stop the underlying ledger from rendering.
  if (!ids.length || !db.advancePeakSync?.findMany) return new Map<string, { status: string; documentNo: string | null; error: string | null }>();
  const rows = await db.advancePeakSync.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, documentNo: true, error: true } });
  return new Map(rows.map(r => [r.id, { status: r.status, documentNo: r.documentNo, error: r.error }]));
}
