// Reconciling the Company ADV → PEAK outbox (AdvancePeakSync) by a person — owner 2026-11-15.
//
// The automatic sender (lib/advances/peak-sync) stops by design whenever it cannot be sure:
//   BLOCKED   the movement could not be sent (missing contact, unmapped account, PEAK refused).
//             The sender tries again every 5 minutes; "Retry now" only brings that forward.
//   UNCERTAIN PEAK may or may not have created the journal (a crash, a timeout, an answer
//             without a document number). The sender never resends one of these. Before this
//             module, nothing could move it on.
//
// Resolving UNCERTAIN takes a person who has looked in PEAK, a reason, and leaves an audit entry:
//   FOUND        "the journal is in PEAK as JV-…": FolkOPS reads that journal (read-only) and
//                accepts it only if it is exactly what FolkOPS sent — the same lines, date and
//                contact, not void, and not already claimed by any other FolkOPS record.
//   NOT_IN_PEAK  "I checked PEAK and it is not there": the item goes back to the sender.
//
// PEAK journals carry no searchable reference (checked against PEAK, 2026-10), so FolkOPS cannot
// look a movement up by FOLK-ADV number; that is why a person decides, never a timer.
//
// Who: ADMIN and ACCOUNTANT (owner 2026-11-15). Recording an advance stays ADMIN/OPERATOR.
// Nothing here changes an amount, a ledger entry or a PEAK document.

import type { Prisma, PrismaClient } from "@prisma/client";
import { normalizeDocumentNo, checkDocumentMatches, type DocumentLookup, type PeakDocument, type PeakJournalEntry } from "@/lib/advances/peak-link";
import { advancePeakConfig } from "@/lib/advances/peak-sync";
import { peakDocumentOwners, describeOwner } from "@/lib/advances/peak-ownership";
import { logSync, markPosted } from "@/lib/advances/peak-sync-record";

export type SyncStatus = "PENDING" | "BLOCKED" | "SENDING" | "UNCERTAIN" | "POSTED" | "CANCELLED";

/** The owner's names for the outbox states (spec 2026-11-15). The stored values do not change. */
export const SYNC_LABEL: Record<string, string> = {
  PENDING: "Not synced",
  SENDING: "Syncing",
  POSTED: "Synced",
  BLOCKED: "Failed",
  UNCERTAIN: "Reconciliation required",
  CANCELLED: "Cancelled",
};

/** Retry / Resolve / Re-check: ADMIN and ACCOUNTANT only. */
export const mayReconcile = (role?: string | null) => role === "ADMIN" || role === "ACCOUNTANT";

export const MIN_REASON = 8;
import type { SyncActor as Actor } from "@/lib/advances/peak-sync-record";
type Fail = { ok: false; status: number; reasons: string[] };
const fail = (status: number, ...reasons: string[]): Fail => ({ ok: false, status, reasons });

type Db = Pick<PrismaClient, "advancePeakSync" | "auditLog" | "$transaction">;

// ── what FolkOPS sent vs what PEAK holds ───────────────────────────────────────────────────

type SentEntry = { accountCode: string; accountSubId?: string; debit: string | number; credit: string | number };
export type SentPayload = { issuedDate?: string; contactId?: string | null; reference?: string; journalEntries?: SentEntry[] };

const satang = (v: string | number | null | undefined) => Math.round(Number(v ?? 0) * 100);
const digits = (d?: string | null) => (d ?? "").replace(/\D/g, "").slice(0, 8);
const lineKey = (accountCode: string, sub: string | null | undefined, debit: number, credit: number) => `${accountCode}|${sub ?? ""}|${debit}|${credit}`;

/**
 * Is this PEAK journal exactly the one FolkOPS sent? Pure. Lines compared as a multiset of
 * (account, sub-account, debit, credit) in satang — no tolerance, order ignored.
 */
export function compareWithSent(sent: SentPayload | null | undefined, doc: PeakDocument): string[] {
  if (!sent?.journalEntries?.length) return ["FolkOPS has no record of what it sent for this item, so it cannot confirm a document — use Link existing document instead"];
  if (doc.isVoid) return [`${doc.code} is void in PEAK`];
  if (doc.documentType !== "DAILY_JOURNAL") return [`${doc.code} is not a daily journal`];
  const reasons: string[] = [];
  const want = sent.journalEntries.map((e) => lineKey(e.accountCode, e.accountSubId, satang(e.debit), satang(e.credit))).sort();
  const got = (doc.entries ?? []).map((e: PeakJournalEntry) => lineKey(e.accountCode, e.accountSubId ?? e.accountSubCode ?? null, satang(e.debit), satang(e.credit))).sort();
  if (JSON.stringify(want) !== JSON.stringify(got)) reasons.push(`${doc.code}'s lines are not the ones FolkOPS sent (sent ${want.length} line${want.length === 1 ? "" : "s"}, PEAK has ${got.length}; accounts or amounts differ)`);
  if (sent.issuedDate && doc.issuedDate && digits(sent.issuedDate) !== digits(doc.issuedDate)) reasons.push(`${doc.code} is dated ${doc.issuedDate}, FolkOPS sent ${sent.issuedDate}`);
  if (sent.contactId && doc.contactId && sent.contactId !== doc.contactId) reasons.push(`${doc.code} is for another PEAK contact`);
  return reasons;
}

