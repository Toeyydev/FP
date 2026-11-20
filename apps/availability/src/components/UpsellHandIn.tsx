"use client";

import { Fragment, useCallback, useEffect, useState } from "react";

// The guide hands in the Extras cash of one job (PR4; mockup v9a approved with Codex's copy fixes):
// after the end-tour report, one or more real transfers — amount, the date and time the bank sent
// it, its reference, its slip — sent together for exactly the amount owed. Returned = pending
// verification: transfers already made stay recorded and are never asked for again. Everything
// shown comes from the server (lib/upsell/settlement); this screen only reports and sends.

type Transfer = { id: string; seq: number; amountSatang: number; transferredAt: string; transferDate: string; bankRef: string; hasSlip: boolean; toAccount: string; status: string; withdrawnReason: string | null };
type View = {
  heldSatang: number; toRemitSatang: number; status: string; settlementNo: string | null; submissionNo: number; returnedReason: string | null;
  memo: string | null; jobRef: string | null; coverage: { saleNo: string; productName: string; guests: number; grossSatang: number; status: string }[];
  receivingAccount: { id: string; version: number; label: string; display: string } | null;
  transfers: Transfer[];
  history: { submissionNo: number; totalSatang: number; transferIds: string[]; status: string; submittedAt: string; returnedReason: string | null; returnedAt: string | null; confirmedAt: string | null }[];
};

