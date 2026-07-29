"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";

type Row = {
  id: string;
  bankTransactionId: string | null;
  providerTransactionId: string | null;
  referenceType: string | null;
  referenceValue: string | null;
  memoRaw: string | null;
  matchedJobNo: string | null;
  matchedPayoutItemNo: string | null;
  matchedPaymentBatchNo: string | null;
  amount: number | null;
  currency: string | null;
  paidAt: string | null;
  memoValidationStatus: string | null;
  transactionValidationStatus: string | null;
  status: string | null;
  reason: string | null;
  peakExpenseNo: string | null;
  guideId: string | null;
  driveLink: string | null;
  createdAt: string | null;
};

const REF_TYPE_LABEL: Record<string, string> = {
  JOB_NO: "Job Number",
  PAYOUT_ITEM_NO: "Payout Item",
  PAYMENT_BATCH_NO: "Payment Batch",
  PEAK_EXPENSE_NO: "PEAK Expense",
  OTHER: "Other",
  NOT_FOUND: "None found",
};

const STATUS: Record<string, { label: string; bg: string; fg: string; line: string }> = {
  MATCHED: { label: "Matched", bg: "var(--green-bg)", fg: "var(--green)", line: "var(--green-line)" },
  PAYMENT_NEEDS_REVIEW: { label: "Needs review", bg: "var(--assign-bg)", fg: "var(--assign)", line: "var(--assign-line)" },
};

const thb = (n: number | null, ccy: string | null) =>
  n == null ? "—" : `${ccy === "THB" || !ccy ? "฿" : ccy + " "}${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const when = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
};

function Field({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
      <span style={{ fontSize: 10.5, letterSpacing: ".07em", textTransform: "uppercase", color: "var(--ink-soft)", fontWeight: 700 }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 600, fontVariantNumeric: mono ? "tabular-nums" : undefined, wordBreak: "break-all" }}>{value ?? "—"}</span>
    </div>
  );
}

export default function PaymentSlips({ canEdit = false }: { canEdit?: boolean }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState<"review" | "all">("review");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    return fetch(`/api/payments/transactions?filter=${filter}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setRows(d.rows ?? []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const resolve = async (r: Row, action: "confirm" | "dismiss") => {
    const msg = action === "confirm"
      ? `Confirm and mark ${r.matchedJobNo ?? "this payment"} PAID${r.guideId ? ` for guide ${r.guideId}` : ""}?`
      : "Dismiss this payment from the review queue? It will not be marked paid.";
    if (!window.confirm(msg)) return;
    setBusy(r.id);
    try {
      const res = await fetch("/api/payments/transactions/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: r.id, action }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        window.alert(`Could not ${action} this payment: ${e.error ?? res.status}`);
        return;
      }
      await load();
    } finally {
      setBusy(null);
    }
  };

  const reviewCount = useMemo(() => rows.filter((r) => r.status === "PAYMENT_NEEDS_REVIEW").length, [rows]);

  return (
    <div className="wrap">
      <AuthHeader />

      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, flexWrap: "wrap", margin: "4px 0 16px" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: "-.02em" }}>Payment slips</h2>
          <p style={{ margin: "4px 0 0", color: "var(--ink-soft)", fontSize: 13.5 }}>
            The bank Transaction ID and the Folkpaths payment reference are two separate fields.
          </p>
        </div>
        <div style={{ display: "inline-flex", background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, padding: 4, gap: 4, boxShadow: "var(--shadow-sm)" }}>
          {(["review", "all"] as const).map((f) => (
            <button key={f} className="btn sm" onClick={() => setFilter(f)}
              style={{ border: 0, background: filter === f ? "var(--primary)" : "transparent", color: filter === f ? "#fff" : "var(--ink-soft)" }}>
              {f === "review" ? "Needs review" : "All"}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p style={{ color: "var(--ink-soft)" }}>Loading…</p>
      ) : rows.length === 0 ? (
        <div className="panel" style={{ padding: "28px 20px", textAlign: "center", color: "var(--ink-soft)" }}>
          {filter === "review" ? "Nothing needs review. Matched payments move out of this list automatically." : "No recorded payment slips yet."}
        </div>
      ) : (
        <>
          {filter === "review" && reviewCount > 0 && (
            <p style={{ fontSize: 13, color: "var(--assign)", fontWeight: 700, margin: "0 2px 12px" }}>
              {reviewCount} payment{reviewCount === 1 ? "" : "s"} need a decision before they can be marked paid.
            </p>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {rows.map((r) => {
              const st = STATUS[r.status ?? ""] ?? { label: r.status ?? "—", bg: "var(--grey-bg)", fg: "var(--ink-soft)", line: "var(--line)" };
              return (
                <div key={r.id} className="panel" style={{ padding: 16 }}>
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
                    <div style={{ fontSize: 12.5, color: "var(--ink-soft)", fontWeight: 600 }}>
                      {r.guideId ? `Guide ${r.guideId}` : "Unassigned"} · {when(r.createdAt)}
                    </div>
                    <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: ".02em", padding: "3px 10px", borderRadius: 20, background: st.bg, color: st.fg, border: `1px solid ${st.line}`, whiteSpace: "nowrap" }}>
                      {st.label}
                    </span>
                  </div>

                  {/* The two fields the spec insists on keeping distinct. */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "14px 20px" }}>
                    <Field label="Bank Transaction ID" value={r.bankTransactionId || r.providerTransactionId || "—"} mono />
                    <Field label="Payment Reference" value={r.referenceValue || r.memoRaw || "—"} mono />
                    <Field label="Reference Type" value={REF_TYPE_LABEL[r.referenceType ?? ""] ?? r.referenceType ?? "—"} />
                    <Field label="Amount" value={thb(r.amount, r.currency)} mono />
                    <Field label="Transferred" value={when(r.paidAt)} />
                    {r.peakExpenseNo && <Field label="PEAK Expense" value={r.peakExpenseNo} mono />}
                  </div>

                  {(r.reason || r.driveLink || (canEdit && r.status === "PAYMENT_NEEDS_REVIEW")) && (
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
                      <span style={{ fontSize: 12.5, color: r.status === "PAYMENT_NEEDS_REVIEW" ? "var(--assign)" : "var(--ink-soft)" }}>{r.reason ?? ""}</span>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        {r.driveLink && (
                          <a className="btn sm" href={r.driveLink} target="_blank" rel="noopener noreferrer">View slip</a>
                        )}
                        {canEdit && r.status === "PAYMENT_NEEDS_REVIEW" && (
                          <>
                            <button className="btn sm" disabled={busy === r.id} onClick={() => resolve(r, "dismiss")}>Dismiss</button>
                            {r.matchedJobNo && (
                              <button className="btn sm" disabled={busy === r.id} onClick={() => resolve(r, "confirm")}
                                style={{ background: "var(--primary)", borderColor: "var(--primary)", color: "#fff" }}>
                                Confirm &amp; mark paid
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
