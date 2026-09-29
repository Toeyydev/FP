import { Prisma, type PrismaClient } from "@prisma/client";
import { audit } from "@/lib/audit";
import { expenseAmount, expenseCategory, type Expense } from "@/lib/jobsheet";
import {
  advanceAutoSyncEnabled, AUTO_SYNC_ON_MESSAGE, existingPeakLinksEnabled, EXISTING_LINKS_OFF_MESSAGE,
} from "./freeze";
import { advancePeakConfig } from "./peak-sync";
import { bumpAdvance, bumpReceipt, LedgerConflict, type Actor, type Fail } from "./service";
import {
  checkAllocations, checkConfirmation, fromSatang, idempotencyKeyFor, MIN_REASON, outstandingSatang,
  periodOf, toSatang, type AllocationRequest, type ReceiptStatus,
} from "./rules";

// Recording a PEAK document that already exists.
//
// The accountant books money as it moves. FolkOPS arrived later, so some advances,
// some returns and some ticket costs are already in PEAK — put there by hand, with
// their own document numbers. This module attaches those numbers to the ledger.
//
// It NEVER calls a PEAK write endpoint. Its whole purpose is the opposite: to close
// the outbox item for an event that PEAK already carries, so that turning the sender
// on cannot produce a second document for money that moved once.
//
// Three rules hold it together:
//   1. Everything for one event happens in ONE transaction — confirm, allocate,
//      settle, link, and close the outbox. A failure anywhere leaves nothing behind.
//   2. A document number belongs to one event, enforced by a unique index on
//      (documentType, documentNo), not by this file remembering to look.
//   3. The figures are checked against PEAK itself where a read-only lookup exists.
//      The operator's confirmation is never accepted in place of that check.

export const LINK_SOURCE = "EXISTING_PEAK_DOCUMENT";
export type LinkKind = "ADVANCE" | "RETURN" | "EXPENSE";
export type PeakDocumentType = "DAILY_JOURNAL" | "EXPENSE";

/** What a read-only lookup gives back. Shaped so a test can supply one without PEAK. */
export type PeakJournalEntry = { accountCode: string; accountSubId?: string | null; accountSubCode?: string | null; debit: number; credit: number };
export type PeakDocument = {
  code: string; id?: string | null; documentType: PeakDocumentType;
  isVoid?: boolean; contactId?: string | null; issuedDate?: string | null;
  entries?: PeakJournalEntry[];
};
export type DocumentLookup = (documentNo: string, type: PeakDocumentType) => Promise<
  { ok: true; document: PeakDocument } | { ok: false; notFound?: boolean; desc: string }
>;

const fail = (status: number, ...reasons: string[]): Fail => ({ ok: false, status, reasons });
export type LinkResult =
  | { ok: true; replayed: boolean; documentNo: string; kind: LinkKind; sourceId: string; verified: boolean; warnings: string[] }
  | Fail;

/** Trim and upper-case a document number, and refuse anything that is not one. */
export function normalizeDocumentNo(raw: string): string | null {
  const v = (raw ?? "").trim().toUpperCase().replace(/\s+/g, "");
  return /^[A-Z][A-Z0-9]*-?[A-Z0-9/-]{2,39}$/.test(v) ? v : null;
}

const satangOf = (v: number | string | null | undefined) => Math.round(Number(v ?? 0) * 100);
const sameAccount = (e: PeakJournalEntry, code: string, subId?: string) =>
  e.accountCode === code && (!subId || e.accountSubId === subId || e.accountSubCode === subId);

/**
 * Does this PEAK document actually carry this movement? Pure, so every branch is
 * testable without a PEAK connection.
 *
 * A settlement is deliberately checked on ONE side only: the accountant's own
 * practice puts ticket money inside a larger payment document, where the advance
 * account is credited for part of the total. Requiring the whole document to equal
 * the settlement would refuse the very documents this feature exists to link.
 */
