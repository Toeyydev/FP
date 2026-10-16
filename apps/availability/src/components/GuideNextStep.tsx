"use client";

import { useState } from "react";
import type { TimelineStep } from "@/lib/tour-day-timeline";

// The guide's one big button on their job sheet (Idea B): the next step of the tour day —
// check in → start → check out → file the report. Check-in, start and check-out post the
// same lifecycle event the home screen does (api/checkin, with GPS when the phone gives
// it); the report opens the one report form on the home screen. Nothing shows before the
// tour day, once the report is in, or once the job is paid.

const OPENS_BEFORE_MIN = 45; // lib/guide-lifecycle CHECKIN_OPENS_BEFORE_MS

type Next = { type: "ARRIVE" | "START" | "END" | "REPORT"; label: string; th: string; hint: string };
const NEXT: Record<string, Next> = {
  CHECK_IN: { type: "ARRIVE", label: "Check in", th: "เช็คอินที่จุดนัดพบ", hint: "At the meeting point? Tap to send your location." },
  TOUR_START: { type: "START", label: "Start the tour", th: "เริ่มทัวร์", hint: "Guests here? Start the tour." },
  CHECK_OUT: { type: "END", label: "End the tour · check out", th: "จบทัวร์", hint: "Guests dropped off? Check out." },
  REPORT: { type: "REPORT", label: "File the tour report", th: "ส่งรายงานทัวร์", hint: "Who came, and what you paid." },
};

export default function GuideNextStep({ steps, date, slotIdx, time, tourName, pax, paid, onDone }: {
  steps: TimelineStep[]; date: string; slotIdx: number; time: string | null; tourName: string; pax: number | null; paid: boolean; onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const todayBkk = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const step = steps.find((s) => !s.at);
  if (paid || !step || date > todayBkk) return null;
  const next = NEXT[step.key];
  if (!next) return null;

  const [h, m] = (time || "00:00").split(":").map(Number);
  const startMs = Date.parse(`${date}T00:00:00Z`) + (h * 60 + m) * 60_000 - 7 * 3600_000;
  const opensMs = startMs - OPENS_BEFORE_MIN * 60_000;
  const notYet = next.type === "ARRIVE" && Date.now() < opensMs;
  const opensAt = new Date(opensMs).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });

  async function go() {
    if (next.type === "REPORT") {
      window.location.href = `/?report=${date}:${slotIdx}&tour=${encodeURIComponent(tourName)}&pax=${pax ?? ""}`;
      return;
    }
    setBusy(true); setErr("");
    const post = async (lat?: number, lng?: number, accuracyM?: number) => {
      const r = await fetch("/api/checkin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ date, slotIdx, type: next.type, lat, lng, accuracyM }) });
      const d = await r.json().catch(() => ({}));
      setBusy(false);
      if (r.ok) { onDone(); return; }
      setErr(d.error === "too-early" ? `Check-in opens at ${opensAt} · เช็คอินได้ตั้งแต่ ${opensAt}`
        : d.error === "not-started" ? "Start the tour first · กดเริ่มทัวร์ก่อน"
        : d.error === "already-ended" ? "Already checked out · เช็คเอาท์แล้ว"
        : "Not recorded — try again · ยังไม่ได้บันทึก ลองอีกครั้ง");
    };
    if (typeof navigator !== "undefined" && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (p) => void post(p.coords.latitude, p.coords.longitude, Math.round(p.coords.accuracy)),
        () => void post(), { enableHighAccuracy: true, timeout: 8000 },
      );
    } else await post();
  }

  return (
    <section className="panel gns no-print" aria-label="Your next step" data-next={next.type}>
      <span className="gns-hint">{notYet ? `Check-in opens at ${opensAt} · เช็คอินได้ตั้งแต่ ${opensAt}` : next.hint}</span>
      <button type="button" className="btn primary gns-btn js-next-step" disabled={busy || notYet} onClick={go}>
        {busy ? "…" : next.label}<small>{next.th}</small>
      </button>
      {err && <span className="gns-err" role="alert">{err}</span>}
    </section>
  );
}