// ── Retry ──────────────────────────────────────────────────────────────────────────────────

/** "Retry now" — FAILED (BLOCKED) items only. Sends nothing itself; the sender picks it up next. */
export async function retrySync(db: Db, id: string, actor: Actor): Promise<{ ok: true } | Fail> {
  const row = await db.advancePeakSync.findUnique({ where: { id }, select: { id: true, status: true, error: true } });
  if (!row) return fail(404, "No such PEAK sync item");
  if (row.status !== "BLOCKED") {
    return fail(409, row.status === "UNCERTAIN"
      ? "This item needs reconciliation, not a retry: check PEAK first, then resolve it"
      : `Only a failed item can be retried — this one is ${SYNC_LABEL[row.status] ?? row.status}`);
  }
  const moved = await db.advancePeakSync.updateMany({ where: { id, status: "BLOCKED" }, data: { status: "PENDING", nextAttemptAt: new Date() } });
  if (!moved.count) return fail(409, "The item changed while you were looking — reload");
  await logSync(db, id, "advance.peak.retry", { from: "BLOCKED", to: "PENDING", lastError: row.error }, actor);
  return { ok: true };
}

// ── Resolve UNCERTAIN ──────────────────────────────────────────────────────────────────────

export type ResolveInput =
  | { id: string; outcome: "FOUND"; documentNo: string; reason: string; actor: Actor }
  | { id: string; outcome: "NOT_IN_PEAK"; reason: string; actor: Actor };

export async function resolveUncertain(db: PrismaClient, input: ResolveInput, lookup?: DocumentLookup): Promise<{ ok: true; status: string; documentNo?: string } | Fail> {
  if ((input.reason ?? "").trim().length < MIN_REASON) return fail(400, "Say what you checked in PEAK (at least 8 characters) — the auditor reads this");
  const row = await db.advancePeakSync.findUnique({ where: { id: input.id } });
  if (!row) return fail(404, "No such PEAK sync item");
  if (row.status !== "UNCERTAIN") return fail(409, `Only an item that needs reconciliation can be resolved — this one is ${SYNC_LABEL[row.status] ?? row.status}`);
  const reason = input.reason.trim();

  if (input.outcome === "NOT_IN_PEAK") {
    const moved = await db.advancePeakSync.updateMany({ where: { id: row.id, status: "UNCERTAIN" }, data: { status: "PENDING", nextAttemptAt: new Date(), error: null } });
    if (!moved.count) return fail(409, "The item changed while you were looking — reload");
    await logSync(db, row.id, "advance.peak.resolve", { outcome: "NOT_IN_PEAK", from: "UNCERTAIN", to: "PENDING", reason, lastError: row.error }, input.actor);
    return { ok: true, status: "PENDING" };
  }

  const documentNo = normalizeDocumentNo(input.documentNo);
  if (!documentNo) return fail(400, "Enter the PEAK journal number exactly as PEAK shows it (e.g. JV-202611001)");
  // One FolkOPS owner per PEAK document (lib/advances/peak-ownership).
  const owners = (await peakDocumentOwners(db, documentNo)).filter((o) => o.id !== row.sourceId);
  const otherSync = await db.advancePeakSync.findFirst({ where: { documentNo, id: { not: row.id } }, select: { id: true } });
  if (owners.length || otherSync) return fail(409, `${documentNo} already belongs to ${owners.length ? owners.map(describeOwner).join("; ") : `another FolkOPS item (${otherSync!.id})`}`);
  const read = lookup ?? defaultLookup();
  if (!read) return fail(503, "FolkOPS cannot reach PEAK right now, so the journal cannot be checked — try again later");
  const found = await read(documentNo, "DAILY_JOURNAL");
  if (!found.ok) return found.notFound ? fail(404, `PEAK has no journal numbered ${documentNo}`) : fail(502, `PEAK could not be asked about ${documentNo}: ${found.desc}`);
  const reasons = compareWithSent(row.payload as SentPayload | null, found.document);
  if (reasons.length) return fail(409, ...reasons);
  const sent = row.payload as SentPayload;
  const ok = await db.$transaction((tx) => markPosted(tx, row, "UNCERTAIN", { id: found.document.id ?? null, code: found.document.code || documentNo, reference: sent.reference ?? null }));
  if (!ok) return fail(409, "The item changed while you were looking — reload");
  await logSync(db, row.id, "advance.peak.resolve", { outcome: "FOUND", from: "UNCERTAIN", to: "POSTED", documentNo, reason, lastError: row.error }, input.actor);
  return { ok: true, status: "POSTED", documentNo };
}