export function checkDocumentMatches(input: {
  kind: LinkKind; amountSatang: number; document: PeakDocument;
  config: { advanceAccountCode: string; advanceAccountSubId?: string; bankAccountCode: string; bankAccountSubId: string };
}): { reasons: string[]; warnings: string[] } {
  const { kind, amountSatang, document: doc, config } = input;
  const reasons: string[] = [], warnings: string[] = [];
  if (doc.isVoid) return { reasons: [`${doc.code} is void in PEAK — a void document cannot carry this movement`], warnings };
  if (doc.documentType !== "DAILY_JOURNAL") {
    // An expense document's payment lines are not exposed by the read API, so the
    // figures cannot be machine-checked. Say so instead of implying they were.
    warnings.push(`${doc.code} is an expense document — FolkOPS could not check its figures, only that it exists`);
    return { reasons, warnings };
  }
  const entries = doc.entries ?? [];
  if (!entries.length) return { reasons: [`${doc.code} has no journal lines to check`], warnings };
  const advanceSide = entries.filter((e) => sameAccount(e, config.advanceAccountCode, config.advanceAccountSubId));
  if (!advanceSide.length) {
    reasons.push(`${doc.code} does not touch the guide advance account (${config.advanceAccountCode}${config.advanceAccountSubId ? " · its sub-account" : ""})`);
    return { reasons, warnings };
  }
  const advDebit = advanceSide.reduce((s, e) => s + satangOf(e.debit), 0);
  const advCredit = advanceSide.reduce((s, e) => s + satangOf(e.credit), 0);
  const money = (n: number) => fromSatang(n).toLocaleString(undefined, { minimumFractionDigits: 2 });

  if (kind === "ADVANCE") {
    if (advDebit !== amountSatang) reasons.push(`${doc.code} debits ${money(advDebit)} to the advance account, not ${money(amountSatang)}`);
    const bank = entries.filter((e) => sameAccount(e, config.bankAccountCode, config.bankAccountSubId));
    const bankCredit = bank.reduce((s, e) => s + satangOf(e.credit), 0);
    if (!bank.length) reasons.push(`${doc.code} does not credit the company bank account ${config.bankAccountCode}`);
    else if (bankCredit !== amountSatang) reasons.push(`${doc.code} credits ${money(bankCredit)} from the bank, not ${money(amountSatang)}`);
  } else if (kind === "RETURN") {
    if (advCredit !== amountSatang) reasons.push(`${doc.code} credits ${money(advCredit)} to the advance account, not ${money(amountSatang)}`);
    const bank = entries.filter((e) => sameAccount(e, config.bankAccountCode, config.bankAccountSubId));
    const bankDebit = bank.reduce((s, e) => s + satangOf(e.debit), 0);
    if (!bank.length) reasons.push(`${doc.code} does not debit the company bank account ${config.bankAccountCode}`);
    else if (bankDebit !== amountSatang) reasons.push(`${doc.code} debits ${money(bankDebit)} to the bank, not ${money(amountSatang)}`);
  } else {
    if (advCredit !== amountSatang) reasons.push(`${doc.code} takes ${money(advCredit)} out of the advance account, not ${money(amountSatang)}`);
  }
  if (!doc.contactId) {
    // PEAK's own transfer documents carry no contact, so this is the normal case for
    // the older records. The figures and the accounts are then the only evidence,
    // which is exactly why they are checked above and why a reason is required.
    warnings.push(`${doc.code} names no contact in PEAK, so only the accounts and the amount could be matched`);
  }
  return { reasons, warnings };
}


/**
 * May anything be linked at all, right now?
 *
 * Linking writes to the ledger, so it cannot simply ignore the cutover freeze. It
 * gets its own switch instead, and refuses while the sender is on: two writers
 * reaching one movement is exactly the race this whole feature exists to prevent.
 */
export function checkLinkMode(): Fail | null {
  if (!existingPeakLinksEnabled()) return fail(503, EXISTING_LINKS_OFF_MESSAGE);
  if (advanceAutoSyncEnabled()) return fail(409, AUTO_SYNC_ON_MESSAGE);
  return null;
}

/** Statuses that mean the sender may already have created a document for this event. */
const IN_FLIGHT = ["SENDING", "PROCESSING", "UNCERTAIN", "POSTED"];

/** The one link for a business event, if it has been recorded. */
export async function peakLinkFor(db: Pick<PrismaClient, "advancePeakDocumentLink">, kind: LinkKind, sourceId: string) {
  if (!db.advancePeakDocumentLink?.findUnique) return null;
  return db.advancePeakDocumentLink.findUnique({ where: { kind_sourceId: { kind, sourceId } } });
}

