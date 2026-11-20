"use client";

import { useCallback, useEffect, useState } from "react";

// The guest's page after scanning the guide's QR (mockup pr4q, approved with corrections). No
// account. Registration only — the seat is confirmed after the guide receives the cash; there is
// no "I paid" here. The request key is saved before sending, so a retry is the same registration.

type View =
  | { state: "OPEN"; tourName: string; date: string; time: string | null; unitPriceSatang: number; seatsLeft: number; maxGuests: number; productName: string }
  | { state: "CLOSED"; message: string };

export const G = { ink: "#18181B", soft: "#52525B", brand: "#0E3B2E", line: "#D4D4D8", warnBg: "#FBF4E4", warnLine: "#EADFC3", warnInk: "#5C3B06", okBg: "#EAF4EF", okLine: "#CBE5D6", okInk: "#0E5A33", badBg: "#FBEDEA", badLine: "#EFCFC7", badInk: "#8A2A1C" };
export const baht = (s: number) => `฿${(s / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
export const dateLabel = (d: string) => new Date(`${d}T12:00:00+07:00`).toLocaleDateString("en-GB", { timeZone: "Asia/Bangkok", weekday: "short", day: "numeric", month: "short" });
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);
export const page = { maxWidth: 480, margin: "0 auto", padding: "20px 16px 40px", display: "flex", flexDirection: "column", gap: 14, color: G.ink, fontSize: 16, lineHeight: 1.5 } as const;
export const primary = { minHeight: 52, width: "100%", borderRadius: 12, border: `1px solid ${G.brand}`, background: G.brand, color: "#fff", font: "inherit", fontSize: 17, fontWeight: 700, cursor: "pointer" } as const;
export const secondary = { ...primary, background: "#fff", color: G.brand, minHeight: 48, fontSize: 15 } as const;
export const box = (bg: string, line: string, ink: string) => ({ background: bg, border: `1px solid ${line}`, borderRadius: 12, padding: "12px 14px", color: ink }) as const;
export const Brand = ({ label }: { label: string }) => <div style={{ fontSize: 12, letterSpacing: "0.18em", textTransform: "uppercase", color: G.brand, fontWeight: 700 }}>Folkpaths · {label}</div>;

export default function GuestWalkIn({ token }: { token: string }) {
  const pendingKey = `walkin-pending:${token}`;
  const [v, setV] = useState<View | null | "missing">(null);
  const [guests, setGuests] = useState(1);
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const r = await fetch(`/api/public/walk-in/${encodeURIComponent(token)}`, { cache: "no-store" }).catch(() => null);
    if (!r) { setErr("No connection — try again."); return; }
    if (!r.ok) { setV("missing"); return; }
    setV(await r.json());
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  const submit = async () => {
    if (busy || !v || v === "missing" || v.state !== "OPEN") return;
    setBusy(true); setErr("");
    // Saved before it is sent: a lost answer is retried with the same key, never a second registration.
    let saved: { requestKey: string; guests: number } | null = null;
    try { saved = JSON.parse(window.localStorage.getItem(pendingKey) ?? "null"); } catch { /* private mode */ }
    const requestKey = saved && saved.guests === guests ? saved.requestKey : newKey();
    try { window.localStorage.setItem(pendingKey, JSON.stringify({ requestKey, guests })); } catch { /* the server key still guards */ }
    const r = await fetch(`/api/public/walk-in/${encodeURIComponent(token)}/register`, { method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
      body: JSON.stringify({ requestKey, guests, ...(name.trim() ? { leadName: name.trim() } : {}), ...(contact.trim() ? { contact: contact.trim() } : {}) }) }).catch(() => null);
    if (!r) { setBusy(false); setErr("No connection. Press Register again — it will not register you twice."); return; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setBusy(false); try { window.localStorage.removeItem(pendingKey); } catch { /* */ } setErr(j.message ?? "Could not register. Ask your guide."); void load(); return; }
    try { window.localStorage.removeItem(pendingKey); } catch { /* */ }
    // The status link carries its token in the fragment, which the browser never sends anywhere.
    window.location.assign(`/w/status#${j.viewToken}`);
  };

  if (v === null) return <main style={page}><Brand label="walk-in" /><p role="status">Loading…</p>{err && <p role="alert" style={box(G.badBg, G.badLine, G.badInk)}>{err}</p>}</main>;
  if (v === "missing") return <main style={page}><Brand label="walk-in" /><h1 style={{ margin: 0, fontSize: 22 }}>This link is not valid</h1><p>Ask your guide for the current QR.</p></main>;
  if (v.state === "CLOSED") return <main style={page} className="js-guest-closed"><Brand label="walk-in" /><h1 style={{ margin: 0, fontSize: 22 }}>Registration is closed</h1><p role="status" style={box(G.warnBg, G.warnLine, G.warnInk)}>{v.message}</p></main>;

  const max = v.maxGuests;
  const total = guests * v.unitPriceSatang;
  const label = { display: "block", fontWeight: 700, fontSize: 15, marginBottom: 6 } as const;
  const input = { width: "100%", minHeight: 48, boxSizing: "border-box", border: `1px solid ${G.line}`, borderRadius: 10, padding: "0 12px", font: "inherit", fontSize: 16, color: G.ink, background: "#fff" } as const;
  const stepBtn = { width: 52, height: 52, border: `1px solid ${G.line}`, borderRadius: 12, background: "#fff", fontSize: 24, fontWeight: 700, color: G.ink, cursor: "pointer" } as const;
  return (
    <main style={page} className="js-guest-walkin">
      <Brand label="walk-in" />
      <h1 style={{ margin: 0, fontSize: 22, lineHeight: 1.25 }}>Join today’s {v.tourName}</h1>
      <div style={{ color: G.soft }}>{dateLabel(v.date)}{v.time ? ` · ${v.time}` : ""} · with your guide, now</div>
      <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "max-content minmax(0,1fr)", gap: "6px 16px" }}>
        <dt style={{ color: G.soft }}>Price</dt><dd style={{ margin: 0, textAlign: "right" }}><b className="js-guest-price">{baht(v.unitPriceSatang)}</b> a guest — the total you pay</dd>
        <dt style={{ color: G.soft }}>Seats</dt><dd style={{ margin: 0, textAlign: "right" }} className="js-guest-seats">{v.seatsLeft} available now</dd>
      </dl>
      {max < 1 ? <p role="status" style={box(G.warnBg, G.warnLine, G.warnInk)}>The tour is full right now. Ask your guide.</p> : <>
        <div>
          <label htmlFor="g-guests" style={label}>Guests <small style={{ fontWeight: 500, color: G.soft }}>จำนวนผู้ร่วมทัวร์</small></label>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button type="button" aria-label="One guest fewer" disabled={guests <= 1} onClick={() => setGuests(guests - 1)} style={stepBtn}>−</button>
            <input id="g-guests" type="number" readOnly value={guests} aria-describedby="g-guests-hint" style={{ ...input, width: 80, textAlign: "center", fontSize: 22, fontWeight: 800 }} />
            <button type="button" aria-label="One guest more" disabled={guests >= max} onClick={() => setGuests(guests + 1)} style={stepBtn}>+</button>
          </div>
          <div id="g-guests-hint" style={{ fontSize: 13, color: G.soft, marginTop: 4 }}>Up to {max}</div>
        </div>
        <div>
          <label htmlFor="g-name" style={label}>Your name <small style={{ fontWeight: 500, color: G.soft }}>optional · for the guest list</small></label>
          <input id="g-name" value={name} maxLength={80} autoComplete="name" onChange={(e) => setName(e.target.value)} style={input} />
        </div>
        <div>
          <label htmlFor="g-contact" style={label}>Phone or email <small style={{ fontWeight: 500, color: G.soft }}>optional · only if you want the office to reach you</small></label>
          <input id="g-contact" value={contact} maxLength={120} autoComplete="tel" onChange={(e) => setContact(e.target.value)} style={input} />
        </div>
        <div style={{ ...box("#F4F4F5", "#E4E4E7", G.ink), display: "flex", justifyContent: "space-between", fontSize: 18, fontWeight: 800 }}><span>Pay your guide in cash</span><span className="js-guest-total">{baht(total)}</span></div>
        <p style={{ ...box(G.warnBg, G.warnLine, G.warnInk), margin: 0 }} className="js-guest-rule"><b>Registration only — your seat is confirmed after your guide receives the cash.</b> Show the next screen to your guide and pay {baht(total)} in cash.<br /><small>ลงทะเบียนเท่านั้น ที่นั่งยืนยันเมื่อไกด์ได้รับเงินสดแล้ว</small></p>
        <button type="button" className="js-guest-register" onClick={() => void submit()} disabled={busy} style={primary}>{busy ? "Registering…" : "Register"}</button>
      </>}
      {err && <p role="alert" className="js-guest-error" style={{ ...box(G.badBg, G.badLine, G.badInk), margin: 0 }}>{err}</p>}
      <p style={{ margin: 0, fontSize: 13, color: G.soft }}>No account needed. Your name and contact are used for this tour only and are seen only by your guide and the Folkpaths office.</p>
    </main>
  );
}
