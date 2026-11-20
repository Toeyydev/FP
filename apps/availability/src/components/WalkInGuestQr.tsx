"use client";

import { useCallback, useEffect, useState } from "react";

// The guide's guest QR for walk-in seats, on their own job (mockup pr4q): show / renew / stop the
// QR (drawn by the server, no outside service), copy or share its link, and the registrations
// waiting for cash. "Cash received" is the only thing that makes a sale; registering reserves
// nothing. Draws nothing while the QR switch is off (the API answers 404).

type Card = { open: true; url: string; svg: string; expiresAt: string; unitPriceSatang: number; seatsLeft: number; productName: string } | { open: false; reason: string; message: string };
type Reg = { id: string; reference: string; guests: number; totalSatang: number; unitPriceSatang: number; leadName: string | null; contact: string | null; createdAt: string; validUntil: string; state: "WAITING" | "PAID" | "REFUNDED" | "CANCELLED" | "ENDED"; endedBecause: string | null; saleNo: string | null };

const C = { ink: "#18181B", soft: "#52525B", brand: "#0E3B2E", line: "#E5E7EB", warnBg: "#FBF4E4", warnLine: "#EADFC3", warnInk: "#5C3B06", okBg: "#EAF4EF", okLine: "#CBE5D6", okInk: "#0E5A33", badBg: "#FBEDEA", badLine: "#EFCFC7", badInk: "#8A2A1C" };
const baht = (s: number) => `฿${(s / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" });
const btn = (primary: boolean) => ({ minHeight: 44, width: "100%", borderRadius: 10, border: `1px solid ${C.brand}`, background: primary ? C.brand : "#fff", color: primary ? "#fff" : C.brand, font: "inherit", fontSize: 15, fontWeight: 700, cursor: "pointer" }) as const;

async function call(url: string, init?: RequestInit) {
  const r = await fetch(url, { cache: "no-store", ...init }).catch(() => null);
  if (!r) throw new Error("No connection — try again");
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message ?? `Not done (${r.status})`), { status: r.status });
  return j;
}
const post = (url: string, body?: unknown) => call(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

export default function WalkInGuestQr({ jobSheetId, onSold }: { jobSheetId: string; onSold: () => void }) {
  const [card, setCard] = useState<Card | null | "off">(null);
  const [regs, setRegs] = useState<Reg[]>([]);
  const [show, setShow] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [c, r] = await Promise.all([call(`/api/upsell/walk-in/qr?jobSheetId=${encodeURIComponent(jobSheetId)}`), call(`/api/upsell/walk-in/registrations?jobSheetId=${encodeURIComponent(jobSheetId)}`)]);
      setCard(c); setRegs(r.rows);
    } catch (e) { if ((e as { status?: number }).status === 404 || (e as { status?: number }).status === 403) setCard("off"); }
  }, [jobSheetId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const t = window.setInterval(() => void load(), 10000); return () => window.clearInterval(t); }, [load]);

  const act = async (id: string, fn: () => Promise<unknown>, ok: string) => {
    if (busy) return;
    setBusy(id); setErr(""); setMsg("");
    try { await fn(); setMsg(ok); } catch (e) { setErr((e as Error).message); }
    setBusy(null); await load();
  };
  if (card === null || card === "off") return null;
  const waiting = regs.filter((r) => r.state === "WAITING");
  const done = regs.filter((r) => r.state !== "WAITING").slice(-6);

  return (
    <div className="js-walkin-qr" style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <b style={{ fontSize: 14 }}>Guest QR <small style={{ fontWeight: 500, color: C.soft }}>· guests register on their phone</small></b>
      {card.open ? <>
        {show ? <>
          <div className="js-qr-image" role="img" aria-label="QR code for guests to register" style={{ width: "min(240px, 100%)", margin: "0 auto", background: "#fff" }} dangerouslySetInnerHTML={{ __html: card.svg }} />
          <div style={{ textAlign: "center", fontSize: 13.5 }}><b>Guests scan to register for a walk-in seat</b><br /><span style={{ color: C.soft }}>{baht(card.unitPriceSatang)} a guest, paid to you in cash · {card.seatsLeft} seats left · until {hhmm(card.expiresAt)} or the end-tour report</span></div>
          <div className="js-qr-link" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, color: C.soft, overflowWrap: "anywhere", textAlign: "center" }}>{card.url}</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <button type="button" className="js-qr-copy" style={btn(false)} onClick={() => void navigator.clipboard?.writeText(card.url).then(() => setMsg("Link copied")).catch(() => setErr("Could not copy — long-press the link instead"))}>Copy link</button>
            <button type="button" className="js-qr-share" style={btn(false)} onClick={() => { if (navigator.share) void navigator.share({ title: "Folkpaths walk-in", url: card.url }).catch(() => {}); else void navigator.clipboard?.writeText(card.url).then(() => setMsg("Link copied")); }}>Share</button>
            <button type="button" className="js-qr-renew" style={btn(false)} disabled={!!busy} onClick={() => void act("renew", () => post("/api/upsell/walk-in/qr", { jobSheetId }), "New QR — the old one no longer works")}>New QR</button>
            <button type="button" className="js-qr-stop" style={btn(false)} disabled={!!busy} onClick={() => void act("stop", () => post("/api/upsell/walk-in/qr/stop", { jobSheetId }), "QR stopped — waiting registrations from it ended")}>Stop QR</button>
          </div>
        </> : <button type="button" className="js-qr-show" style={btn(true)} onClick={() => setShow(true)}>Show guest QR</button>}
      </> : <>
        <p className="js-qr-closed" style={{ margin: 0, fontSize: 13.5, color: C.soft }}>{card.message}</p>
        {card.reason !== "REPORT_SENT" && card.reason !== "NOT_TODAY" && card.reason !== "JOB_CANCELLED" && card.reason !== "NOT_ON_SALE" &&
          <button type="button" className="js-qr-open" style={btn(true)} disabled={!!busy} onClick={() => void act("open", async () => { await post("/api/upsell/walk-in/qr", { jobSheetId }); setShow(true); }, "Guest QR ready")}>{card.reason === "NO_QR" ? "Make a guest QR" : "Make a new guest QR"}</button>}
      </>}
      <p style={{ margin: 0, fontSize: 12.5, color: C.warnInk, background: C.warnBg, border: `1px solid ${C.warnLine}`, borderRadius: 8, padding: "8px 10px" }}>Registering does not book a seat. Only “Cash received” records the sale — after you have the cash in hand.</p>
      {waiting.length > 0 && <ul className="js-qr-waiting" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {waiting.map((r) => (
          <li key={r.id} className="js-qr-reg" style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}><b style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{r.reference}</b><b>{r.guests} {r.guests === 1 ? "guest" : "guests"} · {baht(r.totalSatang)}</b></div>
            <div style={{ fontSize: 13, color: C.soft, overflowWrap: "anywhere" }}>{r.leadName ?? "No name"}{r.contact ? ` · ${r.contact}` : ""} · registered {hhmm(r.createdAt)} · valid until {hhmm(r.validUntil)}</div>
            <button type="button" className="js-qr-cash" style={btn(true)} disabled={!!busy} onClick={() => void act(r.id, async () => { await post(`/api/upsell/walk-in/registrations/${r.id}/confirm`); onSold(); }, `${r.reference}: ${baht(r.totalSatang)} cash recorded — the guests are on this job`)}>Cash received — {baht(r.totalSatang)}</button>
            <button type="button" className="js-qr-decline" style={btn(false)} disabled={!!busy} onClick={() => void act(r.id, () => post(`/api/upsell/walk-in/registrations/${r.id}/decline`), `${r.reference} ended — not going ahead`)}>Not coming</button>
          </li>
        ))}
      </ul>}
      {done.length > 0 && <ul style={{ listStyle: "none", margin: 0, padding: 0, fontSize: 12.5, color: C.soft, display: "flex", flexDirection: "column", gap: 2 }}>
        {done.map((r) => <li key={r.id}>{r.reference} · {r.guests} · {r.state === "PAID" ? `paid · ${r.saleNo}` : r.state === "REFUNDED" ? `refunded · ${r.saleNo}` : r.state === "CANCELLED" ? `sale cancelled · ${r.saleNo}` : `ended — ${r.endedBecause ?? ""}`}</li>)}
      </ul>}
      {msg && <p role="status" style={{ margin: 0, fontSize: 13.5, color: C.okInk, background: C.okBg, border: `1px solid ${C.okLine}`, borderRadius: 8, padding: "8px 10px" }}>{msg}</p>}
      {err && <p role="alert" className="js-qr-error" style={{ margin: 0, fontSize: 13.5, color: C.badInk, background: C.badBg, border: `1px solid ${C.badLine}`, borderRadius: 8, padding: "8px 10px" }}>{err}</p>}
    </div>
  );
}
