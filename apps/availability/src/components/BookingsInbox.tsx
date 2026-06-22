"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import { SLOTS } from "@/lib/slots";
import { isOnline } from "@/lib/presence";
import { DOW, MON, parseYMD } from "@/lib/dates";
import BookingsTable from "@/components/BookingsTable";

type Booking = {
  id: string; source: string; confirmationCode: string | null; externalRef: string | null; productName: string | null;
  tourId: string | null; date: string | null; startTime: string | null; slotIdx: number | null;
  pax: number | null; customerName: string | null; status: string;
  guideId?: string | null; guide?: string | null;
};
type Tour = { id: string; name: string; time: string };

async function post(body: unknown) {
  const r = await fetch("/api/bookings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
}

export default function BookingsInbox() {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [tours, setTours] = useState<Tour[]>([]);
  const [msg, setMsg] = useState("");
  const [importing, setImporting] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [dur, setDur] = useState<Record<string, string>>({});
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [tab, setTab] = useState<"inbox" | "all">("inbox");
  const [monthFilter, setMonthFilter] = useState(""); // YYYY-MM filter for the inbox
  const [guides, setGuides] = useState<{ guideId: string; displayName: string; rating: number | null; online: boolean; languages: string }[]>([]);
  const [grpGuide, setGrpGuide] = useState<Record<string, string>>({});
  const [availMap, setAvailMap] = useState<Record<string, string[]>>({}); // "date|slot" -> available guideIds
  const [openDates, setOpenDates] = useState<Record<string, boolean>>({});
  // Load the enriched guide list (rating + presence) and rank best-match first:
  // online before offline, then higher rating, then more tours.
  useEffect(() => {
    fetch("/api/guides", { cache: "no-store" }).then((r) => r.json()).then((d) => {
      const rows = (d.rows ?? []) as { guideId: string; name: string; rating: number | null; lastSeenAt: string | null; languages: string | string[] }[];
      const list = rows.map((g) => ({ guideId: g.guideId, displayName: g.name, rating: g.rating, online: isOnline(g.lastSeenAt), languages: Array.isArray(g.languages) ? g.languages.join(", ") : (g.languages ?? "") }));
      list.sort((a, b) => Number(b.online) - Number(a.online) || (b.rating ?? -1) - (a.rating ?? -1));
      setGuides(list);
    }).catch(() => {});
  }, []);

  const jsRef = useRef<HTMLInputElement>(null);
  // Import filled FOLKPATHS job-sheet .xlsx files (non-Bokun tours) — each becomes
  // a booking + assignment + job sheet. Supports selecting many at once.
  async function archiveStale() {
    if (!confirm("Archive all PAST unassigned bookings?\n\nThese are already-passed tours that were never assigned to a guide. They'll be hidden from the inbox and Reports. Upcoming and dispatched bookings are NOT touched.")) return;
    setMsg("Archiving past unassigned bookings…");
    const r = await fetch("/api/bookings/archive-stale", { method: "POST" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setMsg("Archive failed."); return; }
    setMsg(d.count ? `Archived ${d.count} past unassigned booking${d.count === 1 ? "" : "s"}.` : "Nothing to archive — no past unassigned bookings.");
    await load();
  }
  async function importJobSheets(files: FileList) {
    setImporting(true);
    setMsg(`Importing ${files.length} job sheet${files.length === 1 ? "" : "s"}…`);
    try {
      const fd = new FormData();
      for (const f of Array.from(files)) fd.append("file", f);
      const r = await fetch("/api/jobsheet/import", { method: "POST", body: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg(d.hint || d.detail || `Import failed (${r.status}).`); return; }
      const lines = (d.results || []).map((x: { ok: boolean; file: string; detail: string }) => `${x.ok ? "✓" : "✗"} ${x.detail}`);
      setMsg(`Job sheets: ${d.imported} imported${d.failed ? `, ${d.failed} failed` : ""}. ` + lines.join(" | "));
      await load();
    } catch { setMsg("Job-sheet import failed — network error."); }
    finally { setImporting(false); }
  }

  // Live-sync status: has Bokun's webhook fired recently? (PII-free health probe.)
  const [wh, setWh] = useState<{ lastWebhookAt: string | null; webhookEvents7d: number } | null>(null);
  useEffect(() => {
    fetch("/api/bokun/health", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((d) => d && setWh({ lastWebhookAt: d.lastWebhookAt ?? null, webhookEvents7d: d.webhookEvents7d ?? 0 })).catch(() => {});
  }, []);

  const [syncing, setSyncing] = useState(false);
  // Pull historical bookings from Bokun into the inbox (one-off backfill).
  async function syncBokun() {
    setSyncing(true); setMsg("Syncing from Bokun…");
    try {
      const r = await fetch("/api/bokun/sync", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) setMsg(d.error === "not-configured" ? "Bokun API keys not set on the server yet." : `Sync failed (${d.status ?? r.status}). ${d.detail ?? ""}`.slice(0, 160));
      else { setMsg(`Synced: ${d.created} new, ${d.updated} updated, ${d.skipped} skipped (${d.fetched} checked).`); await load(); }
    } catch { setMsg("Sync failed — network error."); }
    setSyncing(false);
  }

  // Over-capacity split editor: assign each booking to a guide, ≤10 pax per guide.
  const [splitFor, setSplitFor] = useState<{ date: string; slotIdx: number; tourId: string; items: Booking[] } | null>(null);
  const [splitMap, setSplitMap] = useState<Record<string, string>>({});
  function openSplit(items: Booking[]) {
    setSplitFor({ date: items[0].date!, slotIdx: items[0].slotIdx!, tourId: groupTourId(items), items });
    setSplitMap({});
  }
  const splitPax = (guideId: string) => splitFor ? splitFor.items.filter((b) => splitMap[b.id] === guideId).reduce((s, b) => s + (b.pax ?? 0), 0) : 0;
  async function submitSplit() {
    if (!splitFor) return;
    const unassigned = splitFor.items.filter((b) => !splitMap[b.id]);
    if (unassigned.length) { setMsg("Assign every booking to a guide first."); return; }
    const byGuide: Record<string, string[]> = {};
    for (const b of splitFor.items) (byGuide[splitMap[b.id]] ??= []).push(b.id);
    const groups = Object.entries(byGuide).map(([guideId, bookingIds]) => ({ guideId, bookingIds }));
    const r = await fetch("/api/bookings/split", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ date: splitFor.date, slotIdx: splitFor.slotIdx, tourId: splitFor.tourId, groups }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setMsg(d.error === "over-cap" ? `A group exceeds 10 pax — rebalance.` : "Split failed."); return; }
    setSplitFor(null); setMsg(`✅ Split into ${d.groups} guide job(s).`); await load();
  }

  // Delete a whole incoming job (all its bookings) in one action.
  async function deleteGroup(items: Booking[]) {
    if (!confirm(`Delete this job and its ${items.length} booking(s)? This permanently removes them and cannot be undone.`)) return;
    const r = await post({ action: "delete", ids: items.map((b) => b.id) });
    if (r.ok) { setMsg(`Deleted ${items.length} booking(s).`); await load(); }
    else setMsg("Delete failed.");
  }

  // Send a group to a chosen guide as a 2-hour job offer. They must accept; if
  // they don't, it returns to the operator to reassign (no instant booking).
  async function assignGroup(key: string, items: Booking[], guideId: string) {
    const date = items[0].date!; const slotIdx = items[0].slotIdx!; const tourId = groupTourId(items);
    const pax = items.reduce((s, b) => s + (b.pax ?? 0), 0) || undefined;
    if ((pax ?? 0) > 10 && !confirm(`${pax} pax is over the 10-pax cap.\nAssign all of them to ${guideId} anyway?`)) return;
    const note = `${items.length} booking(s): ${items.map((b) => b.externalRef || b.confirmationCode || b.customerName || "—").join(", ")}`.slice(0, 280);
    const r = await fetch("/api/assignments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId, date, slotIdx, tourId, pax: pax && pax <= 50 ? pax : undefined, note }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setMsg(d.error === "date-blocked" ? "That day is blocked." : d.error === "guide-unavailable" ? "That guide can't take this slot." : "Assign failed."); return; }
    await post({ action: "markOffered", ids: items.map((b) => b.id) });
    setMsg(`📨 Sent to ${guideId} — awaiting acceptance (2h).`);
    await load();
  }

  async function openDetail(id: string) {
    const r = await fetch(`/api/bookings?id=${id}`, { cache: "no-store" });
    if (r.ok) setDetail((await r.json()).booking);
  }
  const setField = (k: string, v: unknown) => setDetail((p) => (p ? { ...p, [k]: v } : p));
  const str = (v: unknown) => (v == null ? "" : String(v));
  async function saveDetail() {
    if (!detail) return;
    const d = detail;
    const r = await post({
      action: "update", id: d.id, status: d.status, paymentStatus: d.paymentStatus,
      confirmationCode: str(d.confirmationCode) || undefined, customerName: str(d.customerName) || undefined,
      nationality: str(d.nationality) || undefined, email: str(d.email) || undefined, phone: str(d.phone) || undefined,
      specialRequests: str(d.specialRequests) || undefined, notes: str(d.notes) || undefined,
      tourId: str(d.tourId) || undefined, date: str(d.date) || undefined,
      slotIdx: d.slotIdx != null ? Number(d.slotIdx) : undefined, pax: d.pax != null && d.pax !== "" ? Number(d.pax) : undefined,
    });
    if (r.ok) { setDetail(null); await load(); }
  }
  // Delete a booking — confirm twice before it's gone for good.
  async function removeBooking(id: string, label: string) {
    if (!confirm(`Delete this booking?\n${label}`)) return;
    if (!confirm("Are you sure? This permanently removes it and cannot be undone.")) return;
    await post({ action: "delete", id });
    setDetail(null);
    await load();
  }
  // manual-add form
  const [m, setM] = useState({ tourId: "", date: "", slotIdx: 0, pax: "", confirmationCode: "", customerName: "", source: "direct",
    nationality: "", email: "", phone: "", specialRequests: "", notes: "", bookingDate: "", paymentStatus: "unpaid" });

  const load = useCallback(async () => {
    const r = await fetch("/api/bookings", { cache: "no-store" });
    if (!r.ok) { setMsg("Operator only."); return; }
    const d = await r.json();
    setBookings(d.bookings); setTours(d.tours);
    if (!m.tourId && d.tours[0]) setM((x) => ({ ...x, tourId: d.tours[0].id }));
  }, [m.tourId]);
  useEffect(() => { load(); }, [load]);

  // For each unassigned slot in the inbox, fetch who is actually free — so the
  // per-group picker can hide guides who blocked that slot (or are on leave/taken).
  useEffect(() => {
    const open = bookings.filter((b) => b.status !== "OFFERED" && b.tourId && b.slotIdx != null && b.date && !b.guideId);
    const slots = [...new Map(open.map((b) => [`${b.date}|${b.slotIdx}`, { date: b.date!, slotIdx: b.slotIdx! }])).values()];
    if (!slots.length) { setAvailMap({}); return; }
    fetch("/api/offers/candidates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slots }) })
      .then((r) => (r.ok ? r.json() : { map: {} }))
      .then((d) => setAvailMap(d.map ?? {}))
      .catch(() => {});
  }, [bookings]);

  const tourName = (id: string | null) => tours.find((t) => t.id === id)?.name ?? id ?? "—";
  // The tour for a slot-group: the most common tourId among its bookings.
  const groupTourId = (items: Booking[]) => {
    const c: Record<string, number> = {};
    for (const b of items) if (b.tourId) c[b.tourId] = (c[b.tourId] || 0) + 1;
    return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] ?? items[0]?.tourId ?? "";
  };
  const needMap = bookings.filter((b) => b.status !== "OFFERED" && (!b.tourId || b.slotIdx == null || !b.date));
  const ready = bookings.filter((b) => b.status !== "OFFERED" && b.tourId && b.slotIdx != null && b.date);

  // Group ready bookings by date + slot ONLY — everything at the same time slot is
  // ONE job for one guide (regardless of tour/channel).
  const groups: Record<string, Booking[]> = {};
  for (const b of ready) { const k = `${b.date}|${b.slotIdx}`; (groups[k] ??= []).push(b); }

  // Modern inbox: group the slot-jobs by DATE so the operator sees one collapsible
  // row per tour-day (only days that actually have tours appear).
  const byDate: Record<string, [string, Booking[]][]> = {};
  for (const [key, items] of Object.entries(groups)) { const d = items[0].date!; (byDate[d] ??= []).push([key, items]); }
  for (const d of Object.keys(byDate)) byDate[d].sort(([, a], [, b]) => (a[0].slotIdx ?? 0) - (b[0].slotIdx ?? 0));
  const readyDates = Object.keys(byDate).sort();
  // Month summaries so the inbox can break a long list into "June 2026" sections.
  const monthSummary: Record<string, { tours: number; pax: number }> = {};
  for (const d of readyDates) {
    const m = d.slice(0, 7);
    (monthSummary[m] ??= { tours: 0, pax: 0 });
    monthSummary[m].tours += byDate[d].length;
    monthSummary[m].pax += byDate[d].reduce((sum, [, items]) => sum + items.reduce((a, b) => a + (b.pax ?? 0), 0), 0);
  }
  const readyMonths = [...new Set(readyDates.map((d) => d.slice(0, 7)))].sort();
  const shownDates = monthFilter ? readyDates.filter((d) => d.slice(0, 7) === monthFilter) : readyDates;
  const fmtDay = (d: string) => { const dt = parseYMD(d); return `${DOW[(dt.getDay() + 6) % 7]} ${dt.getDate()} ${MON[dt.getMonth()].slice(0, 3)} ${dt.getFullYear()}`; };

  async function offerGroup(key: string, items: Booking[], guideId?: string) {
    const date = items[0].date!; const slotIdx = items[0].slotIdx!; const tourId = groupTourId(items);
    const pax = items.reduce((s, b) => s + (b.pax ?? 0), 0) || undefined;
    const durMin = dur[key] && Number(dur[key]) > 0 ? Math.round(Number(dur[key]) * 60) : undefined;
    const note = `${items.length} booking(s): ${items.map((b) => b.externalRef || b.confirmationCode || b.customerName || "—").join(", ")}`.slice(0, 280);
    const r = await fetch("/api/offers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tourId, date, slotIdx, pax: pax && pax <= 50 ? pax : undefined, durationMin: durMin, note, ...(guideId ? { guideId } : {}) }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setMsg("Offer failed."); return; }
    if (!d.candidates) { setMsg(guideId ? "⚠️ That guide isn\u2019t available for this slot." : "⚠️ No available guides for that slot."); return; }
    await post({ action: "markOffered", ids: items.map((b) => b.id) });
    setMsg(guideId ? `\ud83d\udce8 Offered to ${guideId} \u2014 they accept or pass.` : `\ud83d\udce3 Offer sent \u2014 ${d.candidates} guide(s), LINE ${d.lineSent}.`);
    await load();
  }

  return (
    <div className="wrap">
      <AuthHeader backHref="/" />
      <div id="appBar"><div className="subtabs">
        <button className={`subtab ${tab === "inbox" ? "active" : ""}`} onClick={() => setTab("inbox")}>Inbox</button>
        <button className={`subtab ${tab === "all" ? "active" : ""}`} onClick={() => setTab("all")}>All bookings</button>
      </div></div>

      {tab === "all" && <BookingsTable onOpen={openDetail} />}

      {tab === "inbox" && (
      <section className="panel">
        <div className="panel-head"><h2>Incoming bookings</h2>
          <div className="head-tools">
            <span style={{ color: "var(--ink-soft)", fontWeight: 600, fontSize: 13 }}>{msg}</span>
            {wh && (() => {
              const last = wh.lastWebhookAt ? new Date(wh.lastWebhookAt).getTime() : 0;
              const mins = last ? Math.floor((Date.now() - last) / 60000) : Infinity;
              const live = last && mins < 60 * 24 * 3; // seen in the last 3 days
              const ago = !last ? "never" : mins < 1 ? "just now" : mins < 60 ? `${mins}m ago` : mins < 60 * 24 ? `${Math.floor(mins / 60)}h ago` : `${Math.floor(mins / 1440)}d ago`;
              return (
                <span title={live ? "Bokun's webhook is delivering bookings & cancellations automatically." : "No recent webhook events — bookings only update when you press Sync. Check the Bokun webhook URL."}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, padding: "3px 9px", borderRadius: 999, border: "1px solid", borderColor: live ? "var(--ok-line, var(--line))" : "var(--danger-line)", background: live ? "var(--ok-bg, var(--surface))" : "var(--danger-bg)", color: live ? "var(--ok, #2f7d4f)" : "var(--danger)" }}>
                  <span style={{ width: 7, height: 7, borderRadius: 999, background: live ? "#2f9e54" : "var(--danger)" }} />
                  {live ? `Live sync · last event ${ago}` : "Live sync off"}
                </span>
              );
            })()}
            <button className="btn sm" disabled={syncing} onClick={syncBokun}>{syncing ? "Syncing…" : "↺ Sync from Bokun"}</button>
            <button className="btn sm" disabled={importing} onClick={() => jsRef.current?.click()} title="Upload one or more filled FOLKPATHS job-sheet .xlsx files at once (non-Bokun tours) — saved immediately, no refresh needed">{importing ? "Importing…" : "📋 Import job sheets"}</button>
            <button className="btn sm" onClick={archiveStale} title="Hide past unassigned bookings (already-passed tours that were never dispatched) from the inbox + reports">🗄 Archive past unassigned</button>
            <input ref={jsRef} type="file" accept=".xlsx" multiple hidden onChange={(e) => { const fl = e.target.files; if (fl && fl.length) importJobSheets(fl); e.target.value = ""; }} />
            <button className="btn sm" onClick={() => setShowAdd((s) => !s)}>+ Add booking</button>
          </div>
        </div>

        <div style={{ padding: 14 }}>
          {wh && (() => {
            const last = wh.lastWebhookAt ? new Date(wh.lastWebhookAt).getTime() : 0;
            const hrs = last ? (Date.now() - last) / 3600000 : Infinity;
            if (hrs < 24) return null; // webhook healthy — no banner
            const ago = !last ? "ever" : hrs < 48 ? `${Math.floor(hrs)} hours` : `${Math.floor(hrs / 24)} days`;
            return (
              <div role="alert" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", padding: "12px 14px", marginBottom: 14, borderRadius: 12, border: "1.5px solid var(--danger-line)", background: "var(--danger-bg)", color: "var(--danger)" }}>
                <span style={{ fontSize: 18 }}>⚠️</span>
                <div style={{ flex: 1, minWidth: 220, fontSize: 13.5, fontWeight: 600, lineHeight: 1.4 }}>
                  Live sync from Bokun has been silent for {ago === "ever" ? "a while" : ago}. New bookings &amp; cancellations may be out of date — press Sync to catch up, and check the Bokun webhook is still connected.
                </div>
                <button className="btn sm" disabled={syncing} onClick={syncBokun} style={{ borderColor: "var(--danger-line)", color: "var(--danger)", fontWeight: 700 }}>{syncing ? "Syncing…" : "↺ Sync now"}</button>
              </div>
            );
          })()}
          {showAdd && (
            <div className="op-toolbar" style={{ borderRadius: 12, border: "1.5px solid var(--line)", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
              <select className="search" style={{ flex: "none", width: 130 }} value={m.source} onChange={(e) => setM({ ...m, source: e.target.value })}>
                <option value="direct">Direct</option><option value="agent">Agent</option><option value="referral">Referral</option>
                <option value="viator">Viator</option><option value="gyg">GetYourGuide</option><option value="klook">Klook</option><option value="manual">Other</option>
              </select>
              <select className="search" style={{ flex: "none", width: 180 }} value={m.tourId} onChange={(e) => setM({ ...m, tourId: e.target.value })}>
                <option value="">Tour…</option>
                {tours.map((t) => <option key={t.id} value={t.id}>{t.id} · {t.name}</option>)}
              </select>
              <input className="search" style={{ flex: "none", width: 140 }} type="date" title="Tour date" value={m.date} onChange={(e) => setM({ ...m, date: e.target.value })} />
              <select className="search" style={{ flex: "none", width: 90 }} value={m.slotIdx} onChange={(e) => setM({ ...m, slotIdx: Number(e.target.value) })}>
                {SLOTS.map((s) => <option key={s.idx} value={s.idx}>{s.start}</option>)}
              </select>
              <input className="search" style={{ flex: "none", width: 70 }} type="number" min={1} placeholder="pax" value={m.pax} onChange={(e) => setM({ ...m, pax: e.target.value })} />
              <input className="search" style={{ flex: "none", width: 130 }} placeholder="Booking #" value={m.confirmationCode} onChange={(e) => setM({ ...m, confirmationCode: e.target.value })} />
              <input className="search" style={{ flex: "none", width: 150 }} placeholder="Guest name" value={m.customerName} onChange={(e) => setM({ ...m, customerName: e.target.value })} />
              <input className="search" style={{ flex: "none", width: 110 }} placeholder="Nationality" value={m.nationality} onChange={(e) => setM({ ...m, nationality: e.target.value })} />
              <input className="search" style={{ flex: "none", width: 170 }} placeholder="Email" value={m.email} onChange={(e) => setM({ ...m, email: e.target.value })} />
              <input className="search" style={{ flex: "none", width: 130 }} placeholder="Phone" value={m.phone} onChange={(e) => setM({ ...m, phone: e.target.value })} />
              <select className="search" style={{ flex: "none", width: 120 }} title="Payment" value={m.paymentStatus} onChange={(e) => setM({ ...m, paymentStatus: e.target.value })}>
                <option value="unpaid">Unpaid</option><option value="deposit">Deposit</option><option value="paid">Paid</option>
              </select>
              <input className="search" style={{ minWidth: 180, flex: 1 }} placeholder="Special requests" value={m.specialRequests} onChange={(e) => setM({ ...m, specialRequests: e.target.value })} />
              <input className="search" style={{ minWidth: 160, flex: 1 }} placeholder="Notes" value={m.notes} onChange={(e) => setM({ ...m, notes: e.target.value })} />
              <button className="btn sm primary" onClick={async () => {
                if (!m.tourId || !/^\d{4}-\d{2}-\d{2}$/.test(m.date)) { setMsg("Pick tour + date."); return; }
                const r = await post({ action: "add", tourId: m.tourId, date: m.date, slotIdx: m.slotIdx, pax: m.pax ? Number(m.pax) : undefined, confirmationCode: m.confirmationCode || undefined, customerName: m.customerName || undefined, source: m.source, nationality: m.nationality || undefined, email: m.email || undefined, phone: m.phone || undefined, specialRequests: m.specialRequests || undefined, notes: m.notes || undefined, paymentStatus: m.paymentStatus });
                if (r.ok) { setShowAdd(false); setM({ ...m, pax: "", confirmationCode: "", customerName: "", nationality: "", email: "", phone: "", specialRequests: "", notes: "" }); await load(); }
              }}>Add booking</button>
            </div>
          )}

          {/* Connect tour (one-time per product) */}
          {needMap.length > 0 && (
            <>
              <h3 style={{ fontSize: 14, margin: "4px 0 8px" }}>🔗 Connect tour ({needMap.length}) <span style={{ fontWeight: 400, color: "var(--ink-soft)" }}>— one-time per product; future bookings auto-connect</span></h3>
              <table className="acct-table">
                <thead><tr><th>Source</th><th>Ref / Customer</th><th>Date</th><th>Tour</th><th>Slot</th><th /></tr></thead>
                <tbody>
                  {needMap.map((b) => (
                    <tr key={b.id}>
                      <td><span className="badge">{b.source}</span></td>
                      <td>{b.externalRef || b.confirmationCode || b.customerName || "—"}</td>
                      <td><input type="date" className="search" style={{ width: 140 }} defaultValue={b.date ?? ""} onBlur={(e) => e.target.value && post({ action: "update", id: b.id, date: e.target.value }).then(load)} /></td>
                      <td>
                        <select className="search" defaultValue={b.tourId ?? ""} onChange={(e) => post({ action: "update", id: b.id, tourId: e.target.value }).then(load)}>
                          <option value="">— tour —</option>
                          {tours.map((t) => <option key={t.id} value={t.id}>{t.id} · {t.name}</option>)}
                        </select>
                      </td>
                      <td>
                        <select className="search" defaultValue={b.slotIdx ?? ""} onChange={(e) => post({ action: "update", id: b.id, slotIdx: Number(e.target.value) }).then(load)}>
                          <option value="">{b.startTime ? `(${b.startTime})` : "— slot —"}</option>
                          {SLOTS.map((s) => <option key={s.idx} value={s.idx}>{s.start}</option>)}
                        </select>
                      </td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        <button className="btn sm" onClick={() => openDetail(b.id)}>ℹ️ Details</button>{" "}
                        <button className="btn sm danger" onClick={() => removeBooking(b.id, `${b.source} · ${b.externalRef || b.confirmationCode || b.customerName || "—"}`)}>🗑 Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {/* Ready — one collapsible row per tour-day (only days with tours show) */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "16px 0 8px" }}>
            <h3 style={{ fontSize: 14, margin: 0 }}>Ready to offer</h3>
            {readyMonths.length > 1 && (
              <select className="search" style={{ flex: "none", width: 160, marginLeft: "auto" }} value={monthFilter} onChange={(e) => setMonthFilter(e.target.value)} title="Filter by month">
                <option value="">All months</option>
                {readyMonths.map((m) => <option key={m} value={m}>{new Date(`${m}-01T00:00:00`).toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</option>)}
              </select>
            )}
          </div>
          {readyDates.length === 0 ? <div className="op-empty">No bookings ready. New Bokun bookings will appear here automatically.</div> : (
            shownDates.map((date, di) => {
              const dayGroups = byDate[date];
              const dayPax = dayGroups.reduce((s, [, items]) => s + items.reduce((a, b) => a + (b.pax ?? 0), 0), 0);
              const dayOver = dayGroups.some(([, items]) => items.reduce((a, b) => a + (b.pax ?? 0), 0) > 10);
              const open = openDates[date] ?? (di === 0);
              const month = date.slice(0, 7);
              const showMonth = di === 0 || shownDates[di - 1].slice(0, 7) !== month;
              const monthLabel = new Date(`${date}T00:00:00`).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
              const ms = monthSummary[month];
              return (
                <Fragment key={date}>
                {showMonth && (
                  <div style={{ display: "flex", alignItems: "baseline", gap: 10, margin: di === 0 ? "4px 2px 8px" : "20px 2px 8px", paddingBottom: 6, borderBottom: "2px solid var(--line)" }}>
                    <span style={{ fontSize: 15, fontWeight: 800, letterSpacing: "-0.01em" }}>{monthLabel}</span>
                    <span style={{ fontSize: 12.5, color: "var(--ink-soft)", fontWeight: 600 }}>{ms.tours} tour{ms.tours === 1 ? "" : "s"} · {ms.pax} pax</span>
                  </div>
                )}
                <div style={{ border: "1.5px solid var(--line)", borderRadius: 12, marginBottom: 10, overflow: "hidden" }}>
                  <button onClick={() => setOpenDates((o) => ({ ...o, [date]: !open }))} style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", background: open ? "#f3f6f4" : "#fff", border: "none", borderBottom: open ? "1px solid var(--line)" : "none", cursor: "pointer", font: "inherit", textAlign: "left" }}>
                    <span style={{ display: "inline-block", transform: open ? "rotate(90deg)" : "none", transition: "transform .15s", color: "var(--ink-soft)" }}>▸</span>
                    <b style={{ flex: 1 }}>{fmtDay(date)}</b>
                    {dayOver && <span className="badge" style={{ background: "#fbe6e2", color: "#b23b2e" }}>over 10</span>}
                    <span className="badge">{dayGroups.length} tour{dayGroups.length > 1 ? "s" : ""}</span>
                    <span style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>{dayPax} pax</span>
                  </button>
                  {open && (
                    <div style={{ padding: 12, display: "grid", gap: 10, background: "#fafbfa" }}>
                      {dayGroups.map(([key, items]) => {
                        const slotIdx = items[0].slotIdx!; const tourId = groupTourId(items);
                        const slot = SLOTS[slotIdx];
                        const pax = items.reduce((s, b) => s + (b.pax ?? 0), 0);
                        const assignedGuide = items.find((b) => b.guideId)?.guideId ?? null;
                        const assignedName = items.find((b) => b.guide)?.guide ?? null;
                        return (
                          <div key={key} className="op-toolbar" style={{ borderRadius: 10, border: "1px solid var(--line)", background: assignedGuide ? "var(--grey-bg, #f6f5f3)" : "#fff", flexWrap: "wrap", alignItems: "center" }}>
                            <div style={{ flex: 1, minWidth: 240 }}>
                              <b>{slot?.start} · {tourName(tourId)}</b>
                              <div style={{ fontSize: 12.5, color: "var(--ink-soft)", marginTop: 3 }}>
                                {items.length} booking(s) · {pax} pax{pax > 10 ? " ⚠️ over 10 — split into separate jobs" : ""}
                              </div>
                              <div style={{ marginTop: 5, display: "flex", flexWrap: "wrap", gap: 5 }}>
                                {items.map((b) => (
                                  <span key={b.id} style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "#fff", border: "1px solid var(--line,#ddd)", borderRadius: 20, padding: "2px 6px 2px 10px", fontSize: 12 }}>
                                    <button onClick={() => openDetail(b.id)} title="Details" style={{ border: "none", background: "none", cursor: "pointer", padding: 0, font: "inherit" }}>{b.externalRef || b.confirmationCode || b.customerName || "—"} ×{b.pax ?? "?"} ℹ️</button>
                                    <button title="Delete" onClick={() => removeBooking(b.id, b.externalRef || b.confirmationCode || b.customerName || "—")} style={{ border: "none", background: "#fbe6e2", color: "#b23b2e", borderRadius: "50%", width: 18, height: 18, cursor: "pointer", lineHeight: 1, fontWeight: 700 }}>×</button>
                                  </span>
                                ))}
                              </div>
                            </div>
                            {assignedGuide ? (
                              <span className="badge active" title="This slot is already dispatched to a guide" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700 }}>✓ Assigned to <span className="gid">{assignedGuide}</span>{assignedName && assignedName !== assignedGuide ? ` · ${assignedName}` : ""}</span>
                            ) : (
                              <>
                                <label style={{ fontSize: 12 }}>Dur (h)<input className="search" style={{ width: 56, marginLeft: 4 }} type="number" min={0} step={0.5} value={dur[key] ?? "3"} onChange={(e) => setDur((x) => ({ ...x, [key]: e.target.value }))} /></label>
                                <select className="search" style={{ flex: "none", width: 168 }} value={grpGuide[key] ?? ""} onChange={(e) => setGrpGuide((x) => ({ ...x, [key]: e.target.value }))}>
                                  <option value="">Offer to all available</option>
                                  {guides.filter((g) => !availMap[key] || availMap[key].includes(g.guideId)).map((g) => <option key={g.guideId} value={g.guideId}>{g.online ? "🟢" : "⚪"} {g.guideId} · {g.displayName}{g.rating != null ? ` · ★${g.rating}` : ""}</option>)}
                                </select>
                                {grpGuide[key]
                                  ? <>
                                      <button className="btn sm primary" onClick={() => offerGroup(key, items, grpGuide[key])}>📨 Offer to guide</button>
                                      <button className="btn sm" onClick={() => assignGroup(key, items, grpGuide[key])}>{pax > 10 ? "Assign all (over cap)" : "Assign now"}</button>
                                    </>
                                  : <button className="btn sm primary" onClick={() => offerGroup(key, items)}>📣 Offer all</button>}
                                {pax > 10 && <button className="btn sm" title="Split this over-capacity slot across several guides instead" onClick={() => openSplit(items)}>Split across guides</button>}
                              </>
                            )}
                            <button className="btn sm danger" title="Delete this job and its bookings" onClick={() => deleteGroup(items)}>🗑</button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                </Fragment>
              );
            })
          )}
        </div>
      </section>
      )}

      {detail && (
        <div className="scrim show" onClick={(e) => { if (e.target === e.currentTarget) setDetail(null); }}>
          <div className="modal" style={{ maxWidth: 560, width: "92%" }}>
            <h3>Booking · {str(detail.externalRef || detail.confirmationCode) || "—"}</h3>
            <div className="mbody">
              <div className="bk-meta">
                <span><b>Source</b> {str(detail.source)}</span>
                {detail.externalRef ? <span><b>OTA #</b> {str(detail.externalRef)}</span> : null}
                {detail.productName ? <span><b>Product</b> {str(detail.productName)}</span> : null}
              </div>
              <div className="bk-form">
                <label>Status<select value={str(detail.status) || "PENDING"} onChange={(e) => setField("status", e.target.value)}>
                  {["PENDING", "OFFERED", "ASSIGNED", "CANCELLED", "IGNORED"].map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
                <label style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "end", color: detail.noShow ? "var(--danger)" : undefined, fontWeight: detail.noShow ? 700 : undefined }}>
                  <input type="checkbox" checked={!!detail.noShow} onChange={async (e) => { const v = e.target.checked; setField("noShow", v); await fetch("/api/bookings/noshow", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: detail.id, noShow: v }) }); load(); }} />
                  No-show (guest didn&apos;t arrive)
                </label>
                <label>Payment<select value={str(detail.paymentStatus) || "unpaid"} onChange={(e) => setField("paymentStatus", e.target.value)}>
                  {["unpaid", "deposit", "paid"].map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
                <label>Tour<select value={str(detail.tourId)} onChange={(e) => setField("tourId", e.target.value)}>
                  <option value="">—</option>{tours.map((t) => <option key={t.id} value={t.id}>{t.id} · {t.name}</option>)}</select></label>
                <label>Date<input type="date" value={str(detail.date)} onChange={(e) => setField("date", e.target.value)} /></label>
                <label>Slot<select value={Number(detail.slotIdx ?? 0)} onChange={(e) => setField("slotIdx", Number(e.target.value))}>
                  {SLOTS.map((s) => <option key={s.idx} value={s.idx}>{s.start}</option>)}</select></label>
                <label>Pax<input type="number" min={1} value={str(detail.pax)} onChange={(e) => setField("pax", e.target.value)} /></label>
                <label>Booking #<input value={str(detail.confirmationCode)} onChange={(e) => setField("confirmationCode", e.target.value)} /></label>
                <label>Guest name<input value={str(detail.customerName)} onChange={(e) => setField("customerName", e.target.value)} /></label>
                <label>Nationality<input value={str(detail.nationality)} onChange={(e) => setField("nationality", e.target.value)} /></label>
                <label>Email<input value={str(detail.email)} onChange={(e) => setField("email", e.target.value)} /></label>
                <label>Phone<input value={str(detail.phone)} onChange={(e) => setField("phone", e.target.value)} /></label>
                <label className="wide">Special requests<input value={str(detail.specialRequests)} onChange={(e) => setField("specialRequests", e.target.value)} /></label>
                <label className="wide">Notes<input value={str(detail.notes)} onChange={(e) => setField("notes", e.target.value)} /></label>
              </div>
              {detail.raw ? (
                <details style={{ marginTop: 12 }}>
                  <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 13 }}>Raw OTA payload</summary>
                  <pre style={{ background: "#f6f6f6", border: "1px solid var(--line,#ddd)", borderRadius: 8, padding: 10, fontSize: 11, overflow: "auto", maxHeight: 320 }}>{JSON.stringify(detail.raw, null, 2)}</pre>
                </details>
              ) : null}
            </div>
            <div className="mfoot">
              <button className="btn ghost danger" onClick={() => removeBooking(String(detail.id), `${detail.source} · ${detail.confirmationCode || detail.customerName || "—"}`)}>🗑 Delete</button>
              <button className="btn" onClick={() => setDetail(null)}>Close</button>
              <button className="btn primary" onClick={saveDetail}>Save changes</button>
            </div>
          </div>
        </div>
      )}

      {splitFor && (
        <div className="scrim show" onClick={(e) => { if (e.target === e.currentTarget) setSplitFor(null); }}>
          <div className="modal" style={{ maxWidth: 560 }}>
            <div style={{ padding: "18px 20px" }}>
              <h3 style={{ margin: "0 0 4px" }}>Split across guides</h3>
              <p className="sub" style={{ margin: "0 0 14px" }}>{splitFor.date} · {SLOTS[splitFor.slotIdx]?.start} · {splitFor.items.reduce((s, b) => s + (b.pax ?? 0), 0)} pax over {splitFor.items.length} bookings. Assign each booking to a guide (max 10 pax each — families stay together).</p>
              <div style={{ display: "grid", gap: 6, marginBottom: 14 }}>
                {splitFor.items.map((b) => (
                  <div key={b.id} className="op-toolbar" style={{ borderRadius: 10, border: "1px solid var(--line)", alignItems: "center", gap: 8, padding: "7px 10px" }}>
                    <span style={{ flex: 1, fontSize: 13 }}><b>{b.externalRef || b.confirmationCode || b.customerName || "—"}</b> · {b.pax ?? "?"} pax</span>
                    <select className="search" style={{ flex: "none", width: 220 }} value={splitMap[b.id] ?? ""} onChange={(e) => setSplitMap((m) => ({ ...m, [b.id]: e.target.value }))}>
                      <option value="">Assign to guide…</option>
                      {guides.map((g) => <option key={g.guideId} value={g.guideId}>{g.online ? "🟢" : "⚪"} {g.guideId} · {g.displayName}{g.rating != null ? ` · ★${g.rating}` : ""}</option>)}
                    </select>
                  </div>
                ))}
              </div>
              {Array.from(new Set(Object.values(splitMap).filter(Boolean))).length > 0 && (
                <div style={{ display: "grid", gap: 4, marginBottom: 6 }}>
                  {Array.from(new Set(Object.values(splitMap).filter(Boolean))).map((gid) => {
                    const p = splitPax(gid); const over = p > 10;
                    return <div key={gid} style={{ fontSize: 12.5, fontWeight: 600, color: over ? "var(--danger)" : "var(--green)" }}>{gid}: {p} / 10 pax {over ? "⚠️ over cap" : "✓"}</div>;
                  })}
                </div>
              )}
            </div>
            <div className="mfoot">
              <button className="btn" onClick={() => setSplitFor(null)}>Cancel</button>
              <button className="btn primary" onClick={submitSplit}>Assign split</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
