// What the guide reported for one of Water / Bus / Ferry, kept on the job's accounting row
// (owner, 22 Nov 2026): `guideReported`. Pure and client-safe — the job sheet shows it, the
// server enforces with it.
//
//   - Written only by the guide's submission (lib/guide-report-apply). An operator's save never
//     sets, changes or removes it: the server carries it from the stored row by row id
//     (carryGuideReported), whatever the request says.
//   - Price and Qty are separate facts. Price is compared in satang, Qty as a whole number —
//     never the total: 15 × 6 and 30 × 3 are both ฿90 and they are NOT the same report.
//   - A row without a snapshot (older rows, rows the guide never reported) has none: nothing is
//     inferred from its current figures, and no reason is ever asked for it.

import { fixedItemOf } from "@/lib/guide-fixed-expenses";
import { fillDownExpensePax, type Expense } from "@/lib/jobsheet";

export type GuideSnapshot = { price: number; qty: number; at: string };
export type Row = Expense & { guideReported?: GuideSnapshot | null; guideVarianceReason?: string | null };

export const satang = (v: unknown) => Math.round((Number(v) || 0) * 100);
export const qtyOf = (v: unknown) => Math.max(0, Math.trunc(Number(v) || 0));

/** A row's own snapshot, if it is a fixed item and carries a well-formed one. */
export function snapshotOf(row: Row | null | undefined): GuideSnapshot | null {
  const s = row?.guideReported;
  if (!row || !fixedItemOf(row) || !s || typeof s !== "object") return null;
  if (!Number.isFinite(Number(s.price)) || !Number.isFinite(Number(s.qty))) return null;
  return { price: Number(s.price), qty: Number(s.qty), at: String(s.at ?? "") };
}

/** Which of Price / Qty two figures differ in — compared separately, never by total. */
export function differsIn(a: { price?: unknown; qty?: unknown }, b: { price?: unknown; qty?: unknown }): ("price" | "qty")[] {
  const out: ("price" | "qty")[] = [];
  if (satang(a.price) !== satang(b.price)) out.push("price");
  if (qtyOf(a.qty) !== qtyOf(b.qty)) out.push("qty");
  return out;
}

/** Does the row as it stands differ from what the guide reported? Empty when it matches or has no snapshot. */
export function varianceFromGuide(row: Row): ("price" | "qty")[] {
  const s = snapshotOf(row);
  return s ? differsIn({ price: row.price, qty: row.pax }, s) : [];
}

const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
/** "Guide reported ฿15 × 6 = ฿90.00" */
export function guideReportedLabel(s: GuideSnapshot): string {
  const total = (satang(s.price) * qtyOf(s.qty)) / 100;
  return `Guide reported ฿${fmt(s.price)} × ${qtyOf(s.qty)} = ฿${total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * The stored row an incoming row is: by row id; failing that, for Water / Bus / Ferry, the one
 * stored row of the same item that carries a snapshot and that no incoming row claims by id — so a
 * request cannot shed the guide's snapshot (and the reason it brings) by dropping or changing a
 * row's id.
 */
function storedFor(stored: readonly Row[], incoming: readonly Row[], r: Row): Row | undefined {
  const byId = r.rowId ? stored.find((s) => s.rowId === r.rowId) : undefined;
  if (byId) return byId;
  const item = fixedItemOf(r)?.key;
  if (!item) return undefined;
  const claimed = new Set(incoming.map((x) => x.rowId).filter(Boolean));
  const free = stored.filter((s) => fixedItemOf(s)?.key === item && snapshotOf(s) && !(s.rowId && claimed.has(s.rowId)));
  const sameItemIncoming = incoming.filter((x) => fixedItemOf(x)?.key === item && !(x.rowId && stored.some((s) => s.rowId === x.rowId)));
  return free.length === 1 && sameItemIncoming.length === 1 ? free[0] : undefined;
}

/**
 * The server's own `guideReported` onto the rows being saved: a request can neither forge, change
 * nor drop it. A row the request removed simply goes; a genuinely new row has none.
 */
export function carryGuideReported<T extends Row>(stored: readonly Row[], incoming: readonly T[]): T[] {
  return incoming.map((r) => {
    const { guideReported: _drop, ...rest } = r;
    void _drop;
    const was = storedFor(stored, incoming, r);
    const snap = snapshotOf(was);
    return (snap && fixedItemOf(r) ? { ...rest, guideReported: was!.guideReported } : rest) as T;
  });
}

export type VarianceChange = {
  item: string; rowId: string | null;
  guide: { price: number; qty: number };
  before: { price: number; qty: number }; after: { price: number; qty: number };
  changed: ("price" | "qty")[]; reason: string;
};

/**
 * On an operator's save: every row with a guide snapshot whose Price or Qty changed in THIS save
 * and now differs from the snapshot needs a reason (not blank, not only spaces). A row put back
 * to the guide's figures needs none, and loses any reason it had. A row not touched by this save
 * is never asked for one (no reason is required after the fact).
 */
export function guideVarianceCheck(stored: readonly Row[], rows: readonly Row[]): { rows: Row[]; problems: string[]; changes: VarianceChange[] } {
  const problems: string[] = [];
  const changes: VarianceChange[] = [];
  const out = rows.map((r) => {
    const s = snapshotOf(r);
    if (!s) return r;
    const was = storedFor(stored, rows, r);
    const before = { price: Number(was?.price) || 0, qty: qtyOf(was?.pax) };
    const after = { price: Number(r.price) || 0, qty: qtyOf(r.pax) };
    const touched = !was || differsIn(before, after).length > 0;
    const off = differsIn(after, s);
    if (!off.length) {
      const { guideVarianceReason: _x, ...rest } = r; void _x;
      return rest as Row;
    }
    if (!touched) return r;
    const reason = (r.guideVarianceReason ?? "").trim();
    const item = (r.description ?? "").trim();
    if (!reason) {
      problems.push(`${item}: the ${off.join(" and ")} differ${off.length === 1 ? "s" : ""} from what the guide reported (${guideReportedLabel(s).replace(/^Guide reported /, "")}) — give the reason`);
      return r;
    }
    changes.push({ item, rowId: r.rowId ?? null, guide: { price: s.price, qty: s.qty }, before, after, changed: off, reason });
    return { ...r, guideVarianceReason: reason };
  });
  return { rows: out, problems, changes };
}

/**
 * "Fill down pax" on the job sheet: every row's Qty from one guest count (Inc. Guide +1), as
 * before — EXCEPT Water / Bus / Ferry rows that carry the guide's report: their Qty is actual
 * usage, not the guest count, and is left exactly as it is. Price is never touched.
 */
export function fillDownKeepingReported(expenses: Row[], guests: number): { rows: Row[]; skipped: string[] } {
  const filled = fillDownExpensePax(expenses, guests) as Row[];
  const skipped: string[] = [];
  const rows = expenses.map((e, i) => {
    if (snapshotOf(e)) { skipped.push((e.description ?? "").trim()); return e; }
    return filled[i];
  });
  return { rows, skipped };
}