export async function peakLinksFor(db: Pick<PrismaClient, "advancePeakDocumentLink">, kind: LinkKind, sourceIds: string[]) {
  if (!sourceIds.length || !db.advancePeakDocumentLink?.findMany) return new Map<string, { documentNo: string; documentType: string; linkedAt: Date; note: string; warning: string | null; verified: boolean }>();
  const rows = await db.advancePeakDocumentLink.findMany({ where: { kind, sourceId: { in: sourceIds } } });
  return new Map(rows.map((r) => [r.sourceId, { documentNo: r.documentNo, documentType: r.documentType, linkedAt: r.linkedAt, note: r.note, warning: r.warning, verified: r.verified }]));
}

export type LinkRequest = {
  documentNo: string; documentType: PeakDocumentType; note: string;
  acknowledgeWarnings?: boolean; requestKey: string; actor: Actor;
} & (
  | { kind: "ADVANCE"; advanceId: string }
  | { kind: "RETURN"; receiptId: string; bankAccount?: string | null; bankRef?: string | null; allocations: AllocationRequest[] }
  | { kind: "EXPENSE"; advanceId: string; jobSheetId: string; amount: number }
);

type Ctx = { documentNo: string; document: PeakDocument | null; verified: boolean; warnings: string[] };

/**
 * Validate a link without writing anything. The screen shows this before asking the
 * person to confirm — and the write path runs it again, because a preview is not a
 * permission.
 */
export async function previewLink(prisma: PrismaClient, req: LinkRequest, lookup?: DocumentLookup): Promise<
  { ok: true; documentNo: string; amount: number; verified: boolean; warnings: string[]; describes: string } | Fail
> {
  const blocked = checkLinkMode();
  if (blocked) return blocked;
  const prepared = await prepare(prisma, req, lookup);
  if ("ok" in prepared && prepared.ok === false) return prepared;
  const { ctx, amountSatang, describes } = prepared as Prepared;
  return { ok: true, documentNo: ctx.documentNo, amount: fromSatang(amountSatang), verified: ctx.verified, warnings: ctx.warnings, describes };
}

type Prepared = { ctx: Ctx; amountSatang: number; describes: string };

/** Everything that can be decided before the transaction opens. */
async function prepare(prisma: PrismaClient, req: LinkRequest, lookup?: DocumentLookup): Promise<Prepared | Fail> {
  const documentNo = normalizeDocumentNo(req.documentNo);
  if (!documentNo) return fail(400, "Enter the PEAK document number exactly as PEAK shows it");
  if ((req.note ?? "").trim().length < MIN_REASON) return fail(400, "Say why this PEAK document is the right one — the auditor reads this, not the code");

  let amountSatang = 0, describes = "";
  if (req.kind === "ADVANCE") {
    const a = await prisma.guideAdvance.findUnique({ where: { id: req.advanceId } });
    if (!a) return fail(404, "No such advance");
    if (a.reversedAt) return fail(409, `${a.advanceNo} was reversed — a reversed advance holds no balance to link`);
    amountSatang = a.amountSatang;
    describes = `${a.advanceNo} · ${fromSatang(a.amountSatang).toLocaleString()} sent to ${a.guideId}${a.jobNo ? ` for ${a.jobNo}` : ""}`;
  } else if (req.kind === "RETURN") {
    const r = await prisma.guideAdvanceReceipt.findUnique({ where: { id: req.receiptId } });
    if (!r) return fail(404, "No such return");
    if (r.status === "REJECTED") return fail(409, `${r.receiptNo} was rejected — reinstate it before linking a document`);
    amountSatang = r.amountSatang;
    describes = `${r.receiptNo} · ${fromSatang(r.amountSatang).toLocaleString()} returned by ${r.guideId}`;
    const bankRef = (req.bankRef ?? "").trim() || r.bankRef;
    if (r.status === "CLAIMED") {
      const missing = checkConfirmation(bankRef);
      if (missing.length) return fail(400, ...missing);
    }
    const allocations = req.allocations ?? [];
    const total = allocations.reduce((s, a) => s + toSatang(a.amount), 0);
    const already = r.allocatedSatang;
    if (total + already !== r.amountSatang) {
      return fail(409, `Allocate the whole return before linking it: ${fromSatang(r.amountSatang - already).toLocaleString()} is still unallocated`);
    }
    if (allocations.length) {
      const advances = await prisma.guideAdvance.findMany({ where: { id: { in: allocations.map((a) => a.advanceId) } } });
      const reasons = checkAllocations({ receipt: { ...r, status: "VERIFIED" as ReceiptStatus }, advances, allocations });
      if (reasons.length) return fail(409, ...reasons);
    }
  } else {
    const a = await prisma.guideAdvance.findUnique({ where: { id: req.advanceId } });
    if (!a) return fail(404, "No such advance");
    if (a.reversedAt) return fail(409, `${a.advanceNo} was reversed and can settle nothing`);
    const sheet = await prisma.jobSheet.findUnique({ where: { id: req.jobSheetId }, select: { id: true, ref: true, guideId: true, date: true, expenses: true, approvalStatus: true } });
    if (!sheet) return fail(404, "No such job sheet");
    if (sheet.guideId !== a.guideId) return fail(409, "That job sheet belongs to another guide");
    if (sheet.approvalStatus !== "APPROVED") return fail(409, "Approve the job sheet before recording its ticket costs against an advance");
    const tagged = ((sheet.expenses as unknown as Expense[]) ?? []).filter((e) => e.paidBy === "advance" && expenseAmount(e) > 0);
    const notTickets = tagged.filter((e) => expenseCategory(e) !== "entrance");
    if (notTickets.length) {
      // Ticket-only, and it stays that way: meals and transport have their own route
      // through the guide's own reimbursement, and mixing them here would put company
      // money in the wrong account.
      return fail(409, `This advance is for customer tickets only. ${notTickets.map((e) => e.description || "a row").join(", ")} on ${sheet.ref ?? "this job sheet"} is not a ticket — settle it the usual way instead.`);
    }
    const taggedSatang = tagged.reduce((s, e) => s + toSatang(expenseAmount(e)), 0);
    amountSatang = toSatang(req.amount);
    if (!(amountSatang > 0)) return fail(400, "Enter the ticket amount this PEAK document already carries");
    if (amountSatang > taggedSatang) return fail(409, `${sheet.ref ?? "This job sheet"} marks ${fromSatang(taggedSatang).toLocaleString()} of tickets as paid from an advance — a settlement cannot be larger`);
    if (amountSatang > outstandingSatang(a)) return fail(409, `Only ${fromSatang(outstandingSatang(a)).toLocaleString()} is outstanding on ${a.advanceNo}`);
    describes = `${fromSatang(amountSatang).toLocaleString()} of tickets on ${sheet.ref ?? "this job sheet"} against ${a.advanceNo}`;
  }

  const ctx = await verifyDocument(documentNo, req, amountSatang, lookup);
  if ("ok" in ctx && ctx.ok === false) return ctx;
  return { ctx: ctx as Ctx, amountSatang, describes };
}

