"use client";

import { useCallback, useEffect, useState } from "react";
import { Brand, G, baht, box, dateLabel, page, secondary } from "./GuestWalkIn";

// The guest's own registration, read with the token in this page's URL fragment (never sent to
// any server as part of a URL, never in a referrer). WAITING until the guide records the cash;
// PAID only once the server holds the sale; the official receipt is described as PEAK's status.

type Status = {
  reference: string; guests: number; totalSatang: number; unitPriceSatang: number; tourName: string; date: string; time: string | null;
  state: "WAITING" | "PAID" | "ENDED"; endedBecause: string | null; validUntil: string;
  sale: { saleNo: string; jobRef: string | null; receipt: { state: "SYNCED" | "QUEUED" | "WAITING" | "CHECKING" | "NONE"; peakCode: string | null } } | null;
};
const RECEIPT: Record<string, string> = {
  SYNCED: "Official receipt issued by Folkpaths", QUEUED: "Official receipt: being issued by Folkpaths",
  WAITING: "Official receipt: Folkpaths issues it once its office set-up is complete", CHECKING: "Official receipt: being checked by the Folkpaths office", NONE: "No official receipt for this registration",
};
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" });
const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", overflowWrap: "anywhere" } as const;

export default function GuestWalkInStatus() {
  const [token, setToken] = useState<string | null>(null);
  const [s, setS] = useState<Status | null | "missing">(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { setToken(window.location.hash.replace(/^#/, "")); }, []);
  const load = useCallback(async () => {
    if (!token) return;
    const r = await fetch("/api/public/walk-in/registration", { method: "POST", headers: { "content-type": "application/json" }, cache: "no-store", body: JSON.stringify({ viewToken: token }) }).catch(() => null);
    if (!r) { setErr("No connection — this page tries again."); return; }
    setErr("");
    if (!r.ok) { setS("missing"); return; }
    setS(await r.json());
  }, [token]);
  useEffect(() => { if (token !== null) void load(); }, [token, load]);
  // While waiting for the guide, look again now and then.
  useEffect(() => {
    if (!s || s === "missing" || s.state !== "WAITING") return;
    const t = window.setInterval(() => void load(), 8000);
    return () => window.clearInterval(t);
  }, [s, load]);

  const cancel = async () => {
    if (!token || busy) return;
    setBusy(true);
    const r = await fetch("/api/public/walk-in/registration/cancel", { method: "POST", headers: { "content-type": "application/json" }, cache: "no-store", body: JSON.stringify({ viewToken: token }) }).catch(() => null);
    setBusy(false);
    if (!r || !r.ok) { const j = await r?.json().catch(() => ({})); setErr(j?.message ?? "Could not cancel — ask your guide."); }
    await load();
  };

  if (token === "" || s === "missing") return <main style={page}><Brand label="registration" /><h1 style={{ margin: 0, fontSize: 22 }}>Registration not found</h1><p>Open the link you got when you registered, or ask your guide.</p></main>;
  if (!s) return <main style={page}><Brand label="registration" /><p role="status">Loading…</p>{err && <p role="alert" style={box(G.badBg, G.badLine, G.badInk)}>{err}</p>}</main>;

  const rows = (
    <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "max-content minmax(0,1fr)", gap: "8px 16px" }}>
      <dt style={{ color: G.soft }}>{s.state === "PAID" ? "Sale Ref" : "Registration"}</dt><dd className="js-guest-ref" style={{ margin: 0, textAlign: "right", ...mono, fontWeight: 700 }}>{s.sale?.saleNo ?? s.reference}</dd>
      {s.sale?.jobRef && <><dt style={{ color: G.soft }}>Job Ref</dt><dd style={{ margin: 0, textAlign: "right", ...mono }}>{s.sale.jobRef}</dd></>}
      <dt style={{ color: G.soft }}>Tour</dt><dd style={{ margin: 0, textAlign: "right" }}>{s.tourName} · {dateLabel(s.date)}{s.time ? ` · ${s.time}` : ""}</dd>
      <dt style={{ color: G.soft }}>Guests</dt><dd style={{ margin: 0, textAlign: "right" }}>{s.guests} × {baht(s.unitPriceSatang)}</dd>
      <dt style={{ color: G.soft }}>{s.state === "PAID" ? "Paid in cash" : "To pay your guide in cash"}</dt><dd style={{ margin: 0, textAlign: "right", fontWeight: 800, fontSize: 18 }}>{baht(s.totalSatang)}</dd>
    </dl>
  );
  return (
    <main style={page} className={`js-guest-status js-guest-${s.state.toLowerCase()}`}>
      <Brand label={s.state === "PAID" ? "payment acknowledgement" : "registration"} />
      {s.state === "WAITING" && <div role="status" style={box(G.warnBg, G.warnLine, G.warnInk)}><b>Waiting for your guide — not paid, no seat yet.</b><br />Show this screen to your guide and pay {baht(s.totalSatang)} in cash. Valid until {time(s.validUntil)}.<br /><small>รอไกด์ยืนยันการรับเงินสด ยังไม่ได้ชำระและยังไม่มีที่นั่ง</small></div>}
      {s.state === "PAID" && <div role="status" style={box(G.okBg, G.okLine, G.okInk)}><b>Paid · you’re on the tour</b><br /><small>ชำระแล้ว · ร่วมทัวร์ได้</small></div>}
      {s.state === "ENDED" && <div role="status" style={box(G.badBg, G.badLine, G.badInk)}><b>This registration has ended — not paid.</b><br />{s.endedBecause ?? "Ask your guide."}</div>}
      {rows}
      {s.state === "PAID" && s.sale && <p className="js-guest-receipt" style={{ margin: 0, fontSize: 14, color: G.soft }}>{RECEIPT[s.sale.receipt.state]}{s.sale.receipt.peakCode ? ` · ${s.sale.receipt.peakCode}` : ""}. This page acknowledges the cash you paid; it is not the official receipt. No tax invoice — Folkpaths is not VAT-registered.</p>}
      {s.state === "WAITING" && <>
        <p style={{ margin: 0, fontSize: 14, color: G.soft }}>This page updates by itself when your guide records the cash. Keep it open or bookmark it.</p>
        <button type="button" className="js-guest-cancel" disabled={busy} onClick={() => void cancel()} style={secondary}>Cancel my registration</button>
      </>}
      {err && <p role="alert" style={{ ...box(G.badBg, G.badLine, G.badInk), margin: 0 }}>{err}</p>}
    </main>
  );
}
