"use client";

import { Fragment, useCallback, useEffect, useState } from "react";

// The guide hands in the Extras cash of one job — slips only (owner, 20 Nov 2026: "ให้อัพโหลดสลิป
// อย่างเดียวก็พอแล้ว"): get the code (the transfer's memo), transfer the amount owed to the account
// shown, upload the slip(s), Send. The guide never types an amount, a time or a reference — an Admin
// reads them off the slip and the statement. Returned = the slips stay; add or take out a wrong one,
// never transfer again. Transfers reported the earlier way stay readable. Everything shown comes
// from the server (lib/upsell/settlement).

type Transfer = { id: string; seq: number; amountSatang: number; transferredAt: string; transferDate: string; bankRef: string; hasSlip: boolean; toAccount: string; status: string; withdrawnReason: string | null };
type Slip = { id: string; seq: number; status: string; uploadedAt: string; url: string | null; removedReason: string | null; toAccount: string; confirmed: boolean };
type View = {
  heldSatang: number; toRemitSatang: number; status: string; settlementNo: string | null; submissionNo: number; returnedReason: string | null;
  memo: string | null; jobRef: string | null; coverage: { saleNo: string; productName: string; guests: number; grossSatang: number; heldSatang: number; status: string; reversal: string | null }[];
  receivingAccount: { id: string; version: number; label: string; display: string } | null;
  transfers: Transfer[];
  slips: Slip[];
  history: { submissionNo: number; kind: string; expectedSatang: number; totalSatang: number; transferIds: string[]; slipIds: string[]; status: string; submittedAt: string; returnedReason: string | null; returnedAt: string | null; confirmedAt: string | null }[];
};

