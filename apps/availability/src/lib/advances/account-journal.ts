// The account journal of company advances — every money movement of an advance as the
// double entry it is, and where that entry stands with PEAK.
//
//   an advance issued      Dr advance asset      Cr company bank
//   costs settled from it  Dr each cost account  Cr advance asset
//   money returned         Dr company bank       Cr advance asset
//
// This is a READ. It shows what FolkOPS holds and what it WOULD post, with every reason an
// entry may not be posted yet, before anything is sent — the sender (lib/advances/peak-sync)
// builds its journal with the very same two functions, so what is shown here is what goes.
// Nothing is claimed, written, or sent to PEAK from this file.
import type { PrismaClient } from "@prisma/client";
import { sanitizePeakError } from "@/lib/peak-api";
import { advanceJournal, type AdvancePeakConfig } from "./peak-journal";
import { advancePeakConfigWithChart, journalSourceFor } from "./peak-sync";
import { settlementLines } from "./expense-accounts";
import { isBookedInGuidePayment } from "./rules";

export type JournalKind = "ADVANCE" | "RETURN" | "EXPENSE";

/**
 * Where an entry stands.
 *   POSTED    FolkOPS created the PEAK journal
 *   LINKED    a person recorded the PEAK document that already carries it
 *   BOOKED_IN_GUIDE_PAYMENT  the cost is inside a guide payment document; no journal of its own
 *   READY     every check passes — this is the journal that would be posted
 *   BLOCKED   it may not be posted yet; `reason` says why
 *   SENDING / UNCERTAIN  a send is in flight, or its outcome is unknown and a person must check PEAK
 *   CANCELLED closed without a document
 */
export type JournalState = "POSTED" | "LINKED" | "BOOKED_IN_GUIDE_PAYMENT" | "READY" | "BLOCKED" | "SENDING" | "UNCERTAIN" | "CANCELLED";

export type JournalLine = {
  /** What the account is in this entry. */
  role: "ADVANCE" | "BANK" | "COST";
  accountCode: string | null;
  label: string;
  debit: number;
  credit: number;
};

export type JournalEntry = {
  id: string; // ADVANCE:<id> | RETURN:<id> | EXPENSE:<entry id> — the outbox key
  kind: JournalKind;
  reference: string; // FOLK-ADV-… | FOLK-ADR-… | FOLK-SET-…
  guideId: string;
  jobNo: string | null;
  date: string;
  amount: number;
  lines: JournalLine[];
  /** Debits equal credits, and both equal the movement. False only when lines could not be worked out. */
  balanced: boolean;
  state: JournalState;
  documentNo: string | null;
  /** LINKED only: whether PEAK's figures were machine-checked when it was linked. */
  verified: boolean | null;
  /** Why it is not READY/POSTED, in words. */
  reason: string | null;
};

export type AccountJournal = {
  /** The deployment has its advance accounts configured. Without them no entry can name an account. */
  configured: boolean;
  /** PEAK_ADVANCE_AUTO_SYNC: when on, READY entries are posted by the worker without a further click. */
  autoSync: boolean;
  entries: JournalEntry[];
  totals: {
    byState: Partial<Record<JournalState, { count: number; amount: number }>>;
    /** Debits less credits on the advance asset account across every entry: what guides still hold, by the books. */
    advanceAccountNet: number;
  };
};

const baht = (satang: number) => satang / 100;
const CATEGORY_LABEL: Record<string, string> = { entrance: "Entrance tickets", meal: "Meals", transport: "Transport", other: "Other tour cost" };

type Outbox = { id: string; status: string; documentNo: string | null; error: string | null };
type Link = { kind: string; sourceId: string; documentNo: string; verified: boolean };