async function verifyDocument(documentNo: string, req: LinkRequest, amountSatang: number, lookup?: DocumentLookup): Promise<Ctx | Fail> {
  const warnings: string[] = [];
  let config: { advanceAccountCode: string; advanceAccountSubId?: string; bankAccountCode: string; bankAccountSubId: string } | null = null;
  try { config = advancePeakConfig(); } catch { config = null; }

  const read = lookup ?? defaultLookup();
  if (!read || !config) {
    // Nothing to check against. Allowed, but never silently: the link records that
    // its figures were not confirmed, and the person has to acknowledge that.
    warnings.push("FolkOPS could not reach PEAK, so this document was not checked — the number was taken as given");
    if (!req.acknowledgeWarnings) return fail(409, ...warnings, "Confirm that you have checked this document in PEAK yourself");
    return { documentNo, document: null, verified: false, warnings };
  }
  const found = await read(documentNo, req.documentType);
  if (!found.ok) {
    return found.notFound
      ? fail(404, `PEAK has no ${req.documentType === "EXPENSE" ? "expense document" : "journal"} numbered ${documentNo}`)
      : fail(502, `PEAK could not be asked about ${documentNo}: ${found.desc}`);
  }
  const { reasons, warnings: w } = checkDocumentMatches({ kind: req.kind, amountSatang, document: found.document, config });
  if (reasons.length) return fail(409, ...reasons);
  warnings.push(...w);
  if (warnings.length && !req.acknowledgeWarnings) {
    return fail(409, ...warnings, "Confirm that this is the right document before it is linked");
  }
  return { documentNo, document: found.document, verified: warnings.length === 0, warnings };
}

