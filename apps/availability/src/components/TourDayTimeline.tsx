"use client";

import type { TimelineStep } from "@/lib/tour-day-timeline";

// Check-in → tour starts → check-out → report, with the time each was recorded, how it
// compares with the scheduled start, and where the guide was. The guide and the operator
// see the same line (lib/tour-day-timeline).

const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Bangkok" });
const vsStart = (m: number | null) => (m == null ? "" : m === 0 ? "on time" : m > 0 ? `${m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`} after start` : `${-m >= 60 ? `${Math.floor(-m / 60)} h ${-m % 60} min` : `${-m} min`} before start`);
const where = (s: TimelineStep) =>
  s.byOperator ? { text: "Recorded by the operator", th: "Operator บันทึกแทน", tone: "muted" }
    : s.location === "AT_MEETING_POINT" ? { text: `At the meeting point${s.distanceM != null ? ` · ${s.distanceM} m` : ""}`, th: "อยู่ที่จุดนัดพบ", tone: "ok" }
    : s.location === "AWAY" ? { text: `Away from the meeting point${s.distanceM != null ? ` · ${s.distanceM >= 1000 ? `${(s.distanceM / 1000).toFixed(1)} km` : `${s.distanceM} m`}` : ""}`, th: "ไม่ได้อยู่ที่จุดนัดพบ", tone: "warn" }
    : s.location === "LOCATED" ? { text: "Location recorded", th: "บันทึกตำแหน่งแล้ว", tone: "muted" }
    : s.location === "NO_LOCATION" ? { text: "No location", th: "ไม่มีตำแหน่ง GPS", tone: "muted" }
    : null;

const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`);

// On screen: the step, its time, and a short red note only when the guide was away from
// the meeting point. Everything else (vs. the start, where, who recorded it, the report's
// facts) is in the step's tooltip.
export default function TourDayTimeline({ steps, scheduled, date }: { steps: TimelineStep[]; scheduled: string | null; date: string }) {
  if (!steps.length) return null;
  const done = steps.filter((s) => s.at).length;
  return (
    <section className="panel tday js-tour-day" aria-label="Tour day timeline">
      <div className="tday-head">
        <b>Tour day</b>
        <span className="tday-sched" title={`${done} of ${steps.length} recorded`}>Starts {scheduled ?? "—"}</span>
      </div>
      <ol className="tday-steps">
        {steps.map((s) => {
          const w = where(s);
          const meta = [vsStart(s.minutesFromStart), s.note].filter(Boolean).join(" · ");
          const tip = s.at ? [s.th, meta, w?.text].filter(Boolean).join(" · ") : `${s.th} · Not recorded`;
          return (
            <li key={s.key} className={`tday-step${s.at ? " done" : ""}`} data-step={s.key} title={tip}>
              <span className="tday-dot" aria-hidden="true">{s.at ? "✓" : ""}</span>
              <span className="tday-label">{s.label}</span>
              {s.at
                ? <span className="tday-time"><span className="num js-tday-time">{time(s.at)}</span>{s.at.slice(0, 10) !== date ? <small> {day(s.at)}</small> : null}</span>
                : <span className="tday-time tday-missing">--:--</span>}
              {s.at && w?.tone === "warn" ? <span className="tday-away">⚠ {s.distanceM != null ? `${km(s.distanceM)} away` : "Away"}</span> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
