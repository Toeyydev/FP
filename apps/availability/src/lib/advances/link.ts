// Which company advance each row of a job sheet was paid from — decided by the server on save.
//
// `advanceId` is server-owned (lib/protected-expense-fields): a browser may propose one for a
// row (`advanceChoices`), and only this decides. A row is linked when its payer is Company
// Advance and a person confirmed it (lib/payer-rules). Then:
//   * exactly one live advance of this job may pay for the row's category → linked to it
//   * more than one → the operator must choose; never guessed
//   * none → refused: Company Advance cannot be confirmed for a cost no advance on the job
//     covers (record the advance first, with that category allowed)
// A row whose payer is no longer Company Advance loses its link. A link already on a row is
// checked again on every save — the advance may have been reversed, or the row's category
// may have changed — and a settled row (advanceSettlement) keeps the link it was settled with.
//
// Rows nobody touched are left alone: a historical Company Advance row with no link (there
// are such rows from before advances were recorded) does not block an unrelated save, is not
// linked behind anyone's back, and cannot be settled until a person edits or re-confirms it —
// or explicitly chooses its advance (`advanceChoices`), which links it through the same checks.
import { effectivePayer } from "@/lib/payer-rules";
import { financialIdentity } from "@/lib/protected-expense-fields";
import { eligibleAdvances, linkProblems, type JobKey, type LinkableAdvance } from "@/lib/advances/categories";
import type { SheetRow } from "@/lib/advances/settlement";

export type AdvanceChoice = { index: number; advanceId: string };
export type LinkOutcome<T> = {
  rows: T[];
  problems: string[];
  /** Links set or removed by this save, for the audit. */
  changes: { row: string; from: string | null; to: string | null }[];
};

const confirmedAdvance = (r: SheetRow) => {
  const { payer, basis } = effectivePayer(r);
  return payer === "GUIDE_ADVANCE" && (basis === "OPERATOR" || basis === "GUIDE");
};

export function linkAdvanceRows<T extends SheetRow>(
  rows: readonly T[],
  stored: readonly SheetRow[],
  advances: readonly (LinkableAdvance & { advanceNo: string })[],
  job: JobKey,
  choices: readonly AdvanceChoice[] = [],
): LinkOutcome<T> {
  const problems: string[] = [];
  const changes: LinkOutcome<T>["changes"] = [];
  // The stored rows by what they say — only identities that occur once can carry a link.
  const byIdentity = new Map<string, SheetRow | null>();
  for (const s of stored) { const id = financialIdentity(s); byIdentity.set(id, byIdentity.has(id) ? null : s); }
  const label = (a: { advanceNo: string } | undefined, id: string | null) => (a ? a.advanceNo : id);

  const out = rows.map((row, i) => {
    const what = `Row ${i + 1} "${(row.description ?? "").trim() || "expense"}"`;
    const before = byIdentity.get(financialIdentity(row)) ?? undefined;
    const carried = (row.advanceId ?? before?.advanceId ?? null) || null;

    if (!confirmedAdvance(row)) {
      if (!row.advanceId) return row;
      const { advanceId: _gone, ...rest } = row;
      changes.push({ row: what, from: row.advanceId, to: null });
      return rest as T;
    }
    // An explicit choice is an instruction: it is honoured through the same checks, or refused —
    // never silently ignored because the row already carries a link (Phase 1F rehearsal finding).
    const chosen = choices.find((c) => c.index === i);
    if (row.advanceSettlement) {
      if (chosen && chosen.advanceId !== row.advanceSettlement.advanceId) {
        problems.push(`${what}: it was settled against ${row.advanceSettlement.advanceNo} — reverse that settlement before choosing another advance`);
      }
      return { ...row, advanceId: row.advanceSettlement.advanceId };
    }

    // Untouched: the same expense, confirmed the same way, already on the sheet with no link —
    // left alone unless the operator explicitly chose an advance for it in this save.
    const untouched = before && !before.advanceId && (before.paidBySource ?? "") === (row.paidBySource ?? "");
    if (!carried && untouched && !chosen) return row;

    if (carried && !chosen) {
      const adv = advances.find((a) => a.id === carried);
      if (adv && linkProblems(row, adv, job).length === 0) return row.advanceId === carried ? row : { ...row, advanceId: carried };
    }
    const eligible = eligibleAdvances(row, advances, job);
    let target: (typeof advances)[number] | undefined;
    if (chosen) {
      target = eligible.find((a) => a.id === chosen.advanceId);
      if (!target) { problems.push(`${what}: that advance cannot pay for this row — choose one of ${eligible.map((a) => a.advanceNo).join(", ") || "none"}`); return row; }
    } else if (eligible.length === 1) {
      target = eligible[0];
    } else if (eligible.length > 1) {
      problems.push(`${what}: more than one advance on this job could have paid for it (${eligible.map((a) => a.advanceNo).join(", ")}) — choose which`);
      return row;
    } else {
      const why = advances.length
        ? advances.flatMap((a) => linkProblems(row, a, job).map((p) => `${a.advanceNo}: ${p.replace(`${(row.description ?? "").trim() || "This row"}: `, "")}`))
        : ["no company advance is recorded for this job — record the advance first"];
      problems.push(`${what}: Company Advance can't be confirmed — ${why.join("; ")}`);
      return row;
    }
    if (carried !== target.id) changes.push({ row: what, from: label(advances.find((a) => a.id === carried), carried), to: target.advanceNo });
    return { ...row, advanceId: target.id };
  });
  return { rows: out, problems, changes };
}
