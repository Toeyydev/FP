"use client";

import { useEffect, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import { GuideTabs } from "@/components/GuideTabs";

type Tour = { date: string; slotIdx: number; time: string; tour: string; ref: string | null; amount: number; reviewReward: number; paid: boolean; paidAt: string | null; slip: string | null };
type Month = { period: string; label: string; tourCount: number; total: number; reviewReward: number; paidCount: number; monthly: { paid: boolean; paidAt: string | null; slip: string | null }; tours: Tour[] };
type Data = { months: Month[]; yearTotal: number; paidThisMonth: number; guideId: string; all?: boolean };

const thb = (v: number) => `฿${v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const dLabel = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const paidLabel = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");

function Slip({ url }: { url: string | null }) {
  if (!url) return null;
  return <a className="pay-slip" href={url} target="_blank" rel="noopener noreferrer">View slip</a>;
}
function SheetLink({ guideId, date, slotIdx }: { guideId: string; date: string; slotIdx: number }) {
  return <a className="pay-slip" href={`/job-sheet?guideId=${encodeURIComponent(guideId)}&date=${date}&slotIdx=${slotIdx}`}>Job sheet</a>;
}
function Status({ paid, paidAt }: { paid: boolean; paidAt: string | null }) {
  return paid
    ? <span className="pay-pill paid">✓ Paid{paidAt ? ` · ${paidLabel(paidAt)}` : ""}</span>
    : <span className="pay-pill pend">Awaiting payment</span>;
}
// Review reward earned on a tour (part of its total) — shown on its own so the
// guide can see what a review paid them.
function ReviewReward({ amount }: { amount: number }) {
  if (!amount) return null;
  return <span className="pay-pill" style={{ color: "#a06a00", background: "rgba(234,160,20,.12)" }}>★ Review {thb(amount)}</span>;
}

export default function MyPay() {
  const [d, setD] = useState<Data | null>(null);
  const [view, setView] = useState<"daily" | "monthly">("daily");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [all, setAll] = useState(false); // false = last 12 months, true = full history

  useEffect(() => { setD(null); fetch(`/api/my-pay${all ? "?all=1" : ""}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then(setD).catch(() => {}); }, [all]);

  const allTours = d ? d.months.flatMap((m) => m.tours).sort((a, b) => b.date.localeCompare(a.date) || b.slotIdx - a.slotIdx) : [];

  return (
    <div className="wrap">
      <AuthHeader backHref="/" />
      <GuideTabs active="pay" />

      <section className="panel" style={{ padding: 16 }}>
        {!d ? (
          <div><div className="kpi-row">{Array.from({ length: 2 }).map((_, i) => <div key={i} className="kpi skel" />)}</div>
            {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skel-row" style={{ height: 64, marginTop: 10 }} />)}</div>
        ) : (
          <>
            <div className="pay-tot">
              <div><span className="k">Paid this month</span><span className="v">{thb(d.paidThisMonth)}</span></div>
            </div>

            <div className="pay-toggle">
              <button className={view === "daily" ? "on" : ""} onClick={() => setView("daily")}>Daily</button>
              <button className={view === "monthly" ? "on" : ""} onClick={() => setView("monthly")}>Monthly</button>
            </div>
            <div style={{ textAlign: "right", marginBottom: 8 }}>
              <button className="btn sm" onClick={() => setAll((a) => !a)}>{all ? "Show recent 12 months" : "Show all history"}</button>
            </div>

            {allTours.length === 0 ? <div className="op-empty">No pay records yet.</div> : view === "daily" ? (
              <div>
                {allTours.map((t, i) => (
                  <div key={i} className="pay-row">
                    <div className="r1">
                      <div style={{ minWidth: 0 }}><div className="when">{dLabel(t.date)} · {t.time}</div><div className="tour">{t.tour}</div></div>
                      <div className="amt">{thb(t.amount)}</div>
                    </div>
                    <div className="r2"><Status paid={t.paid} paidAt={t.paidAt} /><ReviewReward amount={t.reviewReward} /><Slip url={t.slip} /><SheetLink guideId={d.guideId} date={t.date} slotIdx={t.slotIdx} /></div>
                  </div>
                ))}
              </div>
            ) : (
              <div>
                {d.months.map((m) => {
                  const isOpen = open[m.period] ?? false;
                  return (
                    <div key={m.period} className="pay-mrow">
                      <button className="mhead" onClick={() => setOpen((o) => ({ ...o, [m.period]: !isOpen }))}>
                        <span><b>{m.label}</b><small>{m.tourCount} tour{m.tourCount === 1 ? "" : "s"}{m.reviewReward > 0 ? ` · ★ ${thb(m.reviewReward)} reviews` : ""} · {isOpen ? "tap to collapse" : "tap for details"}</small></span>
                        <span className="mt">{thb(m.total)}</span>
                      </button>
                      {isOpen && (
                        <div className="msub">
                          {m.tours.map((t, i) => (
                            <div key={i} className="sub-r"><span className="sw">{dLabel(t.date)} · {t.tour} {t.reviewReward > 0 ? <span style={{ color: "#a06a00" }}>★{thb(t.reviewReward)}</span> : null} <SheetLink guideId={d.guideId} date={t.date} slotIdx={t.slotIdx} /></span><span className="sa">{thb(t.amount)}{!t.paid ? " ⏳" : ""}</span></div>
                          ))}
                        </div>
                      )}
                      <div className="mfoot">
                        {m.monthly.paid
                          ? <span className="pay-pill paid">✓ Paid{m.monthly.paidAt ? ` · ${paidLabel(m.monthly.paidAt)}` : ""}</span>
                          : <span className="pay-pill warn">{m.paidCount}/{m.tourCount} paid</span>}
                        <Slip url={m.monthly.slip} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <p style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 14, lineHeight: 1.6 }}>
              Each amount is your job sheet total — guide fee after {3}% withholding tax, plus reimbursed expenses. Open the slip to check the transfer matches.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
