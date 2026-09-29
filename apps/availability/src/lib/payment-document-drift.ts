// Is a combined PEAK document still the payout it was created for?
//
// A GuidePaymentDocument keeps exactly what was sent to PEAK — its jobs, line trace and
// total — and is never rewritten to follow the job sheets. The approved job sheets stay
// the truth of what the guide is owed. The two part when:
//   - a job's figures changed after the document was made (a fee set to ฿0, an expense
//     corrected), or its job sheet is gone;
//   - a job this transfer should pay is not in the document at all — approved, unpaid,
//     in the same month and in no PEAK document (for example one wrongly marked paid
//     when the document was created, then put back).
// Then the document is OUT OF SYNC: paying it would record in PEAK a payment that is
// not the transfer the guide is owed. It stays as created until PEAK itself is aligned.
//
// Pure: no database, no network.
import { computeTotals, thb, type Expense, type GuideFee } from "@/lib/jobsheet";
import { guidePayoutTotal } from "@/lib/peak-sync";

export type Figures = { gross: number; wht: number; net: number };
export type JobFigures = { date: string; slotIdx: number; ref: string | null } & Figures;

const r2 = (v: number) => Math.round(v * 100) / 100;
const same = (a: Figures, b: Figures) => Math.abs(a.gross - b.gross) < 0.005 && Math.abs(a.wht - b.wht) < 0.005 && Math.abs(a.net - b.net) < 0.005;

/** A job as a PEAK document would book it now: gross = fee before withholding + every
 *  row still owed to the guide (review rewards included, company/advance rows not);
 *  WHT = the fee's withholding; net = the transfer. Gross − WHT = net. */
export function currentJobFigures(expenses: Expense[] | null | undefined, guideFee: GuideFee): Figures {
  const t = computeTotals(expenses ?? [], guideFee);
  const p = guidePayoutTotal(expenses ?? [], guideFee);
  return { gross: r2(t.gross + p.payoutExpenses), wht: r2(t.wht), net: r2(p.payout) };
}

type StoredJob = { date: string; slotIdx: number; ref?: string | null; payout?: number | string };
type StoredLine = { date?: string; slotIdx?: number; jobRef?: string; price?: number | string; wht?: number | string };

export type DocumentDrift = {
  stored: Figures & { jobs: number };
  current: Figures & { jobs: number };
  delta: Figures;
  /** Jobs in the document whose figures are not what it was created for (current null: no job sheet any more). */
  changed: { date: string; slotIdx: number; ref: string | null; stored: Figures; current: Figures | null }[];
  /** Payable jobs this document should hold but does not. */
  leftOut: JobFigures[];
  inSync: boolean;
};

export function documentDrift(input: {
  document: { jobs: unknown; lines: unknown; total: number };
  /** Current figures of each job the document was created with, by date + slot; null when it has no job sheet now. */
  currentOf: (job: { date: string; slotIdx: number }) => Figures | null;
  leftOut: JobFigures[];
}): DocumentDrift {
  const jobs = (Array.isArray(input.document.jobs) ? input.document.jobs : []) as StoredJob[];
  const lines = (Array.isArray(input.document.lines) ? input.document.lines : []) as StoredLine[];
  const linesOf = (j: StoredJob) => lines.filter((l) => (l.date != null && l.slotIdx != null ? l.date === j.date && l.slotIdx === j.slotIdx : !!j.ref && l.jobRef === j.ref));

  const changed: DocumentDrift["changed"] = [];
  let cur: Figures = { gross: 0, wht: 0, net: 0 };
  for (const j of jobs) {
    const ls = linesOf(j);
    const stored = { gross: r2(ls.reduce((s, l) => s + (Number(l.price) || 0), 0)), wht: r2(ls.reduce((s, l) => s + (Number(l.wht) || 0), 0)), net: r2(Number(j.payout) || 0) };
    const now = input.currentOf(j);
    if (now) cur = { gross: cur.gross + now.gross, wht: cur.wht + now.wht, net: cur.net + now.net };
    if (!now || !same(stored, now)) changed.push({ date: j.date, slotIdx: j.slotIdx, ref: j.ref ?? null, stored, current: now });
  }
  for (const j of input.leftOut) cur = { gross: cur.gross + j.gross, wht: cur.wht + j.wht, net: cur.net + j.net };

  const stored = {
    jobs: jobs.length,
    gross: r2(lines.reduce((s, l) => s + (Number(l.price) || 0), 0)),
    wht: r2(lines.reduce((s, l) => s + (Number(l.wht) || 0), 0)),
    net: r2(Number(input.document.total) || 0),
  };
  const current = { jobs: jobs.length + input.leftOut.length, gross: r2(cur.gross), wht: r2(cur.wht), net: r2(cur.net) };
  return {
    stored, current,
    delta: { gross: r2(current.gross - stored.gross), wht: r2(current.wht - stored.wht), net: r2(current.net - stored.net) },
    changed, leftOut: input.leftOut,
    inSync: changed.length === 0 && input.leftOut.length === 0,
  };
}

const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${thb(Math.abs(v))}`;

/**
 * Why the document's payment cannot be recorded: every job in it whose figures are not
 * what the document was created with. Empty when none changed.
 *
 * Jobs LEFT OUT of the document are not a reason: leaving a job for a later transfer is
 * allowed, and that job cannot get its own document until this one is settled — refusing
 * here would lock both. Payments still shows them against the current payout.
 */
export function documentChangeReasons(drift: DocumentDrift, documentNo: string): string[] {
  if (!drift.changed.length) return [];
  const label = (j: { ref: string | null; date: string; slotIdx: number }) => j.ref || `${j.date} slot ${j.slotIdx}`;
  const out = drift.changed.map((c) => {
    if (!c.current) return `${label(c)} no longer has a job sheet — ${documentNo} was created for ${thb(c.stored.net)}`;
    const books = `gross ${thb(c.current.gross)} (was ${thb(c.stored.gross)}), WHT ${thb(c.current.wht)} (was ${thb(c.stored.wht)})`;
    return Math.abs(c.current.net - c.stored.net) >= 0.005
      ? `${label(c)} now pays ${thb(c.current.net)}, but ${documentNo} was created for ${thb(c.stored.net)} — its figures changed after the PEAK document was made: ${books}`
      : `${label(c)} still pays ${thb(c.current.net)}, but its figures changed after ${documentNo} was made: ${books}`;
  });
  const changedNet = drift.changed.reduce((s, c) => s + (c.current?.net ?? 0) - c.stored.net, 0);
  out.push(`${documentNo} no longer matches the approved job sheets (net ${signed(Math.round(changedNet * 100) / 100)} on the jobs in it). Align ${documentNo} in PEAK before recording its payment`);
  return out;
}
