import { createHash } from "node:crypto";

// What an admin was looking at when they decided.
//
// A decision on a job sheet is only worth what the sheet said at the time. "Nothing here
// needs a certificate" is true of one set of rows and may be false of the next, so every
// decision stores the fingerprint of what it was made about, and a sheet whose
// fingerprint has moved since reads as undecided again.
//
// The fingerprint covers what the evidence question depends on — the rows (every field,
// server-owned ones included, so a waiver or a payer stamp moving counts), the guide's own
// report and when it was filed, and whether the sheet is approved — and nothing else. A
// booking edit or an operator note does not reopen a decision about receipts.
//
// Keys are sorted, so the same sheet fingerprints alike whichever order its JSON was
// written in.

export type SnapshotSheet = {
  id: string;
  ref: string | null;
  guideId: string;
  date: string;
  slotIdx: number;
  expenses: unknown;
  guideExpenses: unknown;
  guideExpensesAt: Date | string | null;
  approvalStatus: string | null;
};

function canonical(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

const iso = (d: Date | string | null) => (d == null ? null : new Date(d).toISOString());

export function evidenceSnapshotHash(s: SnapshotSheet): string {
  const body = canonical({
    v: 1,
    id: s.id,
    ref: s.ref ?? null,
    guideId: s.guideId,
    date: s.date,
    slotIdx: s.slotIdx,
    expenses: s.expenses ?? [],
    guideExpenses: s.guideExpenses ?? null,
    guideExpensesAt: iso(s.guideExpensesAt),
    approvalStatus: s.approvalStatus ?? null,
  });
  return createHash("sha256").update(body, "utf8").digest("hex");
}