const C = { ink: "#18181B", soft: "#71717A", brand: "#0E3B2E", line: "#E5E7EB", warnBg: "#FBF4E4", warnLine: "#EADFC3", warnInk: "#5C3B06", okBg: "#EAF4EF", okLine: "#CBE5D6", okInk: "#0E5A33", badBg: "#FBEDEA", badLine: "#EFCFC7", badInk: "#8A2A1C" };
const baht = (s: number) => `฿${(s / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const sent = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const btn = (primary: boolean) => ({ minHeight: 48, width: "100%", borderRadius: 10, border: `1px solid ${C.brand}`, background: primary ? C.brand : "#fff", color: primary ? "#fff" : C.brand, font: "inherit", fontSize: 15, fontWeight: 700, cursor: "pointer" }) as const;
const field = { boxSizing: "border-box", width: "100%", minHeight: 44, border: "1px solid #A1A1AA", borderRadius: 8, padding: "8px 10px", font: "inherit", fontSize: 15, background: "#fff", color: C.ink } as const;
const label = { fontWeight: 700, fontSize: 14 } as const;
const bangkokNow = () => new Date(Date.now() + 7 * 3600_000).toISOString();

async function call(url: string, init?: RequestInit) {
  const r = await fetch(url, init);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d.reasons ?? [d.error ?? `HTTP ${r.status}`]).join(" "));
  return d;
}

export default function UpsellHandIn({ jobSheetId }: { jobSheetId: string }) {
  const [v, setV] = useState<View | null>(null);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [takeOut, setTakeOut] = useState<{ id: string; reason: string } | null>(null);
  const [form, setForm] = useState({ amount: "", date: bangkokNow().slice(0, 10), time: bangkokNow().slice(11, 16), bankRef: "", file: null as File | null, key: "" });

  const load = useCallback(async () => {
    try { setV(await call(`/api/upsell/hand-in/${jobSheetId}`, { cache: "no-store" })); } catch { /* the block above still shows the cash */ }
  }, [jobSheetId]);
  useEffect(() => { void load(); }, [load]);
  if (!v || (v.heldSatang === 0 && v.status === "NOT_SENT" && v.transfers.length === 0)) return null;

  const reported = v.transfers.filter((t) => t.status === "REPORTED");
  const total = reported.reduce((n, t) => n + t.amountSatang, 0);
  const editable = v.status === "NOT_SENT" || v.status === "DRAFT" || v.status === "RETURNED";
  const prepared = !!v.memo;
  const exact = reported.length > 0 && total === v.toRemitSatang && v.toRemitSatang > 0;

  const addTransfer = async () => {
    setBusy(true); setErr("");
    try {
      if (!form.file) throw new Error("Attach the slip of this transfer");
      const fd = new FormData(); fd.append("file", form.file);
      const slip = await call(`/api/upsell/hand-in/${jobSheetId}/slip`, { method: "POST", body: fd });
      // The key is kept while the form is open: sending again (a lost signal) records it once.
      const requestKey = form.key || crypto.randomUUID();
      setForm((f) => ({ ...f, key: requestKey }));
      await call(`/api/upsell/hand-in/${jobSheetId}/transfers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        amountSatang: Math.round(Number(form.amount) * 100), transferredAt: new Date(`${form.date}T${form.time}:00+07:00`).toISOString(), bankRef: form.bankRef.trim(), slip: { evidenceId: slip.evidenceId }, requestKey,
      }) });
      setAdding(false);
      setForm({ amount: "", date: bangkokNow().slice(0, 10), time: bangkokNow().slice(11, 16), bankRef: "", file: null, key: "" });
      await load();
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };
  // The hand-in code comes first: the guide puts it in the transfer's memo (owner, 20 Nov 2026).
  const prepare = async () => {
    setBusy(true); setErr("");
    try { await call(`/api/upsell/hand-in/${jobSheetId}/prepare`, { method: "POST" }); await load(); } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(v.memo ?? ""); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* select the text by hand */ }
  };
  const withdraw = async () => {
    if (!takeOut) return;
    setBusy(true); setErr("");
    try {
      await call(`/api/upsell/hand-in/transfers/${takeOut.id}/withdraw`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: takeOut.reason }) });
      setTakeOut(null); await load();
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };
  const send = async () => {
    setBusy(true); setErr("");
    try {
      await call(`/api/upsell/hand-in/${jobSheetId}/submit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transferIds: reported.map((t) => t.id) }) });
      await load();
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  const row = (t: Transfer) => {
    const out = t.status === "WITHDRAWN", ok = t.status === "CONFIRMED";
    const tone = out ? { background: "#F4F4F5", border: `1px solid ${C.line}`, color: C.soft } : ok ? { background: C.okBg, border: `1px solid ${C.okLine}`, color: C.okInk } : { background: C.warnBg, border: `1px solid ${C.warnLine}`, color: C.warnInk };
    return (
      <li key={t.id} className="ups-transfer" style={{ ...tone, borderRadius: 10, padding: "10px 12px", fontSize: 13.5, lineHeight: 1.5, overflowWrap: "anywhere" }}>
        <b>{ok ? "✓ " : ""}Transfer {t.seq}</b> · {baht(t.amountSatang)} · sent <b>{sent(t.transferredAt)}</b> · ref {t.bankRef}{t.hasSlip ? " · slip ✓" : ""}
        <br /><small>to {t.toAccount} (as set when you reported it)</small>
        {out && <><br /><small>Taken out of this hand-in: “{t.withdrawnReason}”. It stays in the history with its slip.</small></>}
        {!out && !ok && v.status === "RETURNED" && <><br /><small><b>Included again in this submission — do not transfer again.</b> Take it out only if this was the wrong slip.</small></>}
        {!out && !ok && editable && takeOut?.id !== t.id && (
          <div><button type="button" className="ups-takeout" onClick={() => setTakeOut({ id: t.id, reason: "" })} style={{ marginTop: 6, minHeight: 40, padding: "0 12px", borderRadius: 8, border: `1px solid ${C.badInk}`, background: "#fff", color: C.badInk, font: "inherit", fontWeight: 700, cursor: "pointer" }}>Take out…</button></div>
        )}
        {takeOut?.id === t.id && (
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            <label htmlFor={`ups-out-${t.id}`} style={label}>Why take it out?</label>
            <input id={`ups-out-${t.id}`} style={field} value={takeOut.reason} onChange={(e) => setTakeOut({ id: t.id, reason: e.target.value })} placeholder="e.g. the wrong slip was attached" />
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={() => setTakeOut(null)} style={{ ...btn(false), minHeight: 44 }}>Keep it</button>
              <button type="button" disabled={busy || takeOut.reason.trim().length < 5} onClick={() => void withdraw()} style={{ ...btn(true), minHeight: 44, background: C.badInk, borderColor: C.badInk }}>Take out</button>
            </div>
          </div>
        )}
      </li>
    );
  };

  return (
    <section className="js-handin" aria-labelledby="handin-h" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <h4 id="handin-h" style={{ margin: 0, fontSize: 15 }}>Hand in the Extras cash <small style={{ fontWeight: 500, color: C.soft }}>นำส่งเงินขายเพิ่ม</small></h4>
      {v.status === "RETURNED" && (
        <div role="alert" className="ups-returned" style={{ background: C.badBg, border: `1px solid ${C.badLine}`, borderRadius: 10, padding: "10px 12px", color: C.badInk }}>
          <b>Returned for checking · {v.settlementNo} · submission {v.submissionNo}</b><br />
          <span style={{ fontSize: 13 }}>Admin: “{v.returnedReason}”. Your transfers stay recorded and any money already in the bank stays counted — <b>do not send them again</b>. Fix only what Admin asked, then send again.</span>
        </div>
      )}
      {v.status === "SUBMITTED" && <div role="status" style={{ background: C.warnBg, border: `1px solid ${C.warnLine}`, borderRadius: 10, padding: "10px 12px", color: C.warnInk, fontSize: 13.5 }}><b>Sent — waiting for Admin</b> · {v.settlementNo} · submission {v.submissionNo}<br />Cash held stays {baht(v.heldSatang)} until Admin confirms it against the bank.</div>}
      {v.status === "CONFIRMED" && <div role="status" className="ups-confirmed" style={{ background: C.okBg, border: `1px solid ${C.okLine}`, borderRadius: 10, padding: "10px 12px", color: C.okInk, fontSize: 13.5 }}><b>✓ Confirmed</b> · {v.settlementNo}. Locked — a correction after confirmation is made by Admin (later).</div>}


      {editable && !prepared && (
        <>
          <p style={{ margin: 0, fontSize: 13.5 }}>First get this job’s hand-in code — you put it in the memo of your bank transfer, so Folkpaths can match the money to this tour.</p>
          <button type="button" className="ups-prepare" disabled={busy} onClick={() => void prepare()} style={btn(true)}>Get the hand-in code</button>
        </>
      )}
      {prepared && (
        <div className="ups-code" style={{ border: `1px solid ${C.brand}`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12.5, color: C.soft }}>Hand-in code — put it in the transfer’s memo <small>ใส่รหัสนี้ในบันทึกช่วยจำของการโอน</small></div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <code className="ups-memo" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 20, fontWeight: 800, overflowWrap: "anywhere", userSelect: "all" }}>{v.memo}</code>
            <button type="button" className="ups-copy" onClick={() => void copy()} style={{ minHeight: 44, padding: "0 14px", borderRadius: 8, border: `1px solid ${C.brand}`, background: "#fff", color: C.brand, font: "inherit", fontWeight: 700, cursor: "pointer" }}>{copied ? "Copied" : "Copy"}</button>
          </div>
          <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: "4px 12px", fontSize: 13.5, fontVariantNumeric: "tabular-nums" }}>
            <dt style={{ color: C.soft }}>Job</dt><dd style={{ margin: 0, textAlign: "right", overflowWrap: "anywhere" }}>{v.jobRef ?? "—"}</dd>
            {v.coverage.filter((c) => c.status !== "REVERSED").map((c) => <Fragment key={c.saleNo}><dt style={{ color: C.soft, overflowWrap: "anywhere" }}>{c.saleNo} · {c.productName}</dt><dd style={{ margin: 0, textAlign: "right" }}>{baht(c.grossSatang)}</dd></Fragment>)}
            <dt style={{ fontWeight: 800 }}>To hand in</dt><dd style={{ margin: 0, textAlign: "right", fontWeight: 800 }}>{baht(v.toRemitSatang)}</dd>
          </dl>
          <small style={{ color: C.soft }}>The memo is not the bank reference: after the transfer, report the bank’s own transaction reference from the slip. One code for all the transfers of this job.</small>
        </div>
      )}
      {v.transfers.length > 0 && <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>{v.transfers.map(row)}</ul>}
      {editable && prepared && !v.receivingAccount && (
        <div className="ups-no-account" style={{ background: C.warnBg, border: `1px solid ${C.warnLine}`, borderRadius: 10, padding: "10px 12px", color: C.warnInk, fontSize: 13.5 }}>
          <b>Receiving account not set yet</b><br />An Admin has not chosen the account for Extras cash. Keep the cash and your slips; hand in once it is set. <b>Contact Admin.</b>
        </div>
      )}

      {editable && prepared && v.receivingAccount && (
        <>
          <p style={{ margin: 0, fontSize: 13.5 }}>Send to <b>{v.receivingAccount.label}</b> · {v.receivingAccount.display}. Amount to hand in: <b>{baht(v.toRemitSatang)}</b> — exactly, by one or more bank transfers.</p>
          {!adding ? (
            <button type="button" className="ups-add-transfer" onClick={() => setAdding(true)} style={btn(false)}>+ Add a transfer you made</button>
          ) : (
            <div className="ups-transfer-form" style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
              <label htmlFor="ups-t-amount" style={label}>Amount the bank sent (฿)</label>
              <input id="ups-t-amount" style={field} inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
              <span style={label}>When the bank sent it <small style={{ fontWeight: 500, color: C.soft }}>from the slip</small></span>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.3fr) minmax(0,1fr)", gap: 8 }}>
                <input aria-label="Transfer date" type="date" style={field} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
                <input aria-label="Transfer time" type="time" style={field} value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} />
              </div>
              <label htmlFor="ups-t-ref" style={label}>Bank reference</label>
              <input id="ups-t-ref" style={field} value={form.bankRef} onChange={(e) => setForm({ ...form, bankRef: e.target.value })} autoCapitalize="characters" />
              <label htmlFor="ups-t-slip" style={label}>Slip</label>
              <input id="ups-t-slip" type="file" accept="image/*,application/pdf" style={{ ...field, padding: 8 }} onChange={(e) => setForm({ ...form, file: e.target.files?.[0] ?? null })} />
              <small style={{ color: C.soft }}>A reported transfer is never edited — if it is wrong, take it out (with a reason) and add the right one.</small>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" onClick={() => { setAdding(false); setErr(""); }} style={{ ...btn(false), minHeight: 44 }}>Cancel</button>
                <button type="button" className="ups-save-transfer" disabled={busy || !form.amount || !form.bankRef.trim() || !form.file} onClick={() => void addTransfer()} style={{ ...btn(true), minHeight: 44 }}>{busy ? "Saving…" : "Save transfer"}</button>
              </div>
            </div>
          )}
          <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: "4px 12px", fontSize: 14, fontVariantNumeric: "tabular-nums" }}>
            <dt>Transfers</dt><dd className="ups-total-transfers" style={{ margin: 0, textAlign: "right", fontWeight: 800 }}>{baht(total)} of {baht(v.toRemitSatang)}</dd>
          </dl>
          {reported.length > 0 && !exact && <p style={{ margin: 0, fontSize: 13, color: C.warnInk }}>Only the exact amount is handed in. Cannot reach it? Contact Admin — the amount stays owed.</p>}
          {reported.length > 0 && (
            <button type="button" className="ups-send" disabled={busy || !exact} onClick={() => void send()} style={btn(true)}>{v.status === "RETURNED" ? `Send again (submission ${v.submissionNo + 1})` : "Send hand-in"}</button>
          )}
        </>
      )}
      {err && <div role="alert" className="ups-handin-error" style={{ background: C.badBg, border: `1px solid ${C.badLine}`, borderRadius: 10, padding: "8px 12px", color: C.badInk, fontSize: 13.5 }}>{err}</div>}
      {v.history.length > 0 && (
        <details style={{ fontSize: 13 }}>
          <summary style={{ minHeight: 44, display: "flex", alignItems: "center", fontWeight: 700, cursor: "pointer" }}>History</summary>
          <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
            {v.history.map((h) => <li key={h.submissionNo}>Sent {sent(h.submittedAt)} · {baht(h.totalSatang)} · {h.status === "RETURNED" ? `returned for checking: “${h.returnedReason}”` : h.status === "CONFIRMED" ? "confirmed" : "waiting for Admin"}</li>)}
          </ol>
        </details>
      )}
    </section>
  );
}
