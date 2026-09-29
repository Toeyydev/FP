// State for the multi-slip upload dialog. Pure, so the rules an operator relies
// on — what is valid, what is still owed, when Upload may be pressed — are
// testable without a DOM, and so the dialog and the server agree on the maths.
import { baht, matchState, type Slip } from "./slips";

export type SlipRowState = "ready" | "uploading" | "uploaded" | "failed";

export type SlipRow = {
  name: string;
  type: string;   // MIME type from the picker
  amount: string; // exactly as typed — parsed on read, never rewritten under the operator
  state: SlipRowState;
  error?: string;
};

export function newRows(files: Array<{ name: string; type: string }>): SlipRow[] {
  return files.map((f) => ({ name: f.name, type: f.type, amount: "", state: "ready" as const }));
}

/** A slip amount in baht, or null when the field cannot be used. Accepts commas,
 *  spaces and a ฿ so pasting from a banking app works. Zero and negatives are
 *  not amounts. */
export function parseAmount(raw: string): number | null {
  const cleaned = (raw ?? "").replace(/[,\s฿]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export type BatchTotals = {
  payout: number;
  alreadyPaid: number;        // slips on the tour before this dialog opened
  outstanding: number;        // still owed before this batch
  entered: number;            // valid amounts typed in this batch (any row state)
  projectedTotal: number;     // alreadyPaid + entered
  projectedRemaining: number; // payout - projectedTotal, floored at 0
  over: boolean;              // the batch would push past the payout
  under: boolean;             // the batch would leave the tour short
  invalidCount: number;       // rows still needing a usable amount
  pendingCount: number;       // rows left to upload (ready or failed)
  uploadedCount: number;
  canUpload: boolean;
};

/**
 * `alreadyPaid` is fixed when the dialog opens. Every row's amount counts toward
 * the projection whatever its state: an uploaded row is already on the server, a
 * pending one is about to be — so the operator sees where the tour lands if the
 * batch completes, not a figure that lurches as rows finish.
 */
export function batchTotals(rows: SlipRow[], payout: number, existingSlips: Slip[] | null | undefined): BatchTotals {
  const alreadyPaid = matchState(existingSlips ?? [], payout).slipsTotal;
  const target = baht(payout);
  let entered = 0, invalidCount = 0, pendingCount = 0, uploadedCount = 0;
  for (const r of rows) {
    const amt = parseAmount(r.amount);
    if (amt != null) entered += amt;
    if (r.state === "uploaded") uploadedCount++;
    else {
      pendingCount++;
      if (amt == null) invalidCount++;
    }
  }
  const projectedTotal = baht(alreadyPaid + entered);
  const over = projectedTotal > target;
  return {
    payout: target,
    alreadyPaid,
    outstanding: Math.max(0, target - alreadyPaid),
    entered: baht(entered),
    projectedTotal,
    projectedRemaining: Math.max(0, target - projectedTotal),
    over,
    under: projectedTotal < target,
    invalidCount,
    pendingCount,
    uploadedCount,
    // Every pending row needs a usable amount, the batch must not overshoot, and
    // there has to be something left to send.
    canUpload: invalidCount === 0 && !over && pendingCount > 0,
  };
}

/** The next row to send: the first that is ready or previously failed, so a retry
 *  resumes at the failure instead of re-uploading what already succeeded. */
export function nextPendingIndex(rows: SlipRow[]): number {
  return rows.findIndex((r) => r.state === "ready" || r.state === "failed");
}

/** Closing summary: what actually went up, and where that leaves the tour. */
export function batchSummary(rows: SlipRow[], payout: number, existingSlips: Slip[] | null | undefined) {
  const uploaded = rows.filter((r) => r.state === "uploaded");
  const total = baht(uploaded.reduce((s, r) => s + (parseAmount(r.amount) ?? 0), 0));
  const alreadyPaid = matchState(existingSlips ?? [], payout).slipsTotal;
  const finalTotal = baht(alreadyPaid + total);
  const target = baht(payout);
  return {
    count: uploaded.length,
    total,
    remaining: Math.max(0, target - finalTotal),
    complete: finalTotal === target,
    over: finalTotal > target,
    failed: rows.filter((r) => r.state === "failed").length,
  };
}