/** The real lookup, kept behind a function so importing this module never needs PEAK. */
function defaultLookup(): DocumentLookup | null {
  return async (documentNo, type) => {
    const api = await import("@/lib/peak-api");
    if (!api.peakEnabled) return { ok: false, desc: "PEAK connection is not configured" };
    if (type === "EXPENSE") {
      const r = await api.getExpense({ code: documentNo });
      if (!r.ok) return { ok: false, desc: r.desc ?? "lookup failed" };
      if (r.notFound) return { ok: false, notFound: true, desc: "not found" };
      return { ok: true, document: { code: documentNo, documentType: "EXPENSE", isVoid: r.expense?.isVoid ?? false } };
    }
    const r = await api.getDailyJournal(documentNo);
    if (!r.ok) return { ok: false, desc: r.desc ?? "lookup failed" };
    if (r.notFound || !r.journal) return { ok: false, notFound: true, desc: "not found" };
    const j = r.journal;
    return { ok: true, document: { code: j.code || documentNo, id: j.id, documentType: "DAILY_JOURNAL", isVoid: j.isVoid, contactId: j.contactId, issuedDate: j.issuedDate, entries: j.entries } };
  };
}

/**
 * Record an existing PEAK document — the only writing path.
 *
 * Everything below happens inside one transaction, including the outbox row the
 * database triggers create when a receipt is confirmed or a settlement is written.
 * That ordering is the point: the trigger enqueues, and this closes it as POSTED
 * before anyone can see it, so the sender never has a window in which to act.
 */
