"use client";

import { useEffect, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";

// Guide expense reports waiting for the operator's cross-check.
//
// The reports were always arriving; the back office simply had nowhere to see them.
// This is that place: every unreviewed report, oldest first, with what the guide
// says they spent next to what we recorded, and a link into the job sheet where the
// comparison can actually be accepted.

type Row = {
  guideId: string; guideName: string | null; date: string; slotIdx: number;
  ref: string | null; tour: string; lines: number;
  operatorTotal: number; guideTotal: number; difference: number;
  note: string | null; reportedAt: string | null;
  paid: boolean; underpaidRisk: boolean; href: string;
};
type Summary = { count: number; guideTotal: number; unpaid: number; claimedMore: number; claimedMoreTotal: number; underpaidRisk: number };
type Missing = { guideId: string; guideName: string | null; date: string; slotIdx: number; ref: string | null; tour: string; pax: number; completed: boolean; paid: boolean; paidWithNothingRecorded: boolean; href: string };
type MissingSummary = { count: number; unpaid: number; paidWithNothingRecorded: number; pax: number };

const baht = (n: number) => `฿${Math.round(n).toLocaleString("en-US")}`;
const day = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const ago = (iso: string | null) => {
  if (!iso) return "—";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return days <= 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
};

function Kpi({ v, label, tone }: { v: string; label: string; tone?: "warn" | "bad" }) {
  const fg = tone === "bad" ? "var(--danger)" : tone === "warn" ? "#b45309" : "var(--ink)";
  return (
    <div style={{ flex: "1 1 150px", minWidth: 140, padding: "12px 14px", border: "1px solid var(--line)", borderRadius: 12, background: "var(--card)" }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: fg, fontVariantNumeric: "tabular-nums" }}>{v}</div>
      <div style={{ fontSize: 11.5, color: "var(--ink-soft)", fontWeight: 600, marginTop: 2 }}>{label}</div>
    </div>
  );
}

