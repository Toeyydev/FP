"use client";

import { useEffect, useState } from "react";

// Bokun live-sync (webhook) health pill — green when the webhook fired recently,
// red "off" when silent. Surfaced on the operator home/dashboard so real-time
// health is visible at a glance. Polls the PII-free health probe every minute.
export default function LiveSyncBadge() {
  const [wh, setWh] = useState<{ lastWebhookAt: string | null } | null>(null);
  useEffect(() => {
    let on = true;
    const f = () => fetch("/api/bokun/health", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (on && d) setWh({ lastWebhookAt: d.lastWebhookAt ?? null }); })
      .catch(() => {});
    f();
    const id = window.setInterval(f, 60000);
    return () => { on = false; window.clearInterval(id); };
  }, []);
  if (!wh) return null;

  const last = wh.lastWebhookAt ? new Date(wh.lastWebhookAt).getTime() : 0;
  const mins = last ? Math.floor((Date.now() - last) / 60000) : Infinity;
  const live = !!last && mins < 60 * 24 * 3; // seen within 3 days
  const ago = !last ? "never" : mins < 1 ? "just now" : mins < 60 ? `${mins}m ago` : mins < 60 * 24 ? `${Math.floor(mins / 60)}h ago` : `${Math.floor(mins / 1440)}d ago`;

  return (
    <span role="status"
      aria-label={live ? `Live sync on, last event ${ago}` : "Live sync off — Bokun webhook silent, reconnect needed"}
      title={live ? "Bokun's webhook is delivering bookings & cancellations automatically." : "No recent webhook events — bookings only update when you press Sync. Reconnect the Bokun webhook."}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, padding: "3px 9px", borderRadius: 999, border: "1px solid", whiteSpace: "nowrap", borderColor: live ? "var(--ok-line, var(--line))" : "var(--danger-line)", background: live ? "var(--ok-bg, var(--surface))" : "var(--danger-bg)", color: live ? "var(--ok, #2f7d4f)" : "var(--danger)" }}>
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: 999, background: live ? "#2f9e54" : "var(--danger)" }} />
      {live ? `Live sync · ${ago}` : "Live sync off"}
    </span>
  );
}
