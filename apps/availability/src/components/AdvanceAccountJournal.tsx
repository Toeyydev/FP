"use client";

import { useEffect, useState } from "react";
import { thb } from "@/lib/jobsheet";
import type { AccountJournal, JournalEntry, JournalState } from "@/lib/advances/account-journal";

// The account journal of company advances (lib/advances/account-journal): each movement as
// its double entry, and where that entry stands with PEAK. Read-only — nothing on this panel
// posts, links or changes anything.

const KIND_LABEL: Record<JournalEntry["kind"], string> = { ADVANCE: "Advance issued", EXPENSE: "Costs settled", RETURN: "Money returned" };
const STATE: Record<JournalState, { label: string; tone: "ok" | "warn" | "muted" | "danger" }> = {
  POSTED: { label: "In PEAK", tone: "ok" },
  LINKED: { label: "In PEAK (linked)", tone: "ok" },
  BOOKED_IN_GUIDE_PAYMENT: { label: "In guide payment", tone: "ok" },
  READY: { label: "Ready to post", tone: "warn" },
  BLOCKED: { label: "Not ready", tone: "danger" },
  SENDING: { label: "Sending…", tone: "muted" },
  UNCERTAIN: { label: "Check PEAK", tone: "danger" },
  CANCELLED: { label: "Closed, no document", tone: "muted" },
};
const ORDER: JournalState[] = ["BLOCKED", "UNCERTAIN", "READY", "SENDING", "POSTED", "LINKED", "BOOKED_IN_GUIDE_PAYMENT", "CANCELLED"];
const toneColor = (t: "ok" | "warn" | "muted" | "danger") => t === "danger" ? "var(--danger, #b3402f)" : t === "warn" ? "#8a6100" : t === "ok" ? "var(--green, #2e7d4f)" : "var(--ink-soft)";

export default function AdvanceAccountJournal({ version }: { version: number }) {
  const [data, setData] = useState<AccountJournal | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/advances/journal", { cache: "no-store" })
      .then(async (r) => { if (!r.ok) throw new Error(`Could not load the account journal (${r.status})`); return r.json(); })
      .then((d) => { if (live) { setData(d as AccountJournal); setErr(null); } })
      .catch((e) => { if (live) setErr(String((e as Error).message)); });
    return () => { live = false; };
  }, [version]);

  return (
    <div className="js-account-journal" style={{ display: "grid", gap: 8 }}>
      <h3 style={{ margin: "6px 0 0" }}>Account journal <small className="muted" style={{ fontWeight: 500 }}>สมุดรายวันเงินทดรอง — what each movement books, and where it stands in PEAK</small></h3>
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
        Every advance, settlement and return as its double entry. “Ready to post” is exactly what FolkOPS would send to PEAK;
        “Not ready” says what is missing. This list only shows — it posts nothing.
      </p>
      {err && <div className="banner danger" role="alert">{err}</div>}
      {data && !data.configured && <div className="banner warn" role="status">The advance accounts are not configured for PEAK, so no entry can name its accounts yet.</div>}
      {data && data.autoSync && <div className="banner warn js-journal-autosync" role="status">Automatic posting is ON: entries marked “Ready to post” are sent to PEAK by the worker without a further click.</div>}
      {data && (
        <>
          <div className="js-journal-totals" style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 13 }}>
            {ORDER.filter((s) => data.totals.byState[s]).map((s) => (
              <span key={s} data-state={s} style={{ color: toneColor(STATE[s].tone) }}><b>{data.totals.byState[s]!.count}</b> {STATE[s].label} · {thb(data.totals.byState[s]!.amount)}</span>
            ))}
            <span className="muted js-journal-net">Advance account, by these entries: <b>{thb(data.totals.advanceAccountNet)}</b> still with guides</span>
          </div>
          <div className="tablewrap">
            <table className="adv-table js-journal-table">
              <thead><tr><th>Date</th><th>Movement</th><th>Account</th><th className="r">Debit</th><th className="r">Credit</th><th>PEAK</th></tr></thead>
              <tbody>
                {data.entries.length === 0 && <tr><td colSpan={6} className="muted">No advance movements yet.</td></tr>}
                {data.entries.map((e) => {
                  const rows = e.lines.length ? e.lines : [null];
                  return rows.map((l, i) => (
                    <tr key={`${e.id}-${i}`} className={i === 0 ? "js-journal-entry adv-entry-first" : undefined} data-id={i === 0 ? e.id : undefined} data-state={i === 0 ? e.state : undefined}>
                      {i === 0 && (
                        <>
                          <td rowSpan={rows.length} style={{ whiteSpace: "nowrap", verticalAlign: "top" }}>{e.date}</td>
                          <td rowSpan={rows.length} style={{ verticalAlign: "top" }}>
                            <b>{KIND_LABEL[e.kind]}</b> · {thb(e.amount)}
                            <span style={{ display: "block", fontSize: 11.5, color: "var(--ink-soft)" }}>{e.reference.startsWith("FOLK-SET-") ? "settlement" : e.reference} · {e.guideId}{e.jobNo ? ` · ${e.jobNo}` : ""}</span>
                          </td>
                        </>
                      )}
                      {l ? (
                        <>
                          <td style={{ paddingLeft: l.credit ? 22 : undefined }}>{l.accountCode ?? <span style={{ color: "var(--danger, #b3402f)" }}>no account</span>} <span className="muted">{l.label}</span></td>
                          <td className="r" style={{ fontVariantNumeric: "tabular-nums" }}>{l.debit ? thb(l.debit) : ""}</td>
                          <td className="r" style={{ fontVariantNumeric: "tabular-nums" }}>{l.credit ? thb(l.credit) : ""}</td>
                        </>
                      ) : <td colSpan={3} className="muted">The lines of this settlement cannot be worked out — an accountant has to review it.</td>}
                      {i === 0 && (
                        <td rowSpan={rows.length} style={{ verticalAlign: "top", maxWidth: 320 }}>
                          <b style={{ color: toneColor(STATE[e.state].tone) }}>{STATE[e.state].label}</b>
                          {e.documentNo && <span> · {e.documentNo}</span>}
                          {e.state === "LINKED" && e.verified === false && <span className="muted"> · not fully checked</span>}
                          {e.reason && <span className="js-journal-reason" style={{ display: "block", fontSize: 11.5, color: "var(--ink-soft)" }}>{e.reason}</span>}
                          {!e.balanced && e.lines.length > 0 && <span style={{ display: "block", fontSize: 11.5, color: "var(--danger, #b3402f)" }}>Debits and credits do not agree with the movement.</span>}
                        </td>
                      )}
                    </tr>
                  ));
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