export default function ExpenseReview() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [missing, setMissing] = useState<Missing[]>([]);
  const [missingSum, setMissingSum] = useState<MissingSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/expense-review", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { setRows(d.rows ?? []); setSummary(d.summary ?? null); setMissing(d.missing ?? []); setMissingSum(d.missingSummary ?? null); })
      .catch(() => setError("Could not load the review queue."));
  }, []);

  return (
    <>
      <AuthHeader />
      <main className="wrap" style={{ padding: "18px 16px 60px" }}>
        <h1 style={{ margin: "0 0 2px", fontSize: 22 }}>Guide expenses to review</h1>
        <p style={{ margin: "0 0 16px", color: "var(--ink-soft)", fontSize: 13 }}>
          What guides reported they paid on tour, still waiting to be checked against the official figures.
          <span style={{ display: "block" }}>ค่าใช้จ่ายที่ไกด์แจ้งมา รอตรวจสอบกับตัวเลขที่บริษัทบันทึกไว้</span>
        </p>

        {error && <div style={{ padding: "10px 14px", borderRadius: 8, background: "var(--danger-bg)", border: "1px solid var(--danger-line)", color: "var(--danger)", fontWeight: 600, fontSize: 13.5 }}>{error}</div>}
        {!rows && !error && <div style={{ color: "var(--ink-soft)", fontSize: 13 }}>Loading…</div>}

        {summary && rows && rows.length > 0 && (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
            <Kpi v={String(summary.count)} label="Waiting for review" tone="warn" />
            <Kpi v={baht(summary.guideTotal)} label="Reported by guides" />
            <Kpi v={summary.claimedMore ? `${summary.claimedMore} · ${baht(summary.claimedMoreTotal)}` : "0"} label="Guide claimed more than recorded" tone={summary.claimedMore ? "warn" : undefined} />
            <Kpi v={String(summary.underpaidRisk)} label="Already paid — may be short" tone={summary.underpaidRisk ? "bad" : undefined} />
          </div>
        )}

        {rows && rows.length === 0 && missing.length === 0 && (
          <div style={{ padding: "22px 16px", textAlign: "center", border: "1px solid var(--line)", borderRadius: 12, color: "var(--ink-soft)", fontSize: 13.5 }}>
            Nothing waiting — every guide report has been reviewed. ✓
          </div>
        )}

        {rows && rows.length > 0 && (
          <div style={{ border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "var(--paper)", fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--ink-soft)" }}>
                    <th style={{ textAlign: "left", padding: "8px 10px" }}>Tour</th>
                    <th style={{ textAlign: "left", padding: "8px 10px" }}>Guide</th>
                    <th style={{ textAlign: "right", padding: "8px 10px" }}>Recorded</th>
                    <th style={{ textAlign: "right", padding: "8px 10px" }}>Guide says</th>
                    <th style={{ textAlign: "right", padding: "8px 10px" }}>Difference</th>
                    <th style={{ textAlign: "left", padding: "8px 10px" }}>Reported</th>
                    <th style={{ padding: "8px 10px" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.guideId}|${r.date}|${r.slotIdx}`} style={{ borderTop: "1px solid var(--line)", background: r.underpaidRisk ? "var(--danger-bg)" : undefined }}>
                      <td style={{ padding: "8px 10px" }}>
                        <b>{day(r.date)}</b>
                        <div style={{ color: "var(--ink-soft)", fontSize: 11.5 }}>{r.tour}{r.ref ? ` · ${r.ref}` : ""}</div>
                        {r.note && <div style={{ color: "var(--ink-soft)", fontSize: 11.5, fontStyle: "italic", maxWidth: 280 }}>“{r.note}”</div>}
                      </td>
                      <td style={{ padding: "8px 10px" }}>
                        {r.guideName ?? r.guideId}
                        <div style={{ color: "var(--ink-soft)", fontSize: 11.5 }}>{r.guideId} · {r.lines} line{r.lines === 1 ? "" : "s"}</div>
                      </td>
                      <td style={{ padding: "8px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{baht(r.operatorTotal)}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700, color: "var(--primary)" }}>{baht(r.guideTotal)}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700, color: r.difference > 0 ? "#b45309" : r.difference < 0 ? "var(--ink-soft)" : "#2e7d4f" }}>
                        {r.difference === 0 ? "✓" : `${r.difference > 0 ? "+" : "−"}${baht(Math.abs(r.difference))}`}
                      </td>
                      <td style={{ padding: "8px 10px", color: "var(--ink-soft)", fontSize: 12 }}>
                        {ago(r.reportedAt)}
                        <div>
                          {r.underpaidRisk
                            ? <span style={{ color: "var(--danger)", fontWeight: 700, fontSize: 11.5 }}>⚠ paid — may be short</span>
                            : r.paid
                              ? <span style={{ fontSize: 11.5 }}>paid</span>
                              : <span style={{ fontSize: 11.5 }}>unpaid</span>}
                        </div>
                      </td>
                      <td style={{ padding: "8px 10px", textAlign: "right" }}>
                        <a className="btn sm" href={r.href}>Review</a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {missingSum && missing.length > 0 && (
          <section style={{ marginTop: 28 }}>
            <h2 style={{ margin: "0 0 2px", fontSize: 17 }}>Never reported</h2>
            <p style={{ margin: "0 0 12px", color: "var(--ink-soft)", fontSize: 13 }}>
              Tours that ran with guests but carry no expense report at all — so there is nothing to review, and no way to tell a tour that cost nothing from one nobody recorded.
              <span style={{ display: "block" }}>ทัวร์ที่มีแขกจริงแต่ไม่มีการรายงานค่าใช้จ่ายเลย</span>
            </p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
              <Kpi v={String(missingSum.count)} label="Tours with no report" tone="warn" />
              <Kpi v={String(missingSum.unpaid)} label="Still unpaid — can be fixed before the transfer" />
              <Kpi v={String(missingSum.paidWithNothingRecorded)} label="Already paid with nothing recorded" tone={missingSum.paidWithNothingRecorded ? "bad" : undefined} />
            </div>
            <div style={{ border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "var(--paper)", fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--ink-soft)" }}>
                      <th style={{ textAlign: "left", padding: "8px 10px" }}>Tour</th>
                      <th style={{ textAlign: "left", padding: "8px 10px" }}>Guide</th>
                      <th style={{ textAlign: "right", padding: "8px 10px" }}>Guests</th>
                      <th style={{ textAlign: "left", padding: "8px 10px" }}>State</th>
                      <th style={{ padding: "8px 10px" }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {missing.map((m) => (
                      <tr key={`${m.guideId}|${m.date}|${m.slotIdx}`} style={{ borderTop: "1px solid var(--line)", background: m.paidWithNothingRecorded ? "var(--danger-bg)" : undefined }}>
                        <td style={{ padding: "8px 10px" }}>
                          <b>{day(m.date)}</b>
                          <div style={{ color: "var(--ink-soft)", fontSize: 11.5 }}>{m.tour}{m.ref ? ` · ${m.ref}` : ""}</div>
                        </td>
                        <td style={{ padding: "8px 10px" }}>
                          {m.guideName ?? m.guideId}
                          <div style={{ color: "var(--ink-soft)", fontSize: 11.5 }}>{m.guideId}</div>
                        </td>
                        <td style={{ padding: "8px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{m.pax}</td>
                        <td style={{ padding: "8px 10px", fontSize: 12, color: "var(--ink-soft)" }}>
                          {m.completed ? "tour completed" : "not completed"}
                          <div>
                            {m.paidWithNothingRecorded
                              ? <span style={{ color: "var(--danger)", fontWeight: 700, fontSize: 11.5 }}>⚠ paid, nothing recorded</span>
                              : <span style={{ fontSize: 11.5 }}>unpaid</span>}
                          </div>
                        </td>
                        <td style={{ padding: "8px 10px", textAlign: "right" }}>
                          <a className="btn sm" href={m.href}>Open sheet</a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <p style={{ marginTop: 10, fontSize: 11.5, color: "var(--ink-soft)" }}>
              Ask the guide what they fronted, then record it on the sheet. Since 20 Sep 2026 a guide cannot finish a tour without reporting, so this list only grows from jobs completed before that — or completed for them by an operator.
            </p>
          </section>
        )}

        {rows && rows.length > 0 && (
          <p style={{ marginTop: 12, fontSize: 11.5, color: "var(--ink-soft)" }}>
            “Difference” compares the guide’s reported total with the expenses recorded on the job sheet. Open a row to accept the guide’s figures line by line, or keep the official ones — either way the sheet is approved and leaves this list.
          </p>
        )}
      </main>
    </>
  );
}