export async function linkExistingPeakDocument(prisma: PrismaClient, req: LinkRequest, lookup?: DocumentLookup): Promise<LinkResult> {
  const blocked = checkLinkMode();
  if (blocked) return blocked;

  // Who owns this number, and is this movement already spoken for? Both are cheap
  // reads, and both come BEFORE asking PEAK: a number already in use is an answer on
  // its own, and there is no reason to read a document to learn it.
  const documentNo = normalizeDocumentNo(req.documentNo);
  if (!documentNo) return fail(400, "Enter the PEAK document number exactly as PEAK shows it");

  // Already linked? Saying the same thing twice is success; saying something
  // different is a mistake worth stopping.
  const existing = await findExistingLink(prisma, req);
  if (existing && "ok" in existing) return existing;
  if (existing) {
    if (existing.documentNo === documentNo && existing.documentType === req.documentType) {
      return { ok: true, replayed: true, documentNo: existing.documentNo, kind: req.kind, sourceId: existing.sourceId, verified: existing.verified, warnings: [] };
    }
    return fail(409, `This is already linked to ${existing.documentNo}. Unlink that first if it was wrong — a second document would double the books.`);
  }
  const clash = await prisma.advancePeakDocumentLink.findUnique({ where: { documentType_documentNo: { documentType: req.documentType, documentNo } } });
  if (clash) return fail(409, `${documentNo} is already recorded against another ${clash.kind.toLowerCase()} — one PEAK document belongs to one movement`);

  // Has the sender already taken this event? A replay of the same document was
  // answered above; anything else here is a person and a worker reaching for the
  // same movement, and the person has to see what the worker did first.
  if (req.kind !== "EXPENSE") {
    const queued = await prisma.advancePeakSync.findUnique({ where: { id: `${req.kind}:${req.kind === "RETURN" ? req.receiptId : req.advanceId}` }, select: { status: true, documentNo: true } });
    if (queued && IN_FLIGHT.includes(queued.status)) {
      return fail(409, queued.status === "POSTED"
        ? `FolkOPS already sent this to PEAK as ${queued.documentNo ?? "a document"} — reconcile that document instead of linking another`
        : `FolkOPS is in the middle of sending this to PEAK (${queued.status.toLowerCase()}). Check PEAK and settle what happened before linking anything.`);
    }
  }

  const prepared = await prepare(prisma, req, lookup);
  if ("ok" in prepared && prepared.ok === false) return prepared;
  const { ctx, amountSatang } = prepared as Prepared;

  try {
    const out = await prisma.$transaction(async (tx) => {
      const linkFields = {
        documentType: req.documentType, documentNo: ctx.documentNo, documentId: ctx.document?.id ?? null,
        source: LINK_SOURCE, status: "LINKED", verified: ctx.verified,
        warning: ctx.warnings.join(" · ") || null, note: req.note.trim(),
        linkedById: req.actor.actorId, linkedAt: new Date(),
      };
      if (req.kind === "ADVANCE") {
        const moved = await tx.guideAdvance.updateMany({ where: { id: req.advanceId, peakDocumentNo: null }, data: { peakDocumentNo: ctx.documentNo, peakRef: ctx.documentNo, peakReference: ctx.documentNo } });
        if (moved.count !== 1) throw new LedgerConflict("This advance already carries a PEAK document — reload the page");
        await closeOutbox(tx, "ADVANCE", req.advanceId, ctx.documentNo, ctx.document?.id ?? null);
        await tx.advancePeakDocumentLink.create({ data: { kind: "ADVANCE", sourceId: req.advanceId, ...linkFields } });
        return { sourceId: req.advanceId };
      }
      if (req.kind === "RETURN") {
        const receipt = await tx.guideAdvanceReceipt.findUnique({ where: { id: req.receiptId } });
        if (!receipt) throw new LedgerConflict("No such return");
        const bankRef = (req.bankRef ?? "").trim() || receipt.bankRef;
        if (receipt.status === "CLAIMED") {
          // The same confirmation the ordinary path performs — the money reached the
          // company account, and the bank statement line says so.
          const confirmed = await tx.guideAdvanceReceipt.updateMany({
            where: { id: receipt.id, status: "CLAIMED" },
            data: { status: "VERIFIED", verifiedAt: new Date(), verifiedById: req.actor.actorId, ...(req.bankAccount ? { bankAccount: req.bankAccount } : {}), ...(bankRef ? { bankRef } : {}) },
          });
          if (confirmed.count !== 1) throw new LedgerConflict(`${receipt.receiptNo} changed while you were linking it — reload the page`);
        }
        for (const line of [...(req.allocations ?? [])].sort((a, b) => a.advanceId.localeCompare(b.advanceId))) {
          const satang = toSatang(line.amount);
          if (!(await bumpReceipt(tx, receipt.id, satang))) throw new LedgerConflict(`${receipt.receiptNo} does not have ${fromSatang(satang).toLocaleString()} left to allocate`);
          if (!(await bumpAdvance(tx, line.advanceId, satang))) throw new LedgerConflict(`That advance no longer has ${fromSatang(satang).toLocaleString()} outstanding — reload and try again`);
          await tx.guideAdvanceEntry.create({
            data: {
              advanceId: line.advanceId, type: "RETURN_ALLOCATION", amountSatang: satang,
              effectiveDate: receipt.receivedDate, accountingPeriod: periodOf(receipt.receivedDate),
              sourceType: "RECEIPT", sourceId: receipt.id, receiptId: receipt.id,
              requestKey: req.requestKey, idempotencyKey: idempotencyKeyFor(req.requestKey, line.advanceId),
              peakDocumentNo: ctx.documentNo, peakReference: ctx.documentNo,
              provenance: "OPERATOR", createdById: req.actor.actorId,
            },
          });
        }
        await tx.guideAdvanceReceipt.update({ where: { id: receipt.id }, data: { peakDocumentNo: ctx.documentNo, peakReference: ctx.documentNo } });
        await closeOutbox(tx, "RETURN", receipt.id, ctx.documentNo, ctx.document?.id ?? null);
        await tx.advancePeakDocumentLink.create({ data: { kind: "RETURN", sourceId: receipt.id, ...linkFields } });
        return { sourceId: receipt.id };
      }
      // EXPENSE — the settlement itself is written here, because the cost is already
      // in PEAK: the ledger has to agree with the document, not produce another one.
      const sheet = await tx.jobSheet.findUnique({ where: { id: req.jobSheetId }, select: { id: true, ref: true, date: true, expenses: true } });
      if (!sheet) throw new LedgerConflict("No such job sheet");
      if (!(await bumpAdvance(tx, req.advanceId, amountSatang))) throw new LedgerConflict("That advance no longer has this amount outstanding — reload and try again");
      const rows = ((sheet.expenses as unknown as Expense[]) ?? []).filter((e) => e.paidBy === "advance" && expenseCategory(e) === "entrance" && expenseAmount(e) > 0);
      const entry = await tx.guideAdvanceEntry.create({
        data: {
          advanceId: req.advanceId, type: "EXPENSE_SETTLEMENT", amountSatang,
          effectiveDate: sheet.date, accountingPeriod: periodOf(sheet.date),
          sourceType: "JOB_SHEET", sourceId: sheet.id, jobNo: sheet.ref,
          snapshot: { rows: rows.map((e) => ({ description: e.description, amount: expenseAmount(e), category: e.expenseType ?? null, peakAccountCode: e.peakAccountCode ?? null })), linkedDocument: ctx.documentNo } as Prisma.InputJsonValue,
          requestKey: req.requestKey, idempotencyKey: idempotencyKeyFor(req.requestKey, req.advanceId),
          peakDocumentNo: ctx.documentNo, peakReference: ctx.documentNo,
          provenance: "OPERATOR", createdById: req.actor.actorId,
        },
        select: { id: true },
      });
      await closeOutbox(tx, "EXPENSE", entry.id, ctx.documentNo, ctx.document?.id ?? null);
      await tx.advancePeakDocumentLink.create({ data: { kind: "EXPENSE", sourceId: entry.id, ...linkFields } });
      return { sourceId: entry.id };
    });

    await audit({
      ...req.actor, action: "advance.peak_document_linked", entityType: "AdvancePeakDocumentLink", entityId: out.sourceId,
      detail: {
        kind: req.kind, documentType: req.documentType, documentNo: ctx.documentNo, amount: fromSatang(amountSatang),
        verified: ctx.verified, warnings: ctx.warnings, note: req.note.trim(), source: LINK_SOURCE,
      },
    });
    return { ok: true, replayed: false, documentNo: ctx.documentNo, kind: req.kind, sourceId: out.sourceId, verified: ctx.verified, warnings: ctx.warnings };
  } catch (e) {
    if (e instanceof LedgerConflict) return fail(409, e.message);
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // Two people, or two tabs, reaching the same movement at once. Which unique
      // key gave way says which of the two mistakes it was.
      const target = String((e.meta as { target?: unknown } | undefined)?.target ?? "");
      if (target.includes("kind_sourceId") || target.includes("idempotencyKey")) {
        return fail(409, "Someone recorded a document for this movement a moment ago — reload the page to see it");
      }
      return fail(409, `${ctx.documentNo} is already recorded against another movement — one PEAK document belongs to one movement`);
    }
    throw e;
  }
}

