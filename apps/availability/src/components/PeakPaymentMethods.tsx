"use client";

import { useEffect, useState } from "react";

// Payment-method reference on Accounting → PEAK sync.
//
// PEAK_PAYMENT_METHOD is an opaque PEAK id that has to go into Railway. This lists
// the real methods from PEAK so the right id is copied rather than hunted for, and
// shows which one the current setting resolves to.
//
// Deliberately a REFERENCE, not a picker: the payout reads the env var, and
// changing where it reads from would be a change to posting behaviour. Read-only
// on both sides — it lists methods and writes nothing.

type Method = { id: string; code?: string; name: string; type?: string; bankName?: string; accountNumber?: string };

export default function PeakPaymentMethods({ configuredId }: { configuredId: string | null }) {
  const [methods, setMethods] = useState<Method[] | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<string>("");

  useEffect(() => {
    fetch("/api/peak/payment-methods", { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.ok) setMethods(d.methods ?? []);
        else { setMethods([]); setError(d.error || "Could not load PEAK payment methods."); }
      })
      .catch(() => { setMethods([]); setError("Could not reach the server to load payment methods."); });
  }, []);

  const configured = methods?.find((m) => m.id === configuredId);

  return (
    <section className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-head">
        <h2>Payment method</h2>
        <span className="hint">The PEAK account a guide payout settles to.</span>
        <span style={{ marginLeft: "auto" }} className={`acct-ready ${configured ? "ok" : "warn"}`}>
          {configured ? "Configured" : configuredId ? "Set, but not in PEAK's list" : "Not configured"}
        </span>
      </div>

      <div style={{ padding: "10px 16px 14px", fontSize: 13 }}>
        <div className="acct-sub" style={{ marginBottom: 8 }}>
          Set <code>PEAK_PAYMENT_METHOD</code> in Railway to one of these ids.
          {configured && <> Currently: <b style={{ color: "var(--ink)" }}>{configured.name}</b>.</>}
          {!configured && configuredId && <> The configured id is not in PEAK&apos;s list — a payout would be rejected.</>}
        </div>

        {error && (
          <div className="acct-warn-bar" style={{ margin: "0 0 8px" }}>
            <b>PEAK payment methods unavailable</b>
            <span>{error}</span>
          </div>
        )}

        {methods === null ? (
          <div>{Array.from({ length: 2 }).map((_, i) => <div key={i} className="skel-row" />)}</div>
        ) : methods.length ? (
          <div className="grid-scroll">
            <table className="acct-table">
              <thead><tr>
                <th style={{ width: 250 }}>Method</th>
                <th style={{ width: 190 }}>Bank / account</th>
                <th>PEAK id</th>
              </tr></thead>
              <tbody>
                {methods.map((m) => (
                  <tr key={m.id} style={m.id === configuredId ? { background: "var(--green-bg)" } : undefined}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{m.name || "—"}</div>
                      {m.code && <div className="acct-code">code {m.code}</div>}
                    </td>
                    <td className="acct-sub">{[m.bankName, m.accountNumber].filter(Boolean).join(" · ") || m.type || "—"}</td>
                    <td>
                      <code className="acct-id">{m.id}</code>
                      <button type="button" className="btn sm ghost" style={{ marginLeft: 6, padding: "1px 6px" }}
                        onClick={() => { navigator.clipboard?.writeText(m.id).then(() => { setCopied(m.id); setTimeout(() => setCopied(""), 1500); }).catch(() => {}); }}>
                        {copied === m.id ? "Copied" : "Copy"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : !error ? (
          <div className="acct-sub">No payment methods returned.</div>
        ) : null}
      </div>
    </section>
  );
}
