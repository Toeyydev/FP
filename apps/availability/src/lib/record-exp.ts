// Record the EXP-… number of a PEAK document someone made by hand, on jobs that were
// already paid — so FolkOPS knows they are in PEAK without re-paying, re-dating, or
// re-notifying anything. Nothing is sent to PEAK.
//
// Pure: no database, no network (api/pay PATCH loads the facts and writes the ref).

/** " exp-20990100042 " → "EXP-20990100042". Null when it does not look like a PEAK document number. */
export function normalizeExpRef(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim().toUpperCase().replace(/\s+/g, "");
  return /^[A-Z]{2,6}-?\d{6,}$/.test(v) ? v : null;
}

export type RecordExpJob = {
  ref: string;
  payment: { status?: string | null; peakRef?: string | null; peakPaymentRef?: string | null } | null;
  sheet: { peakDocumentNo?: string | null; peakSyncStatus?: string | null } | null;
};

/** Every reason these jobs cannot take this EXP number — all at once. */
export function recordExpBlockers(jobs: RecordExpJob[], peakRef: string): string[] {
  const r: string[] = [];
  if (!jobs.length) r.push("Choose at least one job");
  for (const j of jobs) {
    if (j.payment?.status !== "PAID") { r.push(`${j.ref} is not paid — its PEAK document is created when it is paid`); continue; }
    if ((j.payment.peakPaymentRef ?? "").trim()) { r.push(`${j.ref} is in a combined PEAK document — its EXP comes from that document`); continue; }
    const sheetNo = (j.sheet?.peakDocumentNo ?? "").trim();
    if (sheetNo && j.sheet?.peakSyncStatus !== "VOIDED") { r.push(`${j.ref} is already in PEAK from its job sheet (${sheetNo})`); continue; }
    const current = (j.payment.peakRef ?? "").trim().toUpperCase();
    if (current && current !== peakRef) r.push(`${j.ref} already has ${current} — clear it before recording another`);
  }
  return r;
}
