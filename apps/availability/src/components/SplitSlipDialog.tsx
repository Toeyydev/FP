"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  batchSummary, batchTotals, newRows, nextPendingIndex, parseAmount,
  type SlipRow,
} from "@/lib/payments/split-slip-batch";
import type { Slip } from "@/lib/payments/slips";

const thb = (n: number) => `฿${Math.round(n).toLocaleString("en-US")}`;

export type SlipUpload =
  | { ok: true; remaining: number }
  | { ok: false; error: string };

export type SplitSlipDialogProps = {
  files: File[];
  payout: number;
  existingSlips: Slip[] | null | undefined;
  context: string;                 // e.g. "G-013 · Chantal Schneider · 10 Sep"
  upload: (file: File, amount: number) => Promise<SlipUpload>;
  onClose: () => void;             // closed without finishing — caller decides whether to refresh
  onFinished: () => void;          // at least one slip went up — caller refreshes Payments
};

/** Multi-slip upload. Nothing is sent until Upload is pressed, so closing the
 *  dialog beforehand leaves the tour exactly as it was. */
export default function SplitSlipDialog({ files, payout, existingSlips, context, upload, onClose, onFinished }: SplitSlipDialogProps) {
  const [rows, setRows] = useState<SlipRow[]>(() => newRows(files));
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState(0);          // 1-based position while uploading
  const [done, setDone] = useState(false);
  const uploadedAny = useRef(false);
  const firstInput = useRef<HTMLInputElement>(null);

  const totals = useMemo(() => batchTotals(rows, payout, existingSlips), [rows, payout, existingSlips]);
  const summary = useMemo(() => batchSummary(rows, payout, existingSlips), [rows, payout, existingSlips]);

  useEffect(() => { firstInput.current?.focus(); }, []);

  const close = useCallback(() => {
    if (busy) return;                       // never abandon a batch mid-flight
    if (uploadedAny.current) onFinished(); else onClose();
  }, [busy, onClose, onFinished]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const setAmount = (i: number, value: string) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, amount: value, error: undefined } : r)));

  async function run() {
    setBusy(true); setDone(false);
    // Work off a local copy: React state updates are async and the loop needs the
    // row it is about to send, not the one from the last render.
    let work = rows;
    for (;;) {
      const i = nextPendingIndex(work);
      if (i < 0) break;
      const amount = parseAmount(work[i].amount);
      if (amount == null) { work = work.map((r, j) => (j === i ? { ...r, state: "failed", error: "Enter an amount." } : r)); setRows(work); break; }
      setAt(i + 1);
      work = work.map((r, j) => (j === i ? { ...r, state: "uploading", error: undefined } : r));
      setRows(work);
      const res = await upload(files[i], amount);
      if (res.ok) {
        uploadedAny.current = true;
        work = work.map((r, j) => (j === i ? { ...r, state: "uploaded", error: undefined } : r));
        setRows(work);
      } else {
        // Stop here. Everything already uploaded stays on the tour; this row and
        // the ones after it are still to send, so Retry resumes from exactly here.
        work = work.map((r, j) => (j === i ? { ...r, state: "failed", error: res.error } : r));
        setRows(work);
        break;
      }
    }
    setBusy(false); setAt(0); setDone(true);
  }

  const failedAt = rows.findIndex((r) => r.state === "failed");
  const allUploaded = rows.every((r) => r.state === "uploaded");
  const kind = (t: string) => (t === "application/pdf" ? "PDF" : t.startsWith("image/") ? t.slice(6).toUpperCase() : "file");

  return (
    <div className="scrim show" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="slipdlg-h" style={{ maxWidth: 560 }}>
        <h3 id="slipdlg-h">Split slips</h3>
        <div className="mctx">{context} · payout {thb(totals.payout)}</div>

        <div className="mbody">
          {/* Running totals — req 3/4: recomputed as the operator types. */}
          <div style={{ display: "grid", gap: 4, background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px", fontSize: 13 }}>
            <Line label="Tour payout" value={thb(totals.payout)} />
            {totals.alreadyPaid > 0 && <Line label="Already paid" value={thb(totals.alreadyPaid)} />}
            <Line label="Entered in this batch" value={thb(totals.entered)} />
            <Line
              label={totals.over ? "Over the payout by" : "Remaining after this batch"}
              value={totals.over ? thb(totals.projectedTotal - totals.payout) : thb(totals.projectedRemaining)}
              strong
              tone={totals.over ? "danger" : totals.projectedRemaining === 0 ? "ok" : undefined}
            />
          </div>

          {/* Warnings — req 5. */}
          <div aria-live="polite" style={{ display: "grid", gap: 6 }}>
            {totals.invalidCount > 0 && !busy && (
              <Note tone="warn">{totals.invalidCount} slip{totals.invalidCount === 1 ? "" : "s"} still {totals.invalidCount === 1 ? "needs" : "need"} an amount.</Note>
            )}
            {totals.over && <Note tone="danger">This batch would pay {thb(totals.projectedTotal - totals.payout)} more than the payout. The tour will not be marked paid — adjust an amount.</Note>}
            {!totals.over && totals.under && totals.invalidCount === 0 && (
              <Note tone="warn">{thb(totals.projectedRemaining)} would still be owed after this batch. The tour stays partly paid.</Note>
            )}
            {!totals.over && !totals.under && totals.invalidCount === 0 && !done && (
              <Note tone="ok">These slips add up to the payout exactly — the tour will be marked paid.</Note>
            )}
          </div>

          {/* Files — req 2. */}
          <div style={{ display: "grid", gap: 8 }}>
            {rows.map((r, i) => (
              <div key={`${r.name}-${i}`} style={{ display: "flex", gap: 10, alignItems: "center", border: "1px solid var(--line)", borderRadius: 10, padding: "8px 10px", background: r.state === "failed" ? "var(--danger-bg)" : "var(--card)" }}>
                <span aria-hidden style={{ fontSize: 18, width: 22, textAlign: "center" }}>{r.type === "application/pdf" ? "📄" : "🧾"}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                  <span style={{ fontSize: 11.5, color: "var(--ink-soft)" }}>
                    {kind(r.type)} · <StateTag state={r.state} />
                    {r.error ? <span style={{ color: "var(--danger)" }}> — {r.error}</span> : null}
                  </span>
                </span>
                <span style={{ width: 128 }}>
                  <label className="fl" htmlFor={`slip-amt-${i}`} style={{ marginBottom: 3 }}>Amount ฿</label>
                  <input
                    id={`slip-amt-${i}`} ref={i === 0 ? firstInput : undefined}
                    inputMode="decimal" value={r.amount} placeholder="0"
                    disabled={busy || r.state === "uploaded"}
                    onChange={(e) => setAmount(i, e.target.value)}
                    aria-invalid={r.state !== "uploaded" && r.amount !== "" && parseAmount(r.amount) == null}
                    style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}
                  />
                </span>
              </div>
            ))}
          </div>

          {/* Outcome — req 9/11. */}
          {done && (
            <div aria-live="polite" style={{ display: "grid", gap: 6 }}>
              {failedAt >= 0 ? (
                <Note tone="danger">
                  Stopped at <b>{rows[failedAt].name}</b>. {summary.count} slip{summary.count === 1 ? "" : "s"} totalling {thb(summary.total)} {summary.count === 1 ? "was" : "were"} uploaded and {summary.count === 1 ? "is" : "are"} kept.
                  {" "}The tour remains partly paid — {thb(summary.remaining)} still owed. Retry sends the failed slip and the ones after it; nothing already uploaded is sent again.
                </Note>
              ) : summary.complete ? (
                <Note tone="ok">{summary.count} slip{summary.count === 1 ? "" : "s"} uploaded, {thb(summary.total)} in total. The payout is fully covered — the tour is marked paid.</Note>
              ) : (
                <Note tone="warn">{summary.count} slip{summary.count === 1 ? "" : "s"} uploaded, {thb(summary.total)} in total. {thb(summary.remaining)} still owed.</Note>
              )}
            </div>
          )}
        </div>

        <div className="mfoot">
          {busy && <span aria-live="polite" style={{ marginRight: "auto", fontSize: 12.5, color: "var(--ink-soft)" }}>Uploading {at} of {rows.length}…</span>}
          <button className="btn ghost" onClick={close} disabled={busy}>{allUploaded || done ? "Close" : "Cancel"}</button>
          {!allUploaded && (
            <button className="btn primary" onClick={run} disabled={busy || !totals.canUpload}>
              {busy ? "Uploading…" : failedAt >= 0 ? `Retry from ${rows[failedAt].name.slice(0, 18)}` : `Upload ${totals.pendingCount} slip${totals.pendingCount === 1 ? "" : "s"}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Line({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: "ok" | "danger" }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
      <span style={{ color: "var(--ink-soft)" }}>{label}</span>
      <b style={{ fontVariantNumeric: "tabular-nums", fontWeight: strong ? 800 : 600, color: tone === "danger" ? "var(--danger)" : tone === "ok" ? "var(--green,#2f7d4f)" : undefined }}>{value}</b>
    </div>
  );
}

function Note({ tone, children }: { tone: "ok" | "warn" | "danger"; children: React.ReactNode }) {
  const c = tone === "danger"
    ? { bg: "var(--danger-bg)", line: "var(--danger-line)", ink: "var(--danger)" }
    : tone === "ok" ? { bg: "var(--ok-bg,#eef7f0)", line: "var(--ok-line,#cfe6d6)", ink: "var(--green,#2f7d4f)" }
    : { bg: "#fff8c4", line: "#ecd9bf", ink: "var(--ink)" };
  return <div style={{ background: c.bg, border: `1px solid ${c.line}`, color: c.ink, borderRadius: 9, padding: "7px 10px", fontSize: 12.5 }}>{children}</div>;
}

function StateTag({ state }: { state: SlipRow["state"] }) {
  const label = state === "ready" ? "Ready" : state === "uploading" ? "Uploading…" : state === "uploaded" ? "Uploaded ✓" : "Failed";
  const color = state === "uploaded" ? "var(--green,#2f7d4f)" : state === "failed" ? "var(--danger)" : "var(--ink-soft)";
  return <span style={{ color, fontWeight: 600 }}>{label}</span>;
}