/** The double entry of one movement, from the ledger's own figures. Pure. */
export function journalLines(kind: JournalKind, amountSatang: number, config: AdvancePeakConfig | null, costs: { category: string; amountSatang: number; description?: string }[] = []): JournalLine[] {
  const advance = { role: "ADVANCE" as const, accountCode: config?.advanceAccountCode ?? null, label: "Guide advances" };
  const bank = { role: "BANK" as const, accountCode: config?.bankAccountCode ?? null, label: config?.bankName || "Company bank" };
  const amount = baht(amountSatang);
  if (kind === "ADVANCE") return [{ ...advance, debit: amount, credit: 0 }, { ...bank, debit: 0, credit: amount }];
  if (kind === "RETURN") return [{ ...bank, debit: amount, credit: 0 }, { ...advance, debit: 0, credit: amount }];
  // One debit per settlement line, each on its category's account — line for line what the
  // sender posts (lib/advances/peak-journal).
  return [
    ...costs.map((c) => ({ role: "COST" as const, accountCode: config?.expenseAccounts?.[c.category] ?? null, label: `${CATEGORY_LABEL[c.category] ?? c.category}${c.description ? ` — ${c.description}` : ""}`, debit: baht(c.amountSatang), credit: 0 })),
    { ...advance, debit: 0, credit: amount },
  ];
}

const balancedAt = (lines: JournalLine[], amountSatang: number) => {
  const dr = Math.round(lines.reduce((s, l) => s + l.debit * 100, 0)), cr = Math.round(lines.reduce((s, l) => s + l.credit * 100, 0));
  return lines.length > 0 && dr === cr && dr === amountSatang;
};

