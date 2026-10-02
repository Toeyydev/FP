import { Prisma, type PrismaClient } from "@prisma/client";
import { audit } from "@/lib/audit";
import {
  advanceAutoSyncEnabled, AUTO_SYNC_ON_MESSAGE, existingPeakLinksEnabled, EXISTING_LINKS_OFF_MESSAGE,
} from "./freeze";
import { advancePeakConfig } from "./peak-sync";
import { bumpAdvance, bumpReceipt, LedgerConflict, type Actor, type Fail } from "./service";
import {
  checkAllocations, checkConfirmation, fromSatang, idempotencyKeyFor, isBookedInGuidePayment, MIN_REASON,
  periodOf, toSatang, type AllocationRequest, type ReceiptStatus,
} from "./rules";
import { amountsByAccount, expenseAccountsFrom, settlementLines } from "./expense-accounts";
import { describeOwner, incompatibleOwners, peakDocumentOwners, type LinkEvent } from "./peak-ownership";
import { summariesFor } from "./summaries";

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
//
// Phase 1E (owner 2026-10-02) hardened what "the figures" are:
//   * an expense settlement is linked as the ledger recorded it — its explicit lines
//     (lib/advances/expense-accounts), any allowed category, each through the saved account
//     chart. The job sheet as it is now is never re-added, and the older `rows` copy is
//     never an amount. Linking no longer WRITES a settlement: settle first, then link.
//   * a return is linked for what was ALLOCATED to advances, never its face value: money
//     refunded to the guide was never the advance's.
//   * an advance issue is a bank transfer onto an asset — never an expense document.
//   * one canonical ownership check (lib/advances/peak-ownership): a PEAK document has one
//     financial owner in FolkOPS; any other owner is refused, by name. No sharing in Phase 1.
//   * a manual link may be removed only with a reason, audited, and never while something
//     downstream depends on it (unlinkPeakDocument).

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
 * An expense settlement is checked on the advance side and, for a journal, on each mapped
 * expense account — both exactly, no tolerance. An EXPENSE document's lines are not exposed
 * by the read API, so one is linked only with a warning that its figures were not
 * machine-checked — and only if no other FolkOPS event owns it (lib/advances/peak-ownership:
 * one owner per document; a job's guide-payment document is NOT shared with its settlement).
 */
export function checkDocumentMatches(input: {
  kind: LinkKind; amountSatang: number; document: PeakDocument;
  config: { advanceAccountCode: string; advanceAccountSubId?: string; bankAccountCode: string; bankAccountSubId: string };
  /** EXPENSE: what each mapped expense account must be debited, from the settlement's lines. */
  expenseByAccount?: Map<string, number>;
  /** RETURN with part of it refunded to the guide: how that excess is booked is an accountant decision, so the bank side is not judged. */
  bankSideUnchecked?: boolean;
  /** The guide's PEAK contact, when FolkOPS knows it. */
  guideContactId?: string | null;
}): { reasons: string[]; warnings: string[] } {
  const { kind, amountSatang, document: doc, config } = input;
  const reasons: string[] = [], warnings: string[] = [];
  if (doc.isVoid) return { reasons: [`${doc.code} is void in PEAK — a void document cannot carry this movement`], warnings };
  if (doc.documentType !== "DAILY_JOURNAL") {
    // An advance issue and a return are bank transfers onto / off an asset. An expense
    // document (a guide payment, a supplier bill) can never be either of them.
    if (kind === "ADVANCE") return { reasons: [`${doc.code} is an expense document — an advance issue is money moved onto the advance asset, not an expense`], warnings };
    if (kind === "RETURN") return { reasons: [`${doc.code} is an expense document — a guide's return is money coming back into the bank, not an expense`], warnings };
    // An expense document's payment lines are not exposed by the read API, so the
    // figures cannot be machine-checked. Say so instead of implying they were.
    warnings.push(`${doc.code} is an expense document — FolkOPS could not check its figures, only that it exists`);
    return { reasons, warnings };
  }
  const entries = doc.entries ?? [];
  if (!entries.length) return { reasons: [`${doc.code} has no journal lines to check`], warnings };
  if (input.guideContactId && doc.contactId && doc.contactId !== input.guideContactId) {
    reasons.push(`${doc.code} is for another PEAK contact, not this guide`);
  }
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
    if (advCredit !== 0) reasons.push(`${doc.code} also credits the advance account — an advance issue only puts money onto it`);
    const bank = entries.filter((e) => sameAccount(e, config.bankAccountCode, config.bankAccountSubId));
    const bankCredit = bank.reduce((s, e) => s + satangOf(e.credit), 0);
    if (!bank.length) reasons.push(`${doc.code} does not credit the company bank account ${config.bankAccountCode}`);
    else if (bankCredit !== amountSatang) reasons.push(`${doc.code} credits ${money(bankCredit)} from the bank, not ${money(amountSatang)}`);
  } else if (kind === "RETURN") {
    if (advCredit !== amountSatang) reasons.push(`${doc.code} credits ${money(advCredit)} to the advance account, not ${money(amountSatang)}`);
    if (input.bankSideUnchecked) {
      warnings.push(`Part of this return was refunded to the guide. How the bank side of that is booked is an accountant decision, so FolkOPS checked the advance side only`);
    } else {
      const bank = entries.filter((e) => sameAccount(e, config.bankAccountCode, config.bankAccountSubId));
      const bankDebit = bank.reduce((s, e) => s + satangOf(e.debit), 0);
      if (!bank.length) reasons.push(`${doc.code} does not debit the company bank account ${config.bankAccountCode}`);
      else if (bankDebit !== amountSatang) reasons.push(`${doc.code} debits ${money(bankDebit)} to the bank, not ${money(amountSatang)}`);
    }
  } else {
    if (advCredit !== amountSatang) reasons.push(`${doc.code} takes ${money(advCredit)} out of the advance account, not ${money(amountSatang)}`);
    for (const [account, satang] of input.expenseByAccount ?? []) {
      const debit = entries.filter((e) => e.accountCode === account).reduce((s, e) => s + satangOf(e.debit), 0);
      if (debit !== satang) reasons.push(`${doc.code} debits ${money(debit)} to expense account ${account}, but the settlement's lines put ${money(satang)} there`);
    }
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
  // A settlement already in the ledger (written from explicit lines). `amount`, when given,
  // must equal it exactly; `entryId`, when given, must be that settlement.
  | { kind: "EXPENSE"; advanceId: string; jobSheetId: string; amount?: number | null; entryId?: string | null }
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

type Prepared = { ctx: Ctx; amountSatang: number; describes: string; sourceId: string };
type Check = {
  amountSatang: number; describes: string; event: LinkEvent;
  expenseByAccount?: Map<string, number>; bankSideUnchecked?: boolean; guideId: string;
};

/** A ledger problem on any advance involved refuses the link — the books must add up first. */
async function ledgerProblems(prisma: PrismaClient, advanceIds: string[]): Promise<string[]> {
  if (!advanceIds.length) return [];
  const advances = await prisma.guideAdvance.findMany({ where: { id: { in: advanceIds } } });
  const sums = await summariesFor(prisma, advances);
  return advances.flatMap((a) => {
    const s = sums.get(a.id);
    return s && (s.problems.length || s.driftSatang !== 0)
      ? [`${a.advanceNo}'s ledger does not add up (${[...s.problems, s.driftSatang ? `counter off by ${fromSatang(s.driftSatang)}` : ""].filter(Boolean).join(", ")}) — fix that before linking anything to PEAK`]
      : [];
  });
}

/** The live settlement of this advance on this job sheet, if there is one. */
async function liveSettlement(prisma: PrismaClient, advanceId: string, jobSheetId: string) {
  return prisma.guideAdvanceEntry.findFirst({
    where: { advanceId, sourceType: "JOB_SHEET", sourceId: jobSheetId, type: "EXPENSE_SETTLEMENT", reversedByEntryId: null },
  });
}

/** What this event is, what it must amount to, and who it is for. Reads only. */
async function describeEvent(prisma: PrismaClient, req: LinkRequest): Promise<Check | Fail> {
  if (req.kind === "ADVANCE") {
    const a = await prisma.guideAdvance.findUnique({ where: { id: req.advanceId } });
    if (!a) return fail(404, "No such advance");
    if (a.reversedAt) return fail(409, `${a.advanceNo} was reversed — a reversed advance holds no balance to link`);
    const problems = await ledgerProblems(prisma, [a.id]);
    if (problems.length) return fail(409, ...problems);
    return {
      amountSatang: a.amountSatang, guideId: a.guideId, event: { kind: "ADVANCE", sourceId: a.id },
      describes: `${a.advanceNo} · ${fromSatang(a.amountSatang).toLocaleString()} sent to ${a.guideId}${a.jobNo ? ` for ${a.jobNo}` : ""}`,
    };
  }
  if (req.kind === "RETURN") {
    const r = await prisma.guideAdvanceReceipt.findUnique({ where: { id: req.receiptId } });
    if (!r) return fail(404, "No such return");
    if (r.status === "REJECTED" || r.status === "VOIDED") return fail(409, `${r.receiptNo} was ${r.status.toLowerCase()} — it carries no money to link`);
    const bankRef = (req.bankRef ?? "").trim() || r.bankRef;
    if (r.status === "CLAIMED") {
      const missing = checkConfirmation(bankRef);
      if (missing.length) return fail(400, ...missing);
    }
    const allocations = req.allocations ?? [];
    const adding = allocations.reduce((s, a) => s + toSatang(a.amount), 0);
    const refunds = await prisma.guideAdvanceRefund.findMany({ where: { receiptId: r.id }, select: { status: true, amountSatang: true } });
    const paidBack = refunds.filter((f) => f.status === "PAID").reduce((s, f) => s + f.amountSatang, 0);
    const pending = refunds.filter((f) => f.status === "RECORDED" || f.status === "APPROVED");
    if (pending.length) return fail(409, `${r.receiptNo} has a refund to the guide still ${pending[0].status.toLowerCase()} — pay or void it first, so the amount the advance got back is final`);
    // The return's accounting is what reached the advance(s): allocated, after this link's own allocations.
    const allocatedAfter = r.allocatedSatang + adding;
    const left = r.amountSatang - allocatedAfter - paidBack;
    if (left !== 0) {
      return fail(409, left > 0
        ? `Put the whole return somewhere before linking it: ${fromSatang(left).toLocaleString()} of ${r.receiptNo} is neither allocated to an advance nor refunded to the guide`
        : `These allocations would put ${fromSatang(-left).toLocaleString()} more against advances than ${r.receiptNo} has left`);
    }
    if (!(allocatedAfter > 0)) return fail(409, `${r.receiptNo} has nothing allocated to an advance — there is no return to link`);
    if (allocations.length) {
      const advances = await prisma.guideAdvance.findMany({ where: { id: { in: allocations.map((a) => a.advanceId) } } });
      const reasons = checkAllocations({ receipt: { ...r, status: "VERIFIED" as ReceiptStatus }, advances, allocations });
      if (reasons.length) return fail(409, ...reasons);
    }
    const touched = [...new Set([...(await prisma.guideAdvanceEntry.findMany({ where: { receiptId: r.id }, select: { advanceId: true } })).map((e) => e.advanceId), ...allocations.map((a) => a.advanceId)])];
    const problems = await ledgerProblems(prisma, touched);
    if (problems.length) return fail(409, ...problems);
    return {
      amountSatang: allocatedAfter, guideId: r.guideId, event: { kind: "RETURN", sourceId: r.id }, bankSideUnchecked: paidBack > 0,
      describes: `${r.receiptNo} · ${fromSatang(allocatedAfter).toLocaleString()} returned to the advance by ${r.guideId}${paidBack ? ` (of ${fromSatang(r.amountSatang).toLocaleString()} received; ${fromSatang(paidBack).toLocaleString()} refunded to the guide)` : ""}`,
    };
  }
  // EXPENSE — an existing settlement, exactly as the ledger recorded it.
  const a = await prisma.guideAdvance.findUnique({ where: { id: req.advanceId } });
  if (!a) return fail(404, "No such advance");
  if (a.reversedAt) return fail(409, `${a.advanceNo} was reversed and can settle nothing`);
  const sheet = await prisma.jobSheet.findUnique({ where: { id: req.jobSheetId }, select: { id: true, ref: true, guideId: true, date: true, slotIdx: true, approvalStatus: true } });
  if (!sheet) return fail(404, "No such job sheet");
  if (sheet.guideId !== a.guideId) return fail(409, "That job sheet belongs to another guide");
  if (sheet.date !== a.date || sheet.slotIdx !== a.slotIdx) return fail(409, `${a.advanceNo} was not issued for ${sheet.ref ?? "this job"}`);
  if (sheet.approvalStatus !== "APPROVED") return fail(409, "Approve the job sheet before linking its settlement to PEAK");
  const entry = await liveSettlement(prisma, a.id, sheet.id);
  if (!entry) return fail(409, `${sheet.ref ?? "This job sheet"} has no live settlement against ${a.advanceNo} — settle the rows first (on the advance card); linking never writes a settlement`);
  if (req.entryId && req.entryId !== entry.id) return fail(409, "That is not the live settlement for this advance and job — reload the page");
  // Already recorded as carried by the job's guide-payment document: a link to another PEAK
  // document would be a second claim on the same cost.
  const closed = await prisma.advancePeakSync.findUnique({ where: { id: `EXPENSE:${entry.id}` }, select: { status: true, documentNo: true, error: true } });
  if (isBookedInGuidePayment(closed)) return fail(409, `This settlement is recorded as already booked in guide payment ${closed!.documentNo} — it cannot also be linked to another PEAK document`);
  const lines = settlementLines(entry, a);
  if (!lines.ok) return fail(409, ...lines.reasons);
  if (req.amount != null && toSatang(req.amount) !== entry.amountSatang) {
    return fail(409, `The settlement is ${fromSatang(entry.amountSatang).toLocaleString()}, not ${Number(req.amount).toLocaleString()} — the amount comes from the ledger`);
  }
  const accounts = expenseAccountsFrom(await prisma.peakAccountMapping.findMany({ select: { folkopsCategory: true, peakAccountCode: true, peakAccountName: true, isActive: true } }));
  const byAccount = amountsByAccount(lines.lines, accounts);
  if (!byAccount.ok) return fail(409, ...byAccount.reasons);
  const problems = await ledgerProblems(prisma, [a.id]);
  if (problems.length) return fail(409, ...problems);
  const cats = [...new Set(lines.lines.map((l) => l.category))].join(", ");
  return {
    amountSatang: entry.amountSatang, guideId: a.guideId, expenseByAccount: byAccount.byAccount,
    event: { kind: "EXPENSE", sourceId: entry.id, job: { sheetId: sheet.id, guideId: sheet.guideId, date: sheet.date, slotIdx: sheet.slotIdx } },
    describes: `${fromSatang(entry.amountSatang).toLocaleString()} of ${cats} on ${sheet.ref ?? "this job sheet"} settled from ${a.advanceNo} (${lines.lines.length} line${lines.lines.length === 1 ? "" : "s"})`,
  };
}

/** Everything that can be decided before the transaction opens. */
async function prepare(prisma: PrismaClient, req: LinkRequest, lookup?: DocumentLookup): Promise<Prepared | Fail> {
  const documentNo = normalizeDocumentNo(req.documentNo);
  if (!documentNo) return fail(400, "Enter the PEAK document number exactly as PEAK shows it");
  if ((req.note ?? "").trim().length < MIN_REASON) return fail(400, "Say why this PEAK document is the right one — the auditor reads this, not the code");

  const check = await describeEvent(prisma, req);
  if ("ok" in check && check.ok === false) return check;
  const c = check as Check;

  // One canonical ownership answer (lib/advances/peak-ownership).
  const clash = incompatibleOwners(await peakDocumentOwners(prisma, documentNo), c.event);
  if (clash.length) return fail(409, `${documentNo} is already recorded against ${clash.map(describeOwner).join("; ")} — one PEAK document cannot also carry this movement`);

  const guide = await prisma.user.findFirst({ where: { guideId: c.guideId }, select: { peakContactId: true } });
  const ctx = await verifyDocument(documentNo, req, c, guide?.peakContactId ?? null, lookup);
  if ("ok" in ctx && ctx.ok === false) return ctx;
  return { ctx: ctx as Ctx, amountSatang: c.amountSatang, describes: c.describes, sourceId: c.event.sourceId };
}

async function verifyDocument(documentNo: string, req: LinkRequest, c: Check, guideContactId: string | null, lookup?: DocumentLookup): Promise<Ctx | Fail> {
  const warnings: string[] = [];
  if (req.documentType === "EXPENSE" && req.kind !== "EXPENSE") {
    return fail(409, req.kind === "ADVANCE"
      ? "An advance issue is money moved onto the advance asset — it is never an expense document"
      : "A guide's return is money coming back into the bank — it is never an expense document");
  }
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
  const { reasons, warnings: w } = checkDocumentMatches({
    kind: req.kind, amountSatang: c.amountSatang, document: found.document, config,
    expenseByAccount: c.expenseByAccount, bankSideUnchecked: c.bankSideUnchecked, guideContactId,
  });
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
 * database triggers create when a receipt is confirmed. That ordering is the point: the
 * trigger enqueues, and this closes it as POSTED before anyone can see it, so the sender
 * never has a window in which to act.
 */
export async function linkExistingPeakDocument(prisma: PrismaClient, req: LinkRequest, lookup?: DocumentLookup): Promise<LinkResult> {
  const blocked = checkLinkMode();
  if (blocked) return blocked;

  const documentNo = normalizeDocumentNo(req.documentNo);
  if (!documentNo) return fail(400, "Enter the PEAK document number exactly as PEAK shows it");

  // Already linked? Saying the same thing twice is success — no second audit, no second
  // row; saying something different is a mistake worth stopping.
  const existing = await findExistingLink(prisma, req);
  if (existing) {
    if (existing.documentNo === documentNo && existing.documentType === req.documentType) {
      return { ok: true, replayed: true, documentNo: existing.documentNo, kind: req.kind, sourceId: existing.sourceId, verified: existing.verified, warnings: [] };
    }
    return fail(409, `This is already linked to ${existing.documentNo}. If that was wrong, remove that link first (with a reason) — a second document would double the books.`);
  }

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
  const { ctx, amountSatang, sourceId } = prepared as Prepared;

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
        // What the prepare step validated must still be true inside the transaction.
        const now = await tx.guideAdvanceReceipt.findUniqueOrThrow({ where: { id: receipt.id }, select: { allocatedSatang: true } });
        if (now.allocatedSatang !== amountSatang) throw new LedgerConflict(`${receipt.receiptNo} changed while you were linking it — reload the page`);
        await tx.guideAdvanceReceipt.update({ where: { id: receipt.id }, data: { peakDocumentNo: ctx.documentNo, peakReference: ctx.documentNo } });
        await closeOutbox(tx, "RETURN", receipt.id, ctx.documentNo, ctx.document?.id ?? null);
        await tx.advancePeakDocumentLink.create({ data: { kind: "RETURN", sourceId: receipt.id, ...linkFields } });
        return { sourceId: receipt.id };
      }
      // EXPENSE — the settlement already exists; only the document is recorded against it.
      const entry = await tx.guideAdvanceEntry.findUnique({ where: { id: sourceId }, select: { id: true, reversedByEntryId: true, amountSatang: true } });
      if (!entry || entry.reversedByEntryId || entry.amountSatang !== amountSatang) throw new LedgerConflict("That settlement changed while you were linking it — reload the page");
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
      if (target.includes("kind_sourceId") || target.includes("kind") || target.includes("idempotencyKey")) {
        return fail(409, "Someone recorded a document for this movement a moment ago — reload the page to see it");
      }
      return fail(409, `${ctx.documentNo} is already recorded against another movement — one PEAK document belongs to one movement`);
    }
    throw e;
  }
}

