"use client";

import { useCallback, useEffect, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";

type Tour = { id: string; name: string };
type Map = { id: string; productKey: string; productName: string; tourId: string; tourName: string };
type Unmapped = { name: string; count: number };

export default function ProductMapping() {
  const [tours, setTours] = useState<Tour[]>([]);
  const [maps, setMaps] = useState<Map[]>([]);
  const [unmapped, setUnmapped] = useState<Unmapped[]>([]);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");

  const load = useCallback(() => {
    fetch("/api/product-map", { cache: "no-store" }).then((r) => r.json()).then((d) => {
      setTours(d.tours ?? []); setMaps(d.maps ?? []); setUnmapped(d.unmapped ?? []);
    }).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  async function map(productName: string, tourId: string) {
    if (!tourId) return;
    const r = await fetch("/api/product-map", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ productName, tourId }) });
    const d = await r.json().catch(() => ({}));
    if (r.ok) { setMsg(`Mapped — ${d.backfilled ?? 0} existing booking(s) moved onto the tour & combined.`); load(); }
    else setMsg("Could not save mapping.");
  }
  async function unmap(key: string) {
    if (!confirm("Remove this mapping? Future bookings of this product will arrive without a tour again.")) return;
    await fetch(`/api/product-map?key=${encodeURIComponent(key)}`, { method: "DELETE" });
    load();
  }

  const tourSelect = (name: string) => (
    <select className="search" value={pick[name] ?? ""} onChange={(e) => setPick((p) => ({ ...p, [name]: e.target.value }))} style={{ minWidth: 200 }}>
      <option value="">Choose tour…</option>
      {tours.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
    </select>
  );

  return (
    <div className="wrap">
      <AuthHeader backHref="/" />
      <div id="appBar"><div className="subtabs"><span className="subtab active">Product mapping</span></div>
        <div className="nav"><a className="btn sm" href="/bookings">Bookings</a></div>
      </div>

      {msg && <div className="codeflash" style={{ background: "var(--green-bg)", color: "var(--ink)" }}>{msg}</div>}

      <section className="panel">
        <div className="panel-head"><h2>Unmapped products</h2><span className="hint">Bokun / GetYourGuide products that arrived with no tour — map each to combine & dispatch them</span></div>
        {unmapped.length === 0 ? <div className="op-empty">All products are mapped. New bookings auto-land on their tour.</div> : (
          <div className="grid-scroll">
            <table className="acct-table">
              <thead><tr><th>Product (from the channel)</th><th className="r">Bookings</th><th>Map to Folkpaths tour</th><th /></tr></thead>
              <tbody>
                {unmapped.map((u) => (
                  <tr key={u.name}>
                    <td><b>{u.name}</b></td>
                    <td className="r">{u.count}</td>
                    <td>{tourSelect(u.name)}</td>
                    <td><button className="btn sm primary" disabled={!pick[u.name]} onClick={() => map(u.name, pick[u.name])}>Map & combine</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Current mappings</h2><span className="hint">{maps.length} product(s) → tour</span></div>
        {maps.length === 0 ? <div className="op-empty">No mappings yet.</div> : (
          <div className="grid-scroll">
            <table className="acct-table">
              <thead><tr><th>Product</th><th>→ Tour</th><th /></tr></thead>
              <tbody>
                {maps.map((m) => (
                  <tr key={m.id}>
                    <td><b>{m.productName}</b></td>
                    <td>{m.tourName}</td>
                    <td><button className="btn sm danger" onClick={() => unmap(m.productKey)}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
