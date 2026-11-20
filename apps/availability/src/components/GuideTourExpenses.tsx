"use client";

// The guide's Tour expenses on their job sheet — three fixed items (owner 2026-11-15,
// lib/guide-fixed-expenses): Water / Bus / Ferry (Inc. Guide). Price × quantity per item,
// 0 or empty = not used. No adding, removing or renaming. Each item shows the operator's
// review once there is one. Entrance tickets are not here: they are Company ADV (Ticket receipts).

import { useState } from "react";
import { DEFAULT_EXPENSES, thb, type Expense } from "@/lib/jobsheet";
import { FIXED_ITEMS, fixedItemOf, reviewOf, type ReportRow } from "@/lib/guide-fixed-expenses";

type Props = {
  sheetKey: { guideId: string; date: string; slotIdx: number };
  reported: ReportRow[];
  official: Expense[];
  defaultPax: number | null;
  note: string | null;
  sentAt?: string | null;
  onSubmitted: () => void | Promise<void>;
};

const num = (v: string) => (v.trim() === "" ? null : Number(v));
const L: React.CSSProperties = { border: "1px solid var(--line)", borderRadius: 8, padding: "8px 6px", fontSize: 14, textAlign: "right", width: "100%", boxSizing: "border-box", background: "var(--card,#fff)", color: "inherit", fontFamily: "inherit" };
const chip = (bg: string, line: string, fg: string): React.CSSProperties => ({ fontSize: 12, fontWeight: 700, color: fg, background: bg, border: `1px solid ${line}`, borderRadius: 999, padding: "2px 9px", whiteSpace: "nowrap" });

export default function GuideTourExpenses({ sheetKey, reported, official, defaultPax, note: note0, sentAt, onSubmitted }: Props) {
  const initial = () => FIXED_ITEMS.map((f) => {
    const mine = reported.find((r) => fixedItemOf(r)?.key === f.key);
    const off = official.find((r) => fixedItemOf(r)?.key === f.key);
    const std = DEFAULT_EXPENSES.find((d) => d.description === f.description);
    const src = mine ?? off;
    return { price: String(src?.price ?? std?.price ?? ""), qty: String(mine ? mine.pax ?? "" : (off?.pax ?? defaultPax ?? "")) };
  });
  const [rows, setRows] = useState(initial);
  const [note, setNote] = useState(note0 ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const amount = (i: number) => (num(rows[i].price) ?? 0) * (num(rows[i].qty) ?? 0);
  const total = FIXED_ITEMS.reduce((s, _f, i) => s + amount(i), 0);

  async function submit() {
    setBusy(true); setMsg("");
    const expenses = FIXED_ITEMS.map((f, i) => ({ description: f.description, expenseType: f.expenseType, price: num(rows[i].price), pax: num(rows[i].qty) }))
      .filter((e) => (e.price ?? 0) * (e.pax ?? 0) > 0);
    let r: Response;
    try { r = await fetch("/api/jobsheet/expenses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...sheetKey, expenses, note: note.trim() || undefined }) }); }
    catch { r = new Response(JSON.stringify({ reasons: ["Offline — try again"] }), { status: 503 }); }
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg((d.reasons ?? [d.error ?? "Couldn't send — try again"]).join("\n")); return; }
    setMsg("Sent to the operator ✓");
    await onSubmitted();
  }

  return (
    <section className="js-guide-tour-expenses" style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 14, display: "grid", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <h3 style={{ margin: 0 }}>Tour expenses</h3><small style={{ color: "var(--ink-soft)" }}>ค่าใช้จ่ายระหว่างทัวร์</small>
      </div>
      <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>What you paid with your own money. 0 = not used.</div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 64px 52px 76px", gap: 6, fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--ink-soft)" }}>
        <span>Item</span><span style={{ textAlign: "right" }}>Price</span><span style={{ textAlign: "right" }}>Qty</span><span style={{ textAlign: "right" }}>Amount</span>
      </div>
      {FIXED_ITEMS.map((f, i) => {
        const mine = reported.find((r) => fixedItemOf(r)?.key === f.key);
        const st = reviewOf(mine);
        return (
          <div key={f.key} className="js-fixed-item" data-item={f.key} style={{ borderTop: "1px solid var(--line)", paddingTop: 8, display: "grid", gap: 4 }}>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 64px 52px 76px", gap: 6, alignItems: "center" }}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>{f.label} <span style={{ fontWeight: 400, color: "var(--ink-soft)" }}>(Inc. Guide)</span></span>
              <input aria-label={`${f.label} price`} className="js-fixed-price" type="number" inputMode="decimal" min={0} style={L} value={rows[i].price} onChange={(e) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, price: e.target.value } : r)))} />
              <input aria-label={`${f.label} quantity`} className="js-fixed-qty" type="number" inputMode="numeric" min={0} style={L} value={rows[i].qty} onChange={(e) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, qty: e.target.value } : r)))} />
              <b style={{ textAlign: "right", fontSize: 14, fontVariantNumeric: "tabular-nums" }}>{thb(amount(i))}</b>
            </div>
            {st && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", justifyContent: "flex-end" }}>
                <span className="js-fixed-status" data-status={st} style={
                  st === "APPROVED" ? chip("var(--green-bg)", "var(--green-line)", "var(--green)")
                  : st === "ADJUSTED" ? chip("var(--assign-bg)", "var(--assign-line)", "var(--assign)")
                  : st === "REJECTED" ? chip("var(--danger-bg)", "var(--danger-line)", "var(--danger)")
                  : chip("var(--grey-bg)", "var(--line)", "var(--ink-soft)")}>
                  {st === "APPROVED" ? "✓ Verified" : st === "ADJUSTED" ? `Adjusted to ${thb(mine?.verifiedAmount ?? 0)}` : st === "REJECTED" ? "Rejected" : "Waiting for review"}
                </span>
                {(st === "ADJUSTED" || st === "REJECTED") && mine?.reviewReason && <div style={{ flexBasis: "100%", fontSize: 12, color: "var(--ink-soft)", textAlign: "right" }}>Operator: “{mine.reviewReason}”</div>}
              </div>
            )}
          </div>
        );
      })}
      <div style={{ borderTop: "1.5px solid var(--line-strong, var(--line))", paddingTop: 8, display: "flex", justifyContent: "space-between", fontWeight: 800 }}>
        <span>Total</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{thb(total)}</span>
      </div>
      <div style={{ fontSize: 11.5, color: "var(--ink-soft)" }}>🔒 These three items are fixed. Entrance tickets are under Ticket receipts.</div>
      <label style={{ fontSize: 11, color: "var(--ink-soft)", fontWeight: 600 }}>Note (optional)
        <textarea value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} rows={2} style={{ display: "block", width: "100%", boxSizing: "border-box", marginTop: 3, padding: "6px 8px", border: "1px solid var(--line)", borderRadius: 8, fontFamily: "inherit", fontSize: 13 }} />
      </label>
      <button type="button" className="btn primary js-fixed-submit" disabled={busy} onClick={submit}>{busy ? "Sending…" : "Submit to operator"}</button>
      {sentAt && <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>✓ Last sent {new Date(sentAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}.</div>}
      {msg && <div role="status" style={{ fontSize: 12.5, whiteSpace: "pre-line" }}>{msg}</div>}
    </section>
  );
}
