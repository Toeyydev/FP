"use client";

// Review incentive inbox — the operator's working surface for customer reviews.
// Booking-ref search up top (ref → booking → job → guide, nothing re-typed),
// a dense filterable table below, and per-guide weekly payouts. A review NEVER
// touches the original job sheet: it is its own financial record.

import { useCallback, useEffect, useMemo, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import OperatorNav from "@/components/OperatorNav";
import { thb } from "@/lib/jobsheet";

type Review = {
  id: string; bookingReference: string | null; source: string; reviewDate: string;
  rating: number | null; reviewerName: string | null; reviewText: string | null; reviewUrl: string | null;
  incentiveAmount: number; guideId: string | null; guideName: string | null; tourId: string | null;
  tourDate: string | null; jobSheetRef: string | null; matchStatus: string; paymentStatus: string; payoutBatchId: string | null;
};
type Lookup = {
  found: boolean; bookingReference?: string; guestName?: string | null; bookingSource?: string;
  tourName?: string | null; tourDate?: string | null; guideId?: string | null; guideName?: string | null;
  jobSheetRef?: string | null; guideAmbiguous?: { guideId: string; name: string }[];
};
type Payout = { id: string; ref: string; guideId: string; guideName: string; periodStart: string; periodEnd: string; totalAmount: number; status: string; paidAt: string | null; eslipUrl: string | null; reviewCount: number };

const fmt = (d: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
const stars = (n: number | null) => (n ? "★".repeat(n) : "—");
const payTone = (s: string) => (s === "PAID" ? "ok" : s === "IN_PAYOUT" ? "mut" : s === "VOID" ? "mut" : "warn");
const payLabel = (s: string) => (s === "IN_PAYOUT" ? "IN PAYOUT" : s);

export default function Reviews({ canEdit }: { canEdit: boolean }) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [guides, setGuides] = useState<{ guideId: string; displayName: string }[]>([]);
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  // Booking-ref search + add form
  const [refQ, setRefQ] = useState("");
  const [look, setLook] = useState<Lookup | null>(null);
  const [form, setForm] = useState({ rating: 5, reviewDate: new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10), reviewerName: "", reviewText: "", reviewUrl: "", amount: 100 });

  // Filters
  const [q, setQ] = useState("");
  const [fGuide, setFGuide] = useState(""); const [fMatch, setFMatch] = useState(""); const [fPay, setFPay] = useState("");
  const [fSource, setFSource] = useState(""); const [fRating, setFRating] = useState(""); const [fFrom, setFFrom] = useState(""); const [fTo, setFTo] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    fetch("/api/reviews", { cache: "no-store" }).then((r) => r.json()).then((d) => { setReviews(d.reviews ?? []); setGuides(d.guides ?? []); }).catch(() => {});
    fetch("/api/reviews/payout", { cache: "no-store" }).then((r) => r.json()).then((d) => setPayouts(d.payouts ?? [])).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  async function doLookup() {
    setLook(null); setMsg("");
    if (refQ.trim().length < 4) { setMsg("Enter a booking reference (e.g. GYG2Q9GL5Q49)."); return; }
    const r = await fetch(`/api/reviews/lookup?ref=${encodeURIComponent(refQ.trim())}`, { cache: "no-store" });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d) { setMsg("Lookup failed — try again."); return; }
    setLook(d);
    if (!d.found) setMsg("Booking reference not found — you can still add the review as UNMATCHED and match it later.");
  }

  async function addReview(force = false) {
    setBusy(true); setMsg("");
    const r = await fetch("/api/reviews", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bookingReference: refQ.trim() || undefined, source: "GETYOURGUIDE", reviewDate: form.reviewDate,
        rating: form.rating, reviewerName: form.reviewerName || undefined, reviewText: form.reviewText || undefined,
        reviewUrl: form.reviewUrl || undefined, incentiveAmount: form.amount, force,
      }),
    });
    const d = await r.json().catch(() => null);
    setBusy(false);
    if (r.status === 409 && d?.duplicate) {
      if (confirm(`A review for this booking (${refQ.trim().toUpperCase()}) already exists — dated ${fmt(d.duplicate.reviewDate)}. Add another anyway?`)) return addReview(true);
      return;
    }
    if (!r.ok) { setMsg("Couldn't add the review — check the fields."); return; }
    setMsg("Review added ✓"); setLook(null); setRefQ("");
    setForm((f) => ({ ...f, reviewerName: "", reviewText: "", reviewUrl: "", rating: 5 }));
    load();
  }

  async function patch(body: Record<string, unknown>, okMsg: string) {
    setBusy(true);
    const r = await fetch("/api/reviews", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => null);
    setBusy(false);
    setMsg(r.ok ? okMsg : d?.hint || d?.error || "Action failed.");
    if (r.ok) load();
  }

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return reviews.filter((r) => {
      if (fGuide && r.guideId !== fGuide) return false;
      if (fMatch && r.matchStatus !== fMatch) return false;
      if (fPay && r.paymentStatus !== fPay) return false;
      if (fSource && r.source !== fSource) return false;
      if (fRating && String(r.rating ?? "") !== fRating) return false;
      if (fFrom && r.reviewDate < fFrom) return false;
      if (fTo && r.reviewDate > fTo) return false;
      if (needle) {
        const hay = `${r.bookingReference ?? ""} ${r.jobSheetRef ?? ""} ${r.reviewerName ?? ""} ${r.guideName ?? ""} ${r.guideId ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [reviews, q, fGuide, fMatch, fPay, fSource, fRating, fFrom, fTo]);

  // Payout selection: eligible rows only, and one guide at a time (a payout is per guide).
  const eligible = (r: Review) => r.matchStatus === "MATCHED" && r.paymentStatus === "UNPAID" && !!r.guideId;
  const selReviews = reviews.filter((r) => sel.has(r.id));
  const selGuide = selReviews.length ? selReviews[0].guideId : null;
  const selTotal = selReviews.reduce((s, r) => s + r.incentiveAmount, 0);
  const toggleSel = (r: Review) => setSel((p) => {
    const n = new Set(p);
    if (n.has(r.id)) n.delete(r.id);
    else { if (selGuide && r.guideId !== selGuide) return p; n.add(r.id); }
    return n;
  });

  async function createPayout() {
    if (!selGuide || !sel.size) return;
    if (!confirm(`Create a review payout for ${selGuide} — ${sel.size} review${sel.size === 1 ? "" : "s"} · ${thb(selTotal)}?`)) return;
    setBusy(true);
    const r = await fetch("/api/reviews/payout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId: selGuide, reviewIds: [...sel] }) });
    const d = await r.json().catch(() => null);
    setBusy(false);
    setMsg(r.ok ? `Payout ${d.ref} created — ${d.count} review(s) · ${thb(d.total)} ✓` : d?.error || "Couldn't create the payout.");
    if (r.ok) { setSel(new Set()); load(); }
  }

  async function payoutAction(p: Payout, action: "paid" | "unpaid" | "delete") {
    if (action === "delete" && !confirm(`Cancel payout ${p.ref}? Its reviews go back to UNPAID.`)) return;
    if (action === "paid" && !confirm(`Mark ${p.ref} PAID — ${thb(p.totalAmount)} to ${p.guideName}?`)) return;
    setBusy(true);
    const r = action === "delete"
      ? await fetch(`/api/reviews/payout?id=${p.id}`, { method: "DELETE" })
      : await fetch("/api/reviews/payout", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: p.id, action }) });
    const d = await r.json().catch(() => null);
    setBusy(false);
    setMsg(r.ok ? "Done ✓" : d?.hint || d?.error || "Action failed.");
    if (r.ok) load();
  }

  async function uploadSlip(p: Payout, file: File) {
    const fd = new FormData(); fd.set("payoutId", p.id); fd.set("file", file);
    setBusy(true);
    const r = await fetch("/api/reviews/payout/eslip", { method: "POST", body: fd });
    const d = await r.json().catch(() => null);
    setBusy(false);
    setMsg(r.ok ? `Slip uploaded — ${p.ref} marked PAID ✓` : d?.hint || d?.error || "Upload failed.");
    if (r.ok) load();
  }

  const unmatchedCount = reviews.filter((r) => r.matchStatus === "UNMATCHED" && r.paymentStatus !== "VOID").length;

  return (
    <div className="wrap">
      <AuthHeader home={false} />
      <div className="op-layout">
        <OperatorNav active="reviews" />
        <div className="op-main">
          <div className="subtabs" style={{ marginBottom: 10 }}><span className="subtab active">Reviews</span></div>

          {/* Booking-reference search + add */}
          {canEdit && (
            <section className="panel" style={{ padding: 14, marginBottom: 14 }}>
              <div className="panel-head" style={{ padding: 0, marginBottom: 8 }}><h2>Add a review</h2><span className="hint">Search the OTA booking reference — job & guide fill themselves</span></div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input className="search" style={{ flex: "1 1 260px", textTransform: "uppercase" }} placeholder="Booking reference, e.g. GYG2Q9GL5Q49" value={refQ}
                  onChange={(e) => setRefQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && doLookup()} />
                <button className="btn primary" disabled={busy} onClick={doLookup}>Search booking</button>
              </div>
              {look && (
                <div style={{ marginTop: 10, padding: 10, background: "var(--grey-bg)", borderRadius: 8, fontSize: 13 }}>
                  {look.found ? (
                    <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                      <span><b>{look.bookingReference}</b> · {look.guestName || "—"} · {look.bookingSource}</span>
                      <span>Job <b>{look.jobSheetRef || "—"}</b> · {fmt(look.tourDate ?? null)}</span>
                      <span>{look.tourName || "—"}</span>
                      <span>Guide {look.guideId ? <b>{look.guideId} {look.guideName}</b> : <span className="ob warn">not identified{look.guideAmbiguous ? ` — split slot: ${look.guideAmbiguous.map((g) => g.name).join(" / ")}` : ""}</span>}</span>
                    </div>
                  ) : <span className="ob warn">Booking not found — the review will be created as UNMATCHED.</span>}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10, alignItems: "center" }}>
                    <label style={{ fontSize: 12 }}>Rating <select className="search" value={form.rating} onChange={(e) => setForm({ ...form, rating: Number(e.target.value) })}>{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{"★".repeat(n)}</option>)}</select></label>
                    <label style={{ fontSize: 12 }}>Review date <input className="search" type="date" value={form.reviewDate} onChange={(e) => setForm({ ...form, reviewDate: e.target.value })} /></label>
                    <label style={{ fontSize: 12 }}>Incentive ฿ <input className="search" type="number" style={{ width: 90 }} value={form.amount} onChange={(e) => setForm({ ...form, amount: Number(e.target.value) })} /></label>
                    <input className="search" style={{ flex: "1 1 160px" }} placeholder="Reviewer name (optional)" value={form.reviewerName} onChange={(e) => setForm({ ...form, reviewerName: e.target.value })} />
                    <input className="search" style={{ flex: "2 1 240px" }} placeholder="Review text (optional)" value={form.reviewText} onChange={(e) => setForm({ ...form, reviewText: e.target.value })} />
                    <input className="search" style={{ flex: "1 1 180px" }} placeholder="Review URL (optional)" value={form.reviewUrl} onChange={(e) => setForm({ ...form, reviewUrl: e.target.value })} />
                    <button className="btn primary" disabled={busy || !form.reviewDate} onClick={() => addReview()}>Add review</button>
                  </div>
                </div>
              )}
            </section>
          )}

          {msg && <div className="auth-msg" style={{ marginBottom: 10 }}>{msg}</div>}

          {/* Filters */}
          <section className="panel" style={{ padding: 14 }}>
            <div className="panel-head" style={{ padding: 0, marginBottom: 8 }}>
              <h2>Review inbox</h2>
              <span className="hint">{reviews.length} review{reviews.length === 1 ? "" : "s"}{unmatchedCount > 0 ? ` · ${unmatchedCount} unmatched` : ""}</span>
            </div>
            <div className="op-toolbar" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
              <input className="search" style={{ flex: "1 1 200px" }} placeholder="Search ref / job no. / guest / guide" value={q} onChange={(e) => setQ(e.target.value)} />
              <select className="search" value={fGuide} onChange={(e) => setFGuide(e.target.value)}><option value="">All guides</option>{guides.map((g) => <option key={g.guideId} value={g.guideId}>{g.guideId} {g.displayName}</option>)}</select>
              <select className="search" value={fMatch} onChange={(e) => setFMatch(e.target.value)}><option value="">Match: all</option><option value="MATCHED">Matched</option><option value="UNMATCHED">Unmatched</option></select>
              <select className="search" value={fPay} onChange={(e) => setFPay(e.target.value)}><option value="">Payment: all</option><option value="UNPAID">Unpaid</option><option value="IN_PAYOUT">In payout</option><option value="PAID">Paid</option><option value="VOID">Void</option></select>
              <select className="search" value={fRating} onChange={(e) => setFRating(e.target.value)}><option value="">Rating: all</option>{[5, 4, 3, 2, 1].map((n) => <option key={n} value={String(n)}>{n}★</option>)}</select>
              <input className="search" type="date" value={fFrom} onChange={(e) => setFFrom(e.target.value)} title="From review date" />
              <input className="search" type="date" value={fTo} onChange={(e) => setFTo(e.target.value)} title="To review date" />
            </div>

            {canEdit && sel.size > 0 && (
              <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 10px", background: "var(--green-bg)", border: "1px solid var(--green-line)", borderRadius: 8, marginBottom: 8, fontSize: 13 }}>
                <b>{sel.size}</b> selected · {selGuide} · <b>{thb(selTotal)}</b>
                <button className="btn sm primary" disabled={busy} onClick={createPayout}>Create payout</button>
                <button className="btn sm" onClick={() => setSel(new Set())}>Clear</button>
              </div>
            )}

            <div className="grid-scroll">
              <table className="acct-table" style={{ fontSize: 12.5 }}>
                <thead><tr>
                  {canEdit && <th></th>}
                  <th>Review date</th><th>Booking ref</th><th>Guest</th><th>Job no.</th><th>Tour date</th><th>Guide</th>
                  <th>Rating</th><th style={{ textAlign: "right" }}>Incentive</th><th>Payment</th><th>Match</th>{canEdit && <th></th>}
                </tr></thead>
                <tbody>
                  {visible.length === 0 && <tr><td colSpan={canEdit ? 12 : 10} className="op-empty">No reviews match the filters.</td></tr>}
                  {visible.map((r) => (
                    <tr key={r.id} className={sel.has(r.id) ? "sel" : undefined}>
                      {canEdit && <td>{eligible(r) && <input type="checkbox" checked={sel.has(r.id)} disabled={!!selGuide && r.guideId !== selGuide && !sel.has(r.id)} onChange={() => toggleSel(r)} />}</td>}
                      <td>{fmt(r.reviewDate)}</td>
                      <td><span className="gid">{r.bookingReference || "—"}</span></td>
                      <td title={r.reviewText || undefined}>{r.reviewerName || "—"}</td>
                      <td><span className="gid">{r.jobSheetRef || "—"}</span></td>
                      <td>{fmt(r.tourDate)}</td>
                      <td>{r.guideId ? `${r.guideId} ${r.guideName ?? ""}` : "—"}</td>
                      <td style={{ color: "var(--assign)" }}>{stars(r.rating)}</td>
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>{thb(r.incentiveAmount)}</td>
                      <td><span className={`ob ${payTone(r.paymentStatus)}`}>{payLabel(r.paymentStatus)}</span></td>
                      <td><span className={`ob ${r.matchStatus === "MATCHED" ? "ok" : "warn"}`}>{r.matchStatus}</span></td>
                      {canEdit && (
                        <td style={{ whiteSpace: "nowrap" }}>
                          {r.matchStatus === "UNMATCHED" && r.paymentStatus !== "VOID" && (
                            <>
                              <button className="btn sm" disabled={busy} title="Match by booking reference" onClick={() => { const ref = prompt("Booking reference for this review:", r.bookingReference ?? ""); if (ref) patch({ id: r.id, action: "match", bookingReference: ref }, "Matched ✓"); }}>Match</button>{" "}
                              <button className="btn sm" disabled={busy} title="Pick the guide manually" onClick={() => { const g = prompt(`Guide ID (e.g. G-013):\n${guides.map((x) => `${x.guideId} ${x.displayName}`).join("\n")}`); if (g) patch({ id: r.id, action: "setGuide", guideId: g.trim().toUpperCase() }, "Guide set ✓"); }}>Guide…</button>
                            </>
                          )}
                          {r.paymentStatus === "UNPAID" && (
                            <>
                              {" "}<button className="btn sm" disabled={busy} title="Edit incentive amount" onClick={() => { const a = prompt("Incentive amount (THB):", String(r.incentiveAmount)); if (a != null && a !== "") patch({ id: r.id, action: "amount", incentiveAmount: Number(a) }, "Amount updated ✓"); }}>฿</button>
                              {" "}<button className="btn sm danger" disabled={busy} onClick={() => { if (confirm("Void this review incentive? It won't be paid.")) patch({ id: r.id, action: "void" }, "Voided ✓"); }}>Void</button>
                            </>
                          )}
                          {r.paymentStatus === "VOID" && <button className="btn sm" disabled={busy} onClick={() => patch({ id: r.id, action: "unvoid" }, "Restored ✓")}>Restore</button>}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Payouts */}
          <section className="panel" style={{ padding: 14, marginTop: 14 }}>
            <div className="panel-head" style={{ padding: 0, marginBottom: 8 }}><h2>Review payouts</h2><span className="hint">One per guide per run — the summary is the PEAK attachment</span></div>
            <div className="grid-scroll">
              <table className="acct-table" style={{ fontSize: 12.5 }}>
                <thead><tr><th>Ref</th><th>Guide</th><th>Period</th><th style={{ textAlign: "right" }}>Reviews</th><th style={{ textAlign: "right" }}>Total</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {payouts.length === 0 && <tr><td colSpan={7} className="op-empty">No review payouts yet — select unpaid matched reviews above to create one.</td></tr>}
                  {payouts.map((p) => (
                    <tr key={p.id}>
                      <td><span className="gid">{p.ref}</span></td>
                      <td>{p.guideId} {p.guideName}</td>
                      <td>{fmt(p.periodStart)} – {fmt(p.periodEnd)}</td>
                      <td style={{ textAlign: "right" }}>{p.reviewCount}</td>
                      <td style={{ textAlign: "right", fontWeight: 700 }}>{thb(p.totalAmount)}</td>
                      <td><span className={`ob ${p.status === "PAID" ? "ok" : "warn"}`}>{p.status}</span>{p.eslipUrl && <> <a href={p.eslipUrl} target="_blank" rel="noreferrer">Slip</a></>}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <a className="btn sm" href={`/api/reviews/summary?payoutId=${p.id}`} target="_blank" rel="noreferrer">Summary</a>
                        {canEdit && p.status !== "PAID" && (
                          <>
                            {" "}<label className="btn sm" style={{ cursor: "pointer" }}>Slip…<input type="file" accept="image/*,application/pdf" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadSlip(p, f); e.target.value = ""; }} /></label>
                            {" "}<button className="btn sm primary" disabled={busy} onClick={() => payoutAction(p, "paid")}>Mark paid</button>
                            {" "}<button className="btn sm danger" disabled={busy} onClick={() => payoutAction(p, "delete")}>Cancel</button>
                          </>
                        )}
                        {canEdit && p.status === "PAID" && <> <button className="btn sm" disabled={busy} onClick={() => payoutAction(p, "unpaid")}>Un-mark</button></>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
