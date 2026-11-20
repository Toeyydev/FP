// One naming rule for every slip, receipt and note this app files in Drive:
//
//   <Job No.> — <what it is> — <guide> — <date> — ฿<amount> — <system refs>.<ext>
//   FOLK-BKK-20261015-02 — advance slip — Somchai Jaidee — 2026-10-15 — ฿3,000 — KB2610151234.jpg
//
// The Job No. always comes first, so every document of one job sorts together in a
// folder and a Drive search for the Job No. finds all of them. When a file pays several
// jobs it leads with the first and says how many more ("FOLK-BKK-… (+2 jobs)"). A file
// with no job at all leads with a plain word that says so, never a blank.
//
// IMPORTANT: Drive saves REPLACE a same-named file in the same folder (lib/google-drive).
// So a name must still differ between two different pieces of evidence — keep the
// transfer's bank reference, the line number or a hash in `refs` wherever two uploads
// could otherwise look alike.

const SEP = " — ";

function clean(s: string): string {
  return s.replace(/[\\/'"\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

/** "FOLK-BKK-20261015-02", or "FOLK-BKK-20261015-02 (+2 jobs)" when the file covers more. */
export function jobLead(jobNos: (string | null | undefined)[], none = "NO-JOB"): string {
  const jobs = [...new Set(jobNos.map((j) => clean(j ?? "")).filter(Boolean))];
  if (!jobs.length) return none;
  return jobs.length === 1 ? jobs[0] : `${jobs[0]} (+${jobs.length - 1} job${jobs.length === 2 ? "" : "s"})`;
}

/** ฿3,000 / ฿2,584.50 — one spelling for one amount. */
export function bahtPart(amount: number): string {
  const whole = Math.abs(amount - Math.round(amount)) < 0.005;
  return `฿${amount.toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

export function evidenceName(o: {
  jobs: (string | null | undefined)[];
  /** Shown when there is no Job No. at all (default "NO-JOB"). */
  noJob?: string;
  what: string;
  guide?: string | null;
  date?: string | null;
  amount?: number | null;
  refs?: (string | null | undefined)[];
  /** Without the dot. Omit when the caller adds the extension itself. */
  ext?: string;
}): string {
  const parts = [
    jobLead(o.jobs, o.noJob),
    o.what,
    o.guide ?? "",
    o.date ?? "",
    o.amount != null && isFinite(o.amount) ? bahtPart(o.amount) : "",
    ...(o.refs ?? []).map((r) => r ?? ""),
  ].map(clean).filter(Boolean);
  const stem = parts.join(SEP).slice(0, 220);
  return o.ext ? `${stem}.${o.ext}` : stem;
}