type ExistingLink = { documentNo: string; documentType: string; sourceId: string; verified: boolean };

/** The link this event already has, if any. A settlement is identified by its live ledger entry. */
async function findExistingLink(prisma: PrismaClient, req: LinkRequest): Promise<ExistingLink | null> {
  let sourceId: string | null;
  if (req.kind === "EXPENSE") sourceId = (await liveSettlement(prisma, req.advanceId, req.jobSheetId))?.id ?? null;
  else sourceId = req.kind === "RETURN" ? req.receiptId : req.advanceId;
  if (!sourceId) return null;
  const link = await peakLinkFor(prisma, req.kind, sourceId);
  return link ? { documentNo: link.documentNo, documentType: link.documentType, sourceId: link.sourceId, verified: link.verified } : null;
}

/**
 * Close the outbox item for this event. The row may not exist yet (an advance from
 * before the outbox), may have just been created by a trigger inside this same
 * transaction, or may already be closed — all three end in the same place.
 */
async function closeOutbox(tx: Prisma.TransactionClient, kind: LinkKind, sourceId: string, documentNo: string, documentId: string | null) {
  const id = `${kind}:${sourceId}`;
  const current = await tx.advancePeakSync.findUnique({ where: { id }, select: { status: true, documentNo: true, error: true } });
  if (current && ["SENDING", "UNCERTAIN", "POSTED"].includes(current.status)) {
    throw new LedgerConflict(`FolkOPS has already sent this to PEAK (${current.status.toLowerCase()}) — reconcile that document before linking another`);
  }
  // The same guard inside the transaction, so a link racing the "booked in guide payment" action cannot overwrite it.
  if (isBookedInGuidePayment(current)) throw new LedgerConflict(`This settlement is recorded as already booked in guide payment ${current!.documentNo} — it cannot also be linked to another PEAK document`);
  await tx.advancePeakSync.upsert({
    where: { id },
    create: { id, kind, sourceId, status: "POSTED", documentNo, documentId, error: null, payload: Prisma.DbNull },
    update: { status: "POSTED", documentNo, documentId, error: null, nextAttemptAt: new Date() },
  });
}