/** The whole journal. Reads the ledger, the outbox and the links; changes nothing. */
export async function accountJournal(db: PrismaClient): Promise<AccountJournal> {
  let config: AdvancePeakConfig | null = null;
  try { config = await advancePeakConfigWithChart(db); } catch { config = null; }

  const [advances, receipts, settlements, outbox, links] = await Promise.all([
    db.guideAdvance.findMany({ where: { reversedAt: null }, orderBy: [{ advanceDate: "asc" }, { advanceNo: "asc" }] }),
    db.guideAdvanceReceipt.findMany({ where: { status: { notIn: ["REJECTED", "VOIDED"] } }, orderBy: [{ receivedDate: "asc" }, { receiptNo: "asc" }], include: { entries: { where: { type: "RETURN_ALLOCATION", reversedByEntryId: null }, include: { advance: { select: { jobNo: true } } } } } }),
    db.guideAdvanceEntry.findMany({ where: { type: "EXPENSE_SETTLEMENT", reversedByEntryId: null }, orderBy: [{ effectiveDate: "asc" }, { createdAt: "asc" }], include: { advance: true } }),
    db.advancePeakSync.findMany({ select: { id: true, status: true, documentNo: true, error: true } }),
    db.advancePeakDocumentLink.findMany({ select: { kind: true, sourceId: true, documentNo: true, verified: true } }),
  ]);
  const outboxOf = new Map<string, Outbox>(outbox.map((o) => [o.id, o]));
  const linkOf = new Map<string, Link>(links.map((l) => [`${l.kind}:${l.sourceId}`, l]));

  /** Where the entry stands — and, when nothing has been posted or linked, whether it may be. */
  const standing = async (kind: JournalKind, sourceId: string): Promise<Pick<JournalEntry, "state" | "documentNo" | "verified" | "reason">> => {
    const id = `${kind}:${sourceId}`;
    const link = linkOf.get(id), o = outboxOf.get(id);
    if (link) return { state: "LINKED", documentNo: link.documentNo, verified: link.verified, reason: null };
    if (o && isBookedInGuidePayment(o)) return { state: "BOOKED_IN_GUIDE_PAYMENT", documentNo: o.documentNo, verified: null, reason: "Booked inside the guide payment document — no journal of its own" };
    if (o?.status === "POSTED") return { state: "POSTED", documentNo: o.documentNo, verified: null, reason: null };
    if (o?.status === "CANCELLED") return { state: "CANCELLED", documentNo: o.documentNo, verified: null, reason: o.error };
    if (o?.status === "SENDING") return { state: "SENDING", documentNo: null, verified: null, reason: "Being sent to PEAK now" };
    if (o?.status === "UNCERTAIN") return { state: "UNCERTAIN", documentNo: o.documentNo, verified: null, reason: o.error ?? "The outcome in PEAK is unknown — check PEAK before anything else" };
    if (!config) return { state: "BLOCKED", documentNo: null, verified: null, reason: "The advance accounts are not configured for PEAK" };
    // The sender's own checks and its own builder, with nothing claimed and nothing sent.
    try {
      advanceJournal(await journalSourceFor(db, kind, sourceId, config), config);
      return { state: "READY", documentNo: null, verified: null, reason: null };
    } catch (e) {
      return { state: "BLOCKED", documentNo: null, verified: null, reason: sanitizePeakError(e) };
    }
  };

  const entries: JournalEntry[] = [];
  // A return a guide has claimed but nobody has confirmed against the bank is listed (so it
  // is not lost sight of) but is not yet money in the books.
  const unconfirmed = new Set<string>();
  for (const a of advances) {
    const lines = journalLines("ADVANCE", a.amountSatang, config);
    entries.push({ id: `ADVANCE:${a.id}`, kind: "ADVANCE", reference: a.advanceNo, guideId: a.guideId, jobNo: a.jobNo, date: a.advanceDate, amount: baht(a.amountSatang), lines, balanced: balancedAt(lines, a.amountSatang), ...(await standing("ADVANCE", a.id)) });
  }
  for (const e of settlements) {
    const parsed = settlementLines(e, e.advance);
    const lines = parsed.ok ? journalLines("EXPENSE", e.amountSatang, config, parsed.lines) : [];
    entries.push({ id: `EXPENSE:${e.id}`, kind: "EXPENSE", reference: `FOLK-SET-${e.id}`, guideId: e.advance.guideId, jobNo: e.jobNo, date: e.effectiveDate, amount: baht(e.amountSatang), lines, balanced: balancedAt(lines, e.amountSatang), ...(await standing("EXPENSE", e.id)) });
  }
  for (const r of receipts) {
    const lines = journalLines("RETURN", r.amountSatang, config);
    const jobs = [...new Set(r.entries.map((x) => x.advance.jobNo).filter((x): x is string => !!x))];
    if (r.status !== "VERIFIED") unconfirmed.add(`RETURN:${r.id}`);
    entries.push({ id: `RETURN:${r.id}`, kind: "RETURN", reference: r.receiptNo, guideId: r.guideId, jobNo: jobs.join(", ") || null, date: r.receivedDate, amount: baht(r.amountSatang), lines, balanced: balancedAt(lines, r.amountSatang), ...(await standing("RETURN", r.id)) });
  }
  // By day, and within a day in the order money moves: handed over, spent, returned.
  const step = { ADVANCE: 0, EXPENSE: 1, RETURN: 2 } as const;
  entries.sort((x, y) => x.date.localeCompare(y.date) || step[x.kind] - step[y.kind] || x.reference.localeCompare(y.reference));

  const byState: AccountJournal["totals"]["byState"] = {};
  let net = 0;
  for (const e of entries) {
    const t = (byState[e.state] ??= { count: 0, amount: 0 });
    t.count++; t.amount = Math.round((t.amount + e.amount) * 100) / 100;
    // A cost booked inside a guide payment still left the advance account — through that document.
    if (e.state === "CANCELLED" || unconfirmed.has(e.id)) continue;
    net += e.kind === "ADVANCE" ? Math.round(e.amount * 100) : -Math.round(e.amount * 100);
  }
  return { configured: !!config, autoSync: (process.env.PEAK_ADVANCE_AUTO_SYNC ?? "").trim() === "1", entries, totals: { byState, advanceAccountNet: net / 100 } };
}
