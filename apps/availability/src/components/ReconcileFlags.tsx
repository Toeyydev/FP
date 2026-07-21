"use client";

import { useCallback, useEffect, useState } from "react";

// Operator dashboard panel: open portal ↔ GetYourGuide booking mismatches raised by
// the reconciliation sweep. Renders nothing when all is clear, so it only appears
// when there's drift to act on. The on-screen twin of the manual tracker.

type Flag = {
  id: string;
  bookingId: string;
  externalRef: string | null;
  kind: string;
  action: string;
  portalStatus: string;
  channelStatus: string;
  portalPax: number;
  channelPax: number;
  tourDate: string | null;
};

const KIND_LABEL: Record<string, string> = {
  STATUS_MISMATCH: "Status differs",
  PAX_MISMATCH: "Pax differs",
  MISSING_ON_CHANNEL: "Not on GYG",
};

export default function ReconcileFlags({ canResolve = true }: { canResolve?: boolean }) {
  const [flags, setFlags] = useState<Flag[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/reconcile/flags", { cache: "no-store" });
    if (r.ok) { const d = await r.json(); setFlags(d.flags ?? []); }
    setLoaded(true);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function resolve(id: string) {
    if (!confirm("Mark this mismatch resolved?\nDo this once you've fixed it on GetYourGuide (and the portal). It will reappear if the next sync still sees a mismatch.")) return;
    setBusy(id);
    const r = await fetch("/api/reconcile/flags", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
    setBusy(null);
    if (r.ok) load();
  }

  // Show nothing until loaded, and nothing when everything reconciles.
  if (!loaded || flags.length === 0) return null;

  return (
    <section className="panel" style={{ marginBottom: 14, borderLeft: "3px solid #d97706" }}>
      <div className="panel-head">
        <h2>⚠ Booking mismatches vs GetYourGuide ({flags.length})</h2>
        <span className="hint">GetYourGuide is the source of truth — fix each on GYG first, then mark it resolved.</span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Tour date</th>
              <th>Ref</th>
              <th>Issue</th>
              <th>Portal</th>
              <th>GetYourGuide</th>
              <th>Action</th>
              {canResolve && <th></th>}
            </tr>
          </thead>
          <tbody>
            {flags.map((f) => (
              <tr key={f.id}>
                <td>{f.tourDate ?? "—"}</td>
                <td>{f.externalRef ?? f.bookingId}</td>
                <td>{KIND_LABEL[f.kind] ?? f.kind}</td>
                <td>{f.portalStatus}{f.kind === "PAX_MISMATCH" ? ` · ${f.portalPax}px` : ""}</td>
                <td>{f.channelStatus}{f.kind === "PAX_MISMATCH" ? ` · ${f.channelPax}px` : ""}</td>
                <td style={{ maxWidth: 360 }}>{f.action}</td>
                {canResolve && (
                  <td style={{ textAlign: "right" }}>
                    <button className="btn sm ghost" disabled={busy === f.id} onClick={() => resolve(f.id)}>
                      {busy === f.id ? "…" : "Resolve"}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