type ExistingLink = { documentNo: string; documentType: string; sourceId: string; verified: boolean };

/**
 * The link this event already has — or the reason it cannot take one.
 *
 * A settlement is identified by the ledger entry it wrote, which is also how the
 * ledger's own unique index identifies it: one live settlement per (advance, job
 * sheet). If that entry exists and carries no document, linking would have to write
 * a second settlement, so this refuses instead.
 */
async function findExistingLink(prisma: PrismaClient, req: LinkRequest): Promise<ExistingLink | Fail | null> {
  if (req.kind !== "EXPENSE") {
    const link = await peakLinkFor(prisma, req.kind, req.kind === "RETURN" ? req.receiptId : req.advanceId);
    return link ? { documentNo: link.documentNo, documentType: link.documentType, sourceId: link.sourceId, verified: link.verified } : null;
  }
  const entry = await prisma.guideAdvanceEntry.findFirst({
    where: { advanceId: req.advanceId, sourceType: "JOB_SHEET", sourceId: req.jobSheetId, type: "EXPENSE_SETTLEMENT", reversedByEntryId: null },
    select: { id: true },
  });
  if (!entry) return null;
  const link = await peakLinkFor(prisma, "EXPENSE", entry.id);
  if (link) return { documentNo: link.documentNo, documentType: link.documentType, sourceId: link.sourceId, verified: link.verified };
  return fail(409, "This job sheet has already settled part of that advance without a PEAK document. Reverse that ledger line first if it was wrong.");
}

/**
 * Close the outbox item for this event. The row may not exist yet (an advance from
 * before the outbox), may have just been created by a trigger inside this same
 * transaction, or may already be closed — all three end in the same place.
 */
async function closeOutbox(tx: Prisma.TransactionClient, kind: LinkKind, sourceId: string, documentNo: string, documentId: string | null) {
  const id = `${kind}:${sourceId}`;
  const current = await tx.advancePeakSync.findUnique({ where: { id }, select: { status: true } });
  if (current && ["SENDING", "UNCERTAIN", "POSTED"].includes(current.status)) {
    throw new LedgerConflict(`FolkOPS has already sent this to PEAK (${current.status.toLowerCase()}) — reconcile that document before linking another`);
  }
  await tx.advancePeakSync.upsert({
    where: { id },
    create: { id, kind, sourceId, status: "POSTED", documentNo, documentId, error: null, payload: Prisma.DbNull },
    update: { status: "POSTED", documentNo, documentId, error: null, nextAttemptAt: new Date() },
  });
}
