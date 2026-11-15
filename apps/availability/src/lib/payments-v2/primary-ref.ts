// The reference an operator sees for a guide payment (owner 2026-11-15): the PEAK EXP number,
// not a bank memo or FolkOPS's internal FOLK-PMT number. FOLK-PMT stays in the database and is
// shown small beside it.
//
//   one EXP across the payment's jobs  → that EXP
//   several (each job synced on its own) → the first, "+n more"
//   none (paid before PEAK documents)   → FOLK-PMT, marked as having no PEAK EXP

export type PrimaryRef = { label: string; kind: "EXP" | "EXPS" | "NONE"; exps: string[]; paymentNo: string };

export function primaryReference(p: { paymentNo: string; jobs: { peakDocumentNo?: string | null; active?: boolean }[] }): PrimaryRef {
  const exps = [...new Set(p.jobs.filter((j) => j.active !== false).map((j) => (j.peakDocumentNo ?? "").trim()).filter(Boolean))].sort();
  if (exps.length === 1) return { label: exps[0], kind: "EXP", exps, paymentNo: p.paymentNo };
  if (exps.length > 1) return { label: `${exps[0]} +${exps.length - 1} more`, kind: "EXPS", exps, paymentNo: p.paymentNo };
  return { label: p.paymentNo, kind: "NONE", exps, paymentNo: p.paymentNo };
}

/** The four independent states of a combined PEAK document, for the payment card. */
export type DocStage = { key: "CREATED" | "APPROVED" | "TRANSFER" | "PEAK_PAYMENT"; label: string; state: "done" | "todo" | "problem" };
export function documentStages(d: { status: string; peakDocumentNo: string | null; error?: string | null; approvedInPeak?: boolean | null }): DocStage[] {
  const paid = d.status === "PAID";
  const paying = d.status === "PAYING" || d.status === "PAYMENT_UNCERTAIN";
  return [
    { key: "CREATED", label: d.peakDocumentNo ? "EXP created" : "EXP not confirmed", state: d.peakDocumentNo ? "done" : "problem" },
    { key: "APPROVED", label: paid || d.approvedInPeak ? "Approved in PEAK" : d.approvedInPeak === false ? "Not ready in PEAK" : "PEAK approval · checking", state: paid || d.approvedInPeak ? "done" : d.approvedInPeak === false ? "problem" : "todo" },
    { key: "TRANSFER", label: paid || paying ? "Transferred" : "Transfer · not yet", state: paid || paying ? "done" : "todo" },
    { key: "PEAK_PAYMENT", label: paid ? "PEAK payment posted" : d.status === "PAYMENT_UNCERTAIN" ? "PEAK payment · check PEAK" : d.error ? "PEAK payment failed" : "PEAK payment · not yet", state: paid ? "done" : d.status === "PAYMENT_UNCERTAIN" || d.error ? "problem" : "todo" },
  ];
}
