"use client";
import { useCallback, useEffect, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import { OperatorNav } from "@/components/OperatorNav";
import type { TourCard } from "@/lib/tours-today";

const hhmm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }) : "");
const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("th-TH", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const tag = (cls: string, text: string) => <span className={`ck ${cls}`}>{text}</span>;

function Card({ c, today }: { c: TourCard; today: boolean }) {
  const href = c.guideId ? `/job-sheet?guideId=${encodeURIComponent(c.guideId)}&date=${c.date}&slotIdx=${c.slotIdx}` : `/bookings?date=${c.date}`;
  const ck = !today || !c.guideId ? null
    : c.state === "COMPLETE" ? tag("ck-done", `จบทัวร์ ${hhmm(c.checkedAt)}`)
    : c.state === "END" ? tag("ck-done", `เช็คเอาท์ ${hhmm(c.checkedAt)}`)
    : c.state === "START" ? tag("ck-live", "กำลังนำทัวร์")
    : c.state === "ARRIVE" ? tag("ck-in", `เช็คอิน ${hhmm(c.checkedAt)}`)
    : c.overdue ? tag("ck-late", "ยังไม่เช็คอิน") : null;
  return (
    <a href={href} className="js-tour-card" style={{ display: "flex", gap: 12, padding: "10px 12px", border: "1px solid var(--line)", borderLeft: c.guideId ? "1px solid var(--line)" : "4px solid var(--danger)", borderRadius: 12, background: "var(--card,#fff)", textDecoration: "none", color: "inherit" }}>
      <b style={{ width: 46, flex: "none", color: "var(--green)" }}>{c.time}</b>
      <span style={{ flex: 1, minWidth: 0 }}>
        <b style={{ display: "block" }}>{c.tourName}</b>
        <span style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>{c.guideId ? `${c.guideId} ${c.guideName}` : "ยังไม่มีไกด์"} · {c.pax} pax</span>
        {(ck || !c.guideId || (today && c.arrived != null && c.pax > 0 && c.state)) && (
          <span style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 5 }}>
            {!c.guideId && tag("ck-late", "ไม่มีไกด์")}
            {ck}
            {today && c.guideId && c.arrived != null && c.pax > 0 && c.state && tag(c.arrived >= c.pax ? "ck-live" : "ck-in", `มาแล้ว ${c.arrived}/${c.pax}`)}
          </span>
        )}
      </span>
    </a>
  );
}

export default function ToursToday() {
  const [data, setData] = useState<{ today: string; tomorrow: string; cards: TourCard[] } | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(async () => {
    const r = await fetch("/api/ops/tours-today", { cache: "no-store" }).catch(() => null);
    if (!r || !r.ok) { setErr("โหลดไม่ได้ ลองใหม่"); return; }
    setErr(""); setData(await r.json());
  }, []);
  useEffect(() => { load(); const id = window.setInterval(load, 30000); return () => window.clearInterval(id); }, [load]);

  const day = (d: string, title: string, isToday: boolean) => {
    const cs = (data?.cards ?? []).filter((c) => c.date === d);
    return (
      <section className="panel js-tours-day" style={{ padding: "12px 14px" }}>
        <h2 style={{ fontSize: 16, margin: "0 0 10px", display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <span>{title} · {dayLabel(d)}</span>
          <span style={{ fontSize: 12.5, fontWeight: 400, color: "var(--ink-soft)" }}>{cs.length} รอบ · {cs.reduce((n, c) => n + c.pax, 0)} คน</span>
        </h2>
        {cs.length ? <div style={{ display: "grid", gap: 8 }}>{cs.map((c, i) => <Card key={i} c={c} today={isToday} />)}</div>
          : <div style={{ color: "var(--ink-soft)", fontSize: 13 }}>ไม่มีทัวร์</div>}
      </section>
    );
  };
  return (
    <div className="wrap">
      <AuthHeader home={false} />
      <div className="op-layout">
        <OperatorNav active="today" />
        <div className="op-main" style={{ maxWidth: 640 }}>
          {err && <div className="panel" style={{ color: "var(--danger)" }}>{err}</div>}
          {!data ? <div className="panel">Loading…</div> : (<>
            {day(data.today, "วันนี้", true)}
            {day(data.tomorrow, "พรุ่งนี้", false)}
          </>)}
        </div>
      </div>
    </div>
  );
}