const C = { ink: "#18181B", soft: "#71717A", brand: "#0E3B2E", line: "#E5E7EB", warnBg: "#FBF4E4", warnLine: "#EADFC3", warnInk: "#5C3B06", okBg: "#EAF4EF", okLine: "#CBE5D6", okInk: "#0E5A33", badBg: "#FBEDEA", badLine: "#EFCFC7", badInk: "#8A2A1C" };
const baht = (s: number) => `฿${(s / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const sent = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const btn = (primary: boolean) => ({ minHeight: 48, width: "100%", borderRadius: 10, border: `1px solid ${C.brand}`, background: primary ? C.brand : "#fff", color: primary ? "#fff" : C.brand, font: "inherit", fontSize: 15, fontWeight: 700, cursor: "pointer" }) as const;
const field = { boxSizing: "border-box", width: "100%", minHeight: 44, border: "1px solid #A1A1AA", borderRadius: 8, padding: "8px 10px", font: "inherit", fontSize: 15, background: "#fff", color: C.ink } as const;
const label = { fontWeight: 700, fontSize: 14 } as const;

async function call(url: string, init?: RequestInit) {
  const r = await fetch(url, init);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d.reasons ?? [d.error ?? `HTTP ${r.status}`]).join(" "));
  return d;
}

export default function UpsellHandIn({ jobSheetId }: { jobSheetId: string }) {
  const [v, setV] = useState<View | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [takeOut, setTakeOut] = useState<{ id: string; reason: string } | null>(null);
  const [fileKey, setFileKey] = useState(0);

  const load = useCallback(async () => {
    try { setV(await call(`/api/upsell/hand-in/${jobSheetId}`, { cache: "no-store" })); } catch { /* the block above still shows the cash */ }
  }, [jobSheetId]);
  useEffect(() => { void load(); }, [load]);
  if (!v || (v.heldSatang === 0 && v.status === "NOT_SENT" && v.transfers.length === 0 && v.slips.length === 0)) return null;

  const editable = v.status === "NOT_SENT" || v.status === "DRAFT" || v.status === "RETURNED";
  const prepared = !!v.memo;
  const active = v.slips.filter((x) => x.status === "ACTIVE");
  const legacy = v.transfers.filter((t) => t.status === "REPORTED");

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr("");
    try { await fn(); await load(); } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };
  // The hand-in code comes first: the guide puts it in the transfer's memo (owner, 20 Nov 2026).
  const prepare = () => run(() => call(`/api/upsell/hand-in/${jobSheetId}/prepare`, { method: "POST" }));
  const upload = (files: FileList | null) => run(async () => {
    for (const f of Array.from(files ?? [])) { const fd = new FormData(); fd.append("file", f); await call(`/api/upsell/hand-in/${jobSheetId}/slip`, { method: "POST", body: fd }); }
    setFileKey((k) => k + 1);
  });
  const remove = () => takeOut && run(async () => {
    await call(`/api/upsell/hand-in/slips/${takeOut.id}/remove`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: takeOut.reason }) });
    setTakeOut(null);
  });
  const send = () => run(() => call(`/api/upsell/hand-in/${jobSheetId}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slipIds: active.map((x) => x.id) }) }));
  const sendLegacy = () => run(() => call(`/api/upsell/hand-in/${jobSheetId}/submit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transferIds: legacy.map((t) => t.id) }) }));
  const copy = async () => {
    try { await navigator.clipboard.writeText(v.memo ?? ""); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* select the text by hand */ }
  };

  const slipRow = (x: Slip) => {
    const out = x.status === "REMOVED", ok = x.confirmed;
    const tone = out ? { background: "#F4F4F5", border: `1px solid ${C.line}`, color: C.soft } : ok ? { background: C.okBg, border: `1px solid ${C.okLine}`, color: C.okInk } : { background: "#fff", border: `1px solid ${C.line}`, color: C.ink };
    return (
      <li key={x.id} className="ups-slip" style={{ ...tone, borderRadius: 10, padding: "10px 12px", fontSize: 13.5, lineHeight: 1.5, overflowWrap: "anywhere" }}>
        <b>{ok ? "✓ " : ""}Slip {x.seq}</b> · uploaded {sent(x.uploadedAt)}{x.url ? <> · <a href={x.url} target="_blank" rel="noreferrer">view</a></> : null}
        {out && <><br /><small>Taken out: “{x.removedReason}”. It stays in the history.</small></>}
        {!out && !ok && v.status === "RETURNED" && <><br /><small><b>Kept for the next send — do not transfer again.</b></small></>}
        {!out && !ok && editable && takeOut?.id !== x.id && (
          <div><button type="button" className="ups-takeout" onClick={() => setTakeOut({ id: x.id, reason: "" })} style={{ marginTop: 6, minHeight: 40, padding: "0 12px", borderRadius: 8, border: `1px solid ${C.badInk}`, background: "#fff", color: C.badInk, font: "inherit", fontWeight: 700, cursor: "pointer" }}>Wrong slip — take out…</button></div>
        )}
        {takeOut?.id === x.id && (
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            <label htmlFor={`ups-out-${x.id}`} style={label}>Why take it out?</label>
            <input id={`ups-out-${x.id}`} style={field} value={takeOut.reason} onChange={(e) => setTakeOut({ id: x.id, reason: e.target.value })} placeholder="e.g. a slip from another job" />
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={() => setTakeOut(null)} style={{ ...btn(false), minHeight: 44 }}>Keep it</button>
              <button type="button" disabled={busy || takeOut.reason.trim().length < 5} onClick={() => void remove()} style={{ ...btn(true), minHeight: 44, background: C.badInk, borderColor: C.badInk }}>Take out</button>
            </div>
          </div>
        )}
      </li>
    );
  };
  const transferRow = (t: Transfer) => (
    <li key={t.id} className="ups-transfer" style={{ background: t.status === "CONFIRMED" ? C.okBg : "#F4F4F5", border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 12px", fontSize: 13.5, lineHeight: 1.5, overflowWrap: "anywhere" }}>
      <b>{t.status === "CONFIRMED" ? "✓ " : ""}Transfer {t.seq}</b> · {baht(t.amountSatang)} · {sent(t.transferredAt)} · ref {t.bankRef} · to {t.toAccount}{t.status === "WITHDRAWN" ? ` · taken out: “${t.withdrawnReason}”` : ""}
    </li>
  );

  return (
    <section className="js-handin" aria-labelledby="handin-h" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <h4 id="handin-h" style={{ margin: 0, fontSize: 15 }}>Hand in the Extras cash <small style={{ fontWeight: 500, color: C.soft }}>นำส่งเงินขายเพิ่ม</small></h4>
      {v.status === "RETURNED" && (
        <div role="alert" className="ups-returned" style={{ background: C.badBg, border: `1px solid ${C.badLine}`, borderRadius: 10, padding: "10px 12px", color: C.badInk }}>
          <b>Returned for checking · {v.settlementNo} · submission {v.submissionNo}</b><br />
          <span style={{ fontSize: 13 }}>Admin: “{v.returnedReason}”. Your slips stay here — <b>do not transfer again</b>. Add a missing slip or take out a wrong one, then send again.</span>
        </div>
      )}
      {v.status === "SUBMITTED" && <div role="status" className="ups-sent" style={{ background: C.warnBg, border: `1px solid ${C.warnLine}`, borderRadius: 10, padding: "10px 12px", color: C.warnInk, fontSize: 13.5 }}><b>ส่งแล้ว รอตรวจสอบ</b> · Sent — Admin is checking · {v.settlementNo}<br />Cash held stays {baht(v.heldSatang)} until Admin confirms it against the bank.</div>}
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
            {v.coverage.map((c) => <Fragment key={c.saleNo}><dt style={{ color: C.soft, overflowWrap: "anywhere" }}>{c.saleNo} · {c.productName}{c.reversal === "REFUNDED_BY_COMPANY" ? ` · refunded by the company (sale ${baht(c.grossSatang)}) — the cash is still yours to hand in` : ""}</dt><dd style={{ margin: 0, textAlign: "right" }}>{baht(c.heldSatang)}</dd></Fragment>)}
            <dt style={{ fontWeight: 800 }}>To hand in</dt><dd className="ups-owed" style={{ margin: 0, textAlign: "right", fontWeight: 800 }}>{baht(v.toRemitSatang)}</dd>
            {v.receivingAccount && <><dt style={{ color: C.soft }}>Transfer to</dt><dd className="ups-account" style={{ margin: 0, textAlign: "right", overflowWrap: "anywhere" }}>{v.receivingAccount.label} · {v.receivingAccount.display}</dd></>}
          </dl>
        </div>
      )}
      {editable && prepared && !v.receivingAccount && (
        <div className="ups-no-account" style={{ background: C.warnBg, border: `1px solid ${C.warnLine}`, borderRadius: 10, padding: "10px 12px", color: C.warnInk, fontSize: 13.5 }}>
          <b>Receiving account not set yet</b><br />An Admin has not chosen the account for Extras cash. Keep the cash; hand in once it is set. <b>Contact Admin.</b>
        </div>
      )}
      {v.transfers.length > 0 && <ul aria-label="Transfers reported earlier" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>{v.transfers.map(transferRow)}</ul>}
      {v.slips.length > 0 && <ul aria-label="Your slips" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>{v.slips.map(slipRow)}</ul>}

      {editable && prepared && v.receivingAccount && legacy.length === 0 && (
        <>
          <label className="ups-upload" style={{ ...btn(active.length === 0), display: "flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box", opacity: busy ? 0.6 : 1 }}>
            {busy ? "Uploading…" : active.length ? "+ Add another slip" : "Upload the bank slip"}
            <input key={fileKey} type="file" accept="image/*,application/pdf" multiple disabled={busy} onChange={(e) => void upload(e.target.files)} style={{ position: "absolute", width: 1, height: 1, opacity: 0 }} />
          </label>
          <small style={{ color: C.soft }}>Upload every slip of this hand-in (one per transfer). Admin reads the amount, time and reference from the slip — nothing to type.</small>
          {active.length > 0 && <button type="button" className="ups-send" disabled={busy} onClick={() => void send()} style={btn(true)}>{v.status === "RETURNED" ? `Send again · ${active.length} slip${active.length > 1 ? "s" : ""}` : `Send · ${active.length} slip${active.length > 1 ? "s" : ""}`}</button>}
        </>
      )}
      {editable && legacy.length > 0 && v.slips.length === 0 && (
        <button type="button" className="ups-send-legacy" disabled={busy} onClick={() => void sendLegacy()} style={btn(true)}>Send the transfers reported earlier</button>
      )}
      {err && <div role="alert" className="ups-handin-error" style={{ background: C.badBg, border: `1px solid ${C.badLine}`, borderRadius: 10, padding: "8px 12px", color: C.badInk, fontSize: 13.5 }}>{err}</div>}
      {v.history.length > 0 && (
        <details style={{ fontSize: 13 }}>
          <summary style={{ minHeight: 44, display: "flex", alignItems: "center", fontWeight: 700, cursor: "pointer" }}>History</summary>
          <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
            {v.history.map((h) => <li key={h.submissionNo}>Sent {sent(h.submittedAt)} · {h.kind === "SLIPS" ? `${h.slipIds.length} slip${h.slipIds.length > 1 ? "s" : ""} for ${baht(h.expectedSatang)}` : baht(h.totalSatang)} · {h.status === "RETURNED" ? `returned for checking: “${h.returnedReason}”` : h.status === "CONFIRMED" ? "confirmed" : "waiting for Admin"}</li>)}
          </ol>
        </details>
      )}
    </section>
  );
}