/**
 * Remove a MANUAL link that named the wrong document — the one correction flow.
 *
 * Only a link a person recorded (never a document the sender created), only with a reason,
 * and never while something downstream rests on it: an advance whose settlements or returns
 * are themselves in PEAK keeps its link. The ledger is not touched — the money moved; only
 * the claim "this PEAK document carries it" is withdrawn. The outbox item is CANCELLED, not
 * re-queued: the sender must never post a movement a person just said is already in PEAK
 * under some number; the next step is linking the right document.
 */
export async function unlinkPeakDocument(prisma: PrismaClient, input: { kind: LinkKind; sourceId: string; reason: string; actor: Actor }): Promise<{ ok: true; documentNo: string } | Fail> {
  const blocked = checkLinkMode();
  if (blocked) return blocked;
  if ((input.reason ?? "").trim().length < MIN_REASON) return fail(400, "Say why this link is wrong — the auditor reads this");
  const link = await peakLinkFor(prisma, input.kind, input.sourceId);
  if (!link) {
    const outbox = await prisma.advancePeakSync.findUnique({ where: { id: `${input.kind}:${input.sourceId}` }, select: { status: true, documentNo: true } });
    return outbox?.status === "POSTED"
      ? fail(409, `FolkOPS itself posted this to PEAK (${outbox.documentNo ?? "a document"}) — correct it in PEAK; there is no manual link to remove`)
      : fail(404, "There is no manual PEAK link on this movement");
  }
  if (link.source !== LINK_SOURCE) return fail(409, "This link was not recorded by hand — correct it in PEAK instead");

  // Downstream: an advance's later movements rest on the advance being in PEAK.
  if (input.kind === "ADVANCE") {
    const entries = await prisma.guideAdvanceEntry.findMany({ where: { advanceId: input.sourceId, reversedByEntryId: null }, select: { id: true, type: true, receiptId: true } });
    const ids = [...entries.filter((e) => e.type === "EXPENSE_SETTLEMENT").map((e) => `EXPENSE:${e.id}`), ...entries.filter((e) => e.receiptId).map((e) => `RETURN:${e.receiptId}`)];
    const downstream = ids.length ? await prisma.advancePeakSync.findMany({ where: { id: { in: ids }, status: { in: ["SENDING", "UNCERTAIN", "POSTED"] } }, select: { id: true, documentNo: true } }) : [];
    if (downstream.length) return fail(409, `Settlements or returns of this advance are already in PEAK (${downstream.map((d) => d.documentNo ?? d.id).join(", ")}) — remove those first`);
  }

  const conflict = await prisma.$transaction(async (tx) => {
    const gone = await tx.advancePeakDocumentLink.deleteMany({ where: { id: link.id, documentNo: link.documentNo } });
    if (gone.count !== 1) throw new LedgerConflict("That link changed a moment ago — reload the page");
    await tx.advancePeakSync.updateMany({
      where: { id: `${input.kind}:${input.sourceId}`, status: "POSTED", documentNo: link.documentNo },
      data: { status: "CANCELLED", error: `Manual PEAK link ${link.documentNo} removed: ${input.reason.trim()}. Link the right document — nothing will be sent automatically.` },
    });
    if (input.kind === "ADVANCE") await tx.guideAdvance.updateMany({ where: { id: input.sourceId, peakDocumentNo: link.documentNo }, data: { peakDocumentNo: null, peakRef: null, peakReference: null } });
    if (input.kind === "RETURN") {
      await tx.guideAdvanceReceipt.updateMany({ where: { id: input.sourceId, peakDocumentNo: link.documentNo }, data: { peakDocumentNo: null, peakReference: null } });
      await tx.guideAdvanceEntry.updateMany({ where: { receiptId: input.sourceId, peakDocumentNo: link.documentNo }, data: { peakDocumentNo: null, peakReference: null } });
    }
    return null;
  }).catch((e) => { if (e instanceof LedgerConflict) return e; throw e; });
  if (conflict) return fail(409, conflict.message);

  await audit({
    ...input.actor, action: "advance.peak_document_unlinked", entityType: "AdvancePeakDocumentLink", entityId: input.sourceId,
    detail: {
      kind: input.kind, reason: input.reason.trim(),
      before: { documentNo: link.documentNo, documentType: link.documentType, verified: link.verified, note: link.note, warning: link.warning, linkedAt: link.linkedAt.toISOString(), linkedById: link.linkedById },
    },
  });
  return { ok: true, documentNo: link.documentNo };
}
