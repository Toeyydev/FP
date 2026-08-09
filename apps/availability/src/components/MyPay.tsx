"use client";

import { useEffect, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import { GuideTabs } from "@/components/GuideTabs";

// The guide's own payments — simple and transparent, no accounting tables.
// Top: what's pending vs what's been paid this month. Tabs: Pending | Paid |
// Months (monthly totals + the month's bank slip). Every job is a card with the
// guide-readable breakdown: fee (after WHT) + reimbursed expenses = total.
type Tour = { date: string; slotIdx: number; time: string; tour: string; ref: string | null; amount: number; fee?: number; expenses?: number; reviewReward: number; paid: boolean; paidAt: string | null; slip: string | null };
type Month = { period: string; label: string; tourCount: number; total: number; reviewReward: number; paidCount: number; monthly: { paid: boolean; paidAt: string | null; slip: string | null }; tours: Tour[] };
type ReviewIncentive = { id: string; reviewDate: string; bookingReference: string | null; jobSheetRef: string | null; tour: string; rating: number | null; amount: number; status: string; text: string | null };
type Data = { months: Month[]; yearTotal: number; paidThisMonth: number; pendingTotal?: number; pendingCount?: number; guideId: string; all?: boolean; reviewIncentives?: ReviewIncentive[]; reviewBonusTotal?: number; reviewBonusPaid?: number };

const thb = (v: number) => `฿${v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const dLabel = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const paidLabel = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");

function PayCard({ t, guideId }: { t: Tour; guideId: string }) {
  const hasSplit = t.fee != null && t.expenses != null;
  return (
    <div className="pay-card">
      <div className="pc-top">
        <div style={{ minWidth: 0 }}>
          <div className="pc-tour">{t.tour}</div>
          <div className="pc-when">{dLabel(t.date)} · {t.time}</div>
          {t.ref && <div className="pc-ref">{t.ref}</div>}
        </div>
        <div className="pc-amt">{thb(t.amount)}</div>
      </div>
      {hasSplit && (
        <div className="pc-split">
          <span>Guide fee <b>{thb(t.fee!)}</b></span>
          <span>Reimbursement <b>{thb(t.expenses!)}</b></span>
          {t.reviewReward > 0 && <span style={{ color: "var(--assign)" }}>★ Reviews <b>{thb(t.reviewReward)}</b></span>}
        </div>
      )}
      <div className="pc-foot">
        {t.paid
          ? <span className="pay-pill paid">✓ Paid{t.paidAt ? ` · ${paidLabel(t.paidAt)}` : ""}</span>
          : <span className="pay-pill pend">Payment pending</span>}
        <span style={{ display: "flex", gap: 10 }}>
          {t.slip && <a className="pay-slip" href={t.slip} target="_blank" rel="noopener noreferrer">Transfer slip</a>}
          <a className="pay-slip" href={`/job-sheet?guideId=${encodeURIComponent(guideId)}&date=${t.date}&slotIdx=${t.slotIdx}`}>Details</a>
        </span>
      </div>
    </div>
  );
}

export default function MyPay() {
  const [d, setD] = useState<Data | null>(null);
  const [tab, setTab] = useState<"pending" | "paid" | "months">("pending");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [all, setAll] = useState(false); // false = last 12 months, true = full history

  useEffect(() => { setD(null); fetch(`/api/my-pay${all ? "?all=1" : ""}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then(setD).catch(() => {}); }, [all]);

  const allTours = d ? d.months.flatMap((m) => m.tours).sort((a, b) => b.date.localeCompare(a.date) || b.slotIdx - a.slotIdx) : [];
  const pending = allTours.filter((t) => !t.paid);
  const paid = allTours.filter((t) => t.paid);
  const pendingTotal = d?.pendingTotal ?? pending.reduce((s, t) => s + t.amount, 0);

  // Once everything is settled, "Pending" is an empty tab — open on Paid instead.
  useEffect(() => { if (d && pending.length === 0 && tab === "pending") setTab("paid"); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [d]);

  return (
    <div className="wrap">
      <AuthHeader backHref="/" />
      <GuideTabs active="pay" />

      {!d ? (
        <section className="panel" style={{ padding: 16 }}>
          <div className="kpi-row">{Array.from({ length: 2 }).map((_, i) => <div key={i} className="kpi skel" />)}</div>
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skel-row" style={{ height: 64, marginTop: 10 }} />)}
        </section>
      ) : (
        <>
          {/* What am I waiting for · what have I received — the two numbers that matter. */}
          <div className="kpi-row" style={{ marginBottom: 12 }}>
            <div className={`kpi${pending.length ? " warn" : ""}`}>
              <b style={{ fontVariantNumeric: "tabular-nums" }}>{thb(pendingTotal)}</b>
              <span>Pending payment</span>
              {pending.length > 0 && <small className="kpi-sub">{pending.length} job{pending.length === 1 ? "" : "s"}</small>}
            </div>
            <div className="kpi">
              <b style={{ fontVariantNumeric: "tabular-nums" }}>{thb(d.paidThisMonth)}</b>
              <span>Paid this month</span>
            </div>
          </div>

          {/* Review bonus — a separate earning from customer reviews. Never part of
              the job sheet totals above; paid in its own weekly payout. */}
          {(d.reviewIncentives?.length ?? 0) > 0 && (
            <section className="panel" style={{ padding: 14, marginBottom: 12 }}>
              <div className="panel-head" style={{ padding: 0, marginBottom: 8 }}>
                <h2>★ Review bonus</h2>
                <span className="hint">{thb(d.reviewBonusPaid ?? 0)} paid · {thb(d.reviewBonusTotal ?? 0)} total</span>
              </div>
              {d.reviewIncentives!.map((r) => (
                <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "8px 2px", borderBottom: "1px solid var(--line)", fontSize: 13, flexWrap: "wrap" }}>
                  <div style={{ flex: "1 1 200px" }}>
                    <div><b>{new Date(`${r.reviewDate}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</b> · {r.tour || "Tour"}</div>
                    <div style={{ color: "var(--ink-soft)", fontSize: 12 }}>
                      <span style={{ color: "var(--assign)" }}>{r.rating ? "★".repeat(r.rating) : ""}</span>
                      {r.bookingReference ? ` · ${r.bookingReference}` : ""}{r.jobSheetRef ? ` · ${r.jobSheetRef}` : ""}
                    </div>
                    {r.text && <div style={{ color: "var(--ink-soft)", fontSize: 12, fontStyle: "italic" }}>“{r.text}”</div>}
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <b style={{ fontVariantNumeric: "tabular-nums" }}>{thb(r.amount)}</b>
                    <div><span className={`ob ${r.status === "PAID" ? "ok" : "mut"}`} style={{ fontSize: 10.5 }}>{r.status === "IN_PAYOUT" ? "IN PAYOUT" : r.status}</span></div>
                  </div>
                </div>
              ))}
            </section>
          )}

          <div className="pay-toggle">
            <button className={tab === "pending" ? "on" : ""} onClick={() => setTab("pending")}>Pending{pending.length ? ` (${pending.length})` : ""}</button>
            <button className={tab === "paid" ? "on" : ""} onClick={() => setTab("paid")}>Paid</button>
            <button className={tab === "months" ? "on" : ""} onClick={() => setTab("months")}>Months</button>
          </div>

          {tab !== "months" ? (
            <div>
              {(tab === "pending" ? pending : paid).length === 0 ? (
                <div className="panel op-empty" style={{ padding: 18 }}>{tab === "pending" ? "No pending payments — you're all settled." : "No paid tours yet."}</div>
              ) : (
                (tab === "pending" ? pending : paid).map((t, i) => <PayCard key={i} t={t} guideId={d.guideId} />)
              )}
            </div>
          ) : (
            <div>
              {d.months.length === 0 ? <div className="panel op-empty" style={{ padding: 18 }}>No pay records yet.</div> : d.months.map((m) => {
                const isOpen = open[m.period] ?? false;
                return (
                  <div key={m.period} className="pay-mrow">
                    <button className="mhead" onClick={() => setOpen((o) => ({ ...o, [m.period]: !isOpen }))}>
                      <span><b>{m.label}</b><small>{m.tourCount} tour{m.tourCount === 1 ? "" : "s"}{m.reviewReward > 0 ? ` · ★ ${thb(m.reviewReward)} reviews` : ""}</small></span>
                      <span className="mt">{thb(m.total)}</span>
                    </button>
                    {isOpen && (
                      <div className="msub">
                        {m.tours.map((t, i) => <PayCard key={i} t={t} guideId={d.guideId} />)}
                      </div>
                    )}
                    <div className="mfoot">
                      {m.monthly.paid
                        ? <span className="pay-pill paid">✓ Paid{m.monthly.paidAt ? ` · ${paidLabel(m.monthly.paidAt)}` : ""}</span>
                        : <span className="pay-pill warn">{m.paidCount}/{m.tourCount} paid</span>}
                      {m.monthly.slip && <a className="pay-slip" href={m.monthly.slip} target="_blank" rel="noopener noreferrer">Transfer slip</a>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div style={{ textAlign: "center", margin: "14px 0" }}>
            <button className="btn sm" onClick={() => setAll((a) => !a)}>{all ? "Show recent 12 months" : "Show all history"}</button>
          </div>

          <p style={{ fontSize: 12, color: "var(--ink-soft)", lineHeight: 1.6, padding: "0 4px" }}>
            Each amount is your job total — guide fee after 3% withholding tax, plus reimbursed expenses. Open the transfer slip to check it matches.
          </p>
        </>
      )}
    </div>
  );
}
