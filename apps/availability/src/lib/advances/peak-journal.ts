import type { DailyJournalPayload } from "@/lib/peak-api";
export type AdvancePostingKind = "ADVANCE" | "RETURN" | "EXPENSE";
export type AdvancePeakConfig = {
  advanceAccountCode: string; advanceAccountSubId?: string;
  bankName?: string; bankAccountCode: string; bankAccountSubId: string;
  journalTypeIds: Record<AdvancePostingKind, string>;
  expenseAccounts: Record<string, string>;
};
export type JournalSource = {
  kind: AdvancePostingKind; amountSatang: number; date: string; guideContactId: string;
  reference: string; jobNo: string; slipUrl?: string | null;
  expenses?: { description: string; amount: number; category: string | null; peakAccountCode?: string | null }[];
};
const required = (s: string | undefined, label: string) => { if (!s?.trim()) throw new Error(`Set ${label} before syncing to PEAK`); return s.trim(); };
export function advanceJournal(source: JournalSource, config: AdvancePeakConfig): DailyJournalPayload {
  if (!Number.isSafeInteger(source.amountSatang) || source.amountSatang <= 0) throw new Error("Invalid amount");
  required(source.jobNo, "Job No."); required(source.guideContactId, "guide's PEAK contact");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(source.date) || Number.isNaN(Date.parse(source.date)) || new Date(source.date).toISOString().slice(0,10) !== source.date) throw new Error("Invalid money movement date");
  const advance = required(config.advanceAccountCode, "advance asset account");
  if (!advance.startsWith("1")) throw new Error("Guide advances require an asset account, not a director payable");
  const amount = (source.amountSatang / 100).toFixed(2);
  const entry = (accountCode: string, debit: string, credit: string, accountSubId?: string, description?: string) => ({ accountCode, debit, credit, ...(accountSubId ? { accountSubId } : {}), ...(description ? { description } : {}) });
  let journalEntries: DailyJournalPayload["journalEntries"];
  if (source.kind === "EXPENSE") {
    const rows = source.expenses ?? [];
    if (!rows.length || rows.some(r => !Number.isFinite(r.amount) || r.amount <= 0)) throw new Error("Missing approved expense lines");
    if (rows.some(r => r.category !== "entrance")) throw new Error("Guide advances may settle ticket expenses only");
    if (rows.reduce((n,r) => n + Math.round(r.amount * 100),0) !== source.amountSatang) throw new Error("Partial expense settlement needs explicit line allocation before PEAK sync");
    journalEntries = rows.map(r => entry(required(r.peakAccountCode || config.expenseAccounts[r.category ?? ""], `expense account for ${r.category ?? "unclassified expense"}`), r.amount.toFixed(2), "0.00", undefined, r.description));
    journalEntries.push(entry(advance,"0.00",amount,config.advanceAccountSubId));
  } else {
    required(source.slipUrl ?? undefined, "transfer slip");
    const bank = required(config.bankAccountCode, "bank account code");
    const sub = required(config.bankAccountSubId, "PEAK bank subaccount ID");
    journalEntries = source.kind === "ADVANCE"
      ? [entry(advance,amount,"0.00",config.advanceAccountSubId),entry(bank,"0.00",amount,sub)]
      : [entry(bank,amount,"0.00",sub),entry(advance,"0.00",amount,config.advanceAccountSubId)];
  }
  return { issuedDate: source.date.replaceAll("-",""), journalTypeId: required(config.journalTypeIds[source.kind], "verified journal type"), contactId: source.guideContactId, reference: source.reference,
    description: `${source.kind} · ${source.jobNo} · ${source.reference}${source.slipUrl ? ` · ${source.slipUrl}` : ""}`, journalEntries };
}