// ── History ────────────────────────────────────────────────────────────────────────────────

export async function syncHistory(db: Pick<PrismaClient, "auditLog">, id: string) {
  const rows = await db.auditLog.findMany({ where: { entityType: "AdvancePeakSync", entityId: id }, orderBy: { createdAt: "asc" }, take: 200, select: { createdAt: true, action: true, actorRole: true, detail: true } });
  return rows.map((r) => ({ at: r.createdAt, action: r.action, by: r.actorRole ?? "SYSTEM", detail: r.detail }));
}

// ── Read-only re-check of everything already in PEAK ───────────────────────────────────────

export type RecheckRow = {
  id: string; kind: string; sourceId: string; documentNo: string; via: "SENT" | "LINKED";
  result: "MATCH" | "MISMATCH" | "NOT_FOUND" | "UNCHECKED"; reasons: string[];
};

/**
 * Every POSTED item, checked against PEAK as it is now. Reads only — never writes FolkOPS or PEAK.
 * Items FolkOPS sent are compared with the payload it sent; items linked to an accountant's
 * existing journal are checked with the link rules (accounts + amount, lib/advances/peak-link).
 */
export async function recheckPosted(db: PrismaClient, lookup?: DocumentLookup, opts: { limit?: number } = {}): Promise<RecheckRow[]> {
  const read = lookup ?? defaultLookup();
  const rows = await db.advancePeakSync.findMany({ where: { status: "POSTED", documentNo: { not: null } }, orderBy: { createdAt: "asc" }, take: opts.limit ?? 200 });
  let config: ReturnType<typeof advancePeakConfig> | null = null;
  try { config = advancePeakConfig(); } catch { config = null; }
  const out: RecheckRow[] = [];
  for (const row of rows) {
    const documentNo = row.documentNo!;
    const link = await db.advancePeakDocumentLink.findUnique({ where: { kind_sourceId: { kind: row.kind, sourceId: row.sourceId } } });
    const via: RecheckRow["via"] = link ? "LINKED" : "SENT";
    const base = { id: row.id, kind: row.kind, sourceId: row.sourceId, documentNo, via };
    // A settlement recorded as carried by the guide-payment document is not a journal to read.
    if (row.error?.startsWith("BOOKED_IN_GUIDE_PAYMENT") || link?.documentType === "EXPENSE") { out.push({ ...base, result: "UNCHECKED", reasons: ["Carried by an expense document — PEAK's read API does not expose its lines"] }); continue; }
    if (!read) { out.push({ ...base, result: "UNCHECKED", reasons: ["PEAK is not reachable from here"] }); continue; }
    const found = await read(documentNo, "DAILY_JOURNAL");
    if (!found.ok) { out.push({ ...base, result: found.notFound ? "NOT_FOUND" : "UNCHECKED", reasons: [found.notFound ? `PEAK has no journal ${documentNo}` : found.desc] }); continue; }
    let reasons: string[];
    if (via === "SENT") reasons = compareWithSent(row.payload as SentPayload | null, found.document);
    else if (!config) reasons = ["The PEAK account configuration is missing, so the linked journal could not be checked"];
    else reasons = checkDocumentMatches({ kind: row.kind as "ADVANCE" | "RETURN" | "EXPENSE", amountSatang: await linkedAmount(db, row.kind, row.sourceId), document: found.document, config }).reasons;
    out.push({ ...base, result: reasons.length ? "MISMATCH" : "MATCH", reasons });
  }
  return out;
}

/** The amount a linked journal must carry, read from the ledger (the same figures the link checked). */
async function linkedAmount(db: PrismaClient, kind: string, sourceId: string): Promise<number> {
  if (kind === "ADVANCE") return (await db.guideAdvance.findUnique({ where: { id: sourceId }, select: { amountSatang: true } }))?.amountSatang ?? 0;
  if (kind === "RETURN") return (await db.guideAdvanceReceipt.findUnique({ where: { id: sourceId }, select: { allocatedSatang: true } }))?.allocatedSatang ?? 0;
  return (await db.guideAdvanceEntry.findUnique({ where: { id: sourceId }, select: { amountSatang: true } }))?.amountSatang ?? 0;
}

/** The real read-only lookup, behind a function so importing this module never needs PEAK. */
function defaultLookup(): DocumentLookup | null {
  return async (documentNo) => {
    const api = await import("@/lib/peak-api");
    if (!api.peakEnabled) return { ok: false, desc: "PEAK connection is not configured" };
    const r = await api.getDailyJournal(documentNo);
    if (!r.ok) return { ok: false, desc: r.desc ?? "lookup failed" };
    if (r.notFound || !r.journal) return { ok: false, notFound: true, desc: "not found" };
    const j = r.journal;
    return { ok: true, document: { code: j.code || documentNo, id: j.id, documentType: "DAILY_JOURNAL", isVoid: j.isVoid, contactId: j.contactId, issuedDate: j.issuedDate, entries: j.entries } };
  };
}
