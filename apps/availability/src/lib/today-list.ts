// The dashboard's Today list: what each of today's tours needs from the operator, in
// one word. Pure — the dashboard passes the minute of the day in Bangkok.
//
//   LATE  — start time passed and the guide has not checked in
//   LIVE  — checked in / started, not checked out yet
//   DONE  — checked out (report missing) or reported
//   LATER — has not started yet

export type TodayKind = "LATE" | "LIVE" | "DONE" | "LATER";
export type TodayTour = { time: string; state: string; checkedAt: string | null; overdue: boolean; report: unknown | null };
export type TodayView = { kind: TodayKind; steps: number; chip: string; tone: "bad" | "ok" | "warn" | "mut"; rel: string };

const minOf = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return (h || 0) * 60 + (m || 0); };
export const span = (min: number) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60}` : ""}`);
const bkkTime = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });

export function todayView(t: TodayTour, nowMin: number): TodayView {
  const start = minOf(t.time);
  // check-in · start · check-out · report
  const steps = t.report ? 4 : t.state === "END" || t.state === "COMPLETE" ? 3 : t.state === "START" ? 2 : t.state === "ARRIVE" ? 1 : 0;
  if (t.report || t.state === "COMPLETE") return { kind: "DONE", steps, chip: "✓ Reported", tone: "mut", rel: "" };
  if (t.state === "END") return { kind: "DONE", steps, chip: "Report missing", tone: "warn", rel: "" };
  if (t.state === "START") return { kind: "LIVE", steps, chip: "● On tour", tone: "ok", rel: nowMin > start ? `${span(nowMin - start)} ago` : "" };
  if (t.state === "ARRIVE") return { kind: "LIVE", steps, chip: `✓ Checked in${t.checkedAt ? ` ${bkkTime(t.checkedAt)}` : ""}`, tone: "ok", rel: nowMin > start ? `${span(nowMin - start)} ago` : nowMin < start ? `in ${span(start - nowMin)}` : "now" };
  if (t.overdue || nowMin >= start) return { kind: "LATE", steps, chip: "⚠ Not checked in", tone: "bad", rel: nowMin > start ? `${span(nowMin - start)} late` : "now" };
  return { kind: "LATER", steps, chip: "Later", tone: "mut", rel: `in ${span(start - nowMin)}` };
}

export const bangkokMinute = (now = Date.now()) => { const d = new Date(now + 7 * 3600 * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
