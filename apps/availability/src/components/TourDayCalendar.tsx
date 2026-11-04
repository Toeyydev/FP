"use client";

import { useEffect, useState } from "react";
import type { TourDayEntry } from "@/lib/tour-day";

// A small month calendar: a dot on each day with a tour, and below it who ran which
// tour on the day picked (lib/tour-day). Looking only; nothing here changes a job.

const pad = (n: number) => String(n).padStart(2, "0");
const monthOf = (d: string) => d.slice(0, 7);
const shift = (m: string, by: number) => { const [y, mo] = m.split("-").map(Number); const t = new Date(Date.UTC(y, mo - 1 + by, 1)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}`; };
const label = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

export default function TourDayCalendar({ date }: { date: string }) {
  const [picked, setPicked] = useState(date);
  const [month, setMonth] = useState(monthOf(date));
  const [days, setDays] = useState<Record<string, TourDayEntry[]> | null>(null);
  const [error, setError] = useState("");

  useEffect(() => { setPicked(date); setMonth(monthOf(date)); }, [date]);
  useEffect(() => {
    let live = true;
    setDays(null); setError("");
    fetch(`/api/tour-day?month=${month}`, { cache: "no-store" })
      .then(async (r) => { const d = await r.json().catch(() => ({})); if (!live) return; if (!r.ok) setError("Could not load who guided."); else setDays(d.days ?? {}); })
      .catch(() => { if (live) setError("Could not load who guided."); });
    return () => { live = false; };
  }, [month]);

  const [y, m] = month.split("-").map(Number);
  const first = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7; // Monday first
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells = [...Array(first).fill(null), ...Array.from({ length: count }, (_, i) => `${month}-${pad(i + 1)}`)];
  const list = days?.[picked] ?? [];

  return (
    <div className="js-tour-day" style={{ display: "grid", gap: 8, maxWidth: 360 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button type="button" className="btn sm ghost js-cal-prev" aria-label="Previous month" onClick={() => setMonth(shift(month, -1))}>‹</button>
        <b style={{ fontSize: 14 }}>{label(month)}</b>
        <button type="button" className="btn sm ghost js-cal-next" aria-label="Next month" onClick={() => setMonth(shift(month, 1))}>›</button>
      </div>
      <div role="grid" style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, textAlign: "center", fontSize: 12 }}>
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => <span key={i} style={{ color: "var(--ink-soft)" }}>{d}</span>)}
        {cells.map((d, i) => d === null ? <span key={`b${i}`} /> : (
          <button key={d} type="button" className={`js-cal-day${d === picked ? " on" : ""}`} data-date={d} aria-pressed={d === picked} onClick={() => setPicked(d)}
            style={{ border: d === picked ? "1px solid var(--ink)" : "1px solid transparent", borderRadius: 6, background: "transparent", padding: "4px 0", minHeight: 32, cursor: "pointer", font: "inherit", color: "inherit" }}>
            {Number(d.slice(8))}
            <span aria-hidden style={{ display: "block", height: 4, width: 4, margin: "1px auto 0", borderRadius: 2, background: days?.[d]?.length ? "var(--ink-soft)" : "transparent" }} />
          </button>
        ))}
      </div>
      <div className="js-cal-list" style={{ fontSize: 13, display: "grid", gap: 4 }}>
        <b style={{ fontSize: 13 }}>{dayLabel(picked)}</b>
        {error ? <span style={{ color: "var(--danger,#b3402f)" }}>{error}</span>
          : days === null ? <span style={{ color: "var(--ink-soft)" }}>Loading…</span>
          : monthOf(picked) !== month ? <span style={{ color: "var(--ink-soft)" }}>Pick a day in {label(month)}.</span>
          : !list.length ? <span style={{ color: "var(--ink-soft)" }}>No tours.</span>
          : list.map((e, i) => (
            <div key={i} style={{ display: "flex", gap: 8 }}>
              <span style={{ minWidth: 42, fontVariantNumeric: "tabular-nums" }}>{e.time}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                {e.guideName ? <b>{e.guideName}</b> : <span style={{ color: "var(--danger,#b3402f)" }}>No guide</span>}
                <span style={{ color: "var(--ink-soft)" }}> · {e.tourName} · {e.pax} pax</span>
              </span>
            </div>
          ))}
      </div>
    </div>
  );
}
