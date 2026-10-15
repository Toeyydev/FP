// The tour day on one job sheet: check-in, tour start, check-out, report — each with the
// time it was recorded, where the guide was when it was recorded, and whether the guide or
// an operator on their behalf pressed it. Shown to the guide and the operator alike: it is
// the evidence that the work in the TO-BE flow happened, and when.
//
// Nothing is invented. A step with no record shows as not recorded; a step recorded by an
// operator carries no location, because the operator was not there. Check-out is the
// COMPLETE check-in, which today is written when the guide files the tour report — so the
// two usually share a minute; the report is shown on its own line because it is its own
// document (no-shows, guests who left early). Since 2026-10-15 the guide checks out on its
// own (an END check-in, with GPS) before the report; a tour finished before that, or by a
// guide who went straight to the report, shows the COMPLETE time, marked as such.
//
// Pure: no database.

export type TimelineStepKey = "CHECK_IN" | "TOUR_START" | "CHECK_OUT" | "REPORT";
export type TimelineLocation = "AT_MEETING_POINT" | "AWAY" | "LOCATED" | "NO_LOCATION";
export type TimelineStep = {
  key: TimelineStepKey;
  label: string;
  th: string;
  at: string | null;
  /** Minutes after the scheduled start (negative = before it). Null when not recorded. */
  minutesFromStart: number | null;
  location: TimelineLocation | null;
  distanceM: number | null;
  /** Recorded by an operator on the guide's behalf, not by the guide. */
  byOperator: boolean;
  /** Extra facts for the report line: no-shows, guests who left early, guests who completed. */
  note: string | null;
};

export type CheckinRow = { type: string; at: Date | string; lat?: number | null; lng?: number | null; distanceM?: number | null; withinGeofence?: boolean | null; recordedByRole?: string | null };
export type ReportRow = { submittedAt: Date | string; noShow?: number | null; leftEarly?: number | null; completedPax?: number | null } | null;

const LABELS: Record<TimelineStepKey, { label: string; th: string }> = {
  CHECK_IN: { label: "Check-in", th: "เช็คอินที่จุดนัดพบ" },
  TOUR_START: { label: "Tour starts", th: "เริ่มทัวร์" },
  CHECK_OUT: { label: "Check-out", th: "เช็คเอาท์ · จบทัวร์" },
  REPORT: { label: "Report", th: "ส่งรายงานทัวร์" },
};
const TYPE_OF: Record<Exclude<TimelineStepKey, "REPORT">, string> = { CHECK_IN: "ARRIVE", TOUR_START: "START", CHECK_OUT: "END" };

/** "2026-10-16" + "08:30" Bangkok → the instant. */
export function scheduledStart(date: string, time: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  return new Date(`${date}T${time}:00+07:00`);
}

function locationOf(c: CheckinRow, byOperator: boolean): { location: TimelineLocation | null; distanceM: number | null } {
  if (byOperator) return { location: null, distanceM: null };
  if (c.withinGeofence === true) return { location: "AT_MEETING_POINT", distanceM: c.distanceM ?? null };
  if (c.withinGeofence === false) return { location: "AWAY", distanceM: c.distanceM ?? null };
  if (c.lat != null && c.lng != null) return { location: "LOCATED", distanceM: c.distanceM ?? null };
  return { location: "NO_LOCATION", distanceM: null };
}

export function tourDayTimeline(input: { checkins: readonly CheckinRow[]; report: ReportRow; start: Date | null }): TimelineStep[] {
  const mins = (at: Date | string) => (input.start ? Math.round((new Date(at).getTime() - input.start.getTime()) / 60_000) : null);
  const steps: TimelineStep[] = (["CHECK_IN", "TOUR_START", "CHECK_OUT"] as const).map((key) => {
    // The first record of each kind: a second press does not move when it happened.
    const first = (type: string) => input.checkins
      .filter((x) => x.type === type)
      .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())[0];
    // Check-out: the END check-in; with none, the COMPLETE written with the report.
    const viaReport = key === "CHECK_OUT" && !first("END") ? first("COMPLETE") : undefined;
    const c = viaReport ?? first(TYPE_OF[key]);
    if (!c) return { key, ...LABELS[key], at: null, minutesFromStart: null, location: null, distanceM: null, byOperator: false, note: null };
    const byOperator = !!c.recordedByRole && c.recordedByRole !== "GUIDE";
    return { key, ...LABELS[key], at: new Date(c.at).toISOString(), minutesFromStart: mins(c.at), ...locationOf(c, byOperator), byOperator, note: viaReport ? "Recorded with the report · บันทึกพร้อมรายงาน" : null };
  });
  const r = input.report;
  const facts = r ? [
    r.completedPax != null ? `${r.completedPax} completed` : "",
    r.noShow ? `${r.noShow} no-show` : "",
    r.leftEarly ? `${r.leftEarly} left early` : "",
  ].filter(Boolean).join(" · ") : "";
  steps.push({
    key: "REPORT", ...LABELS.REPORT, at: r ? new Date(r.submittedAt).toISOString() : null, minutesFromStart: r ? mins(r.submittedAt) : null,
    location: null, distanceM: null, byOperator: false, note: facts || null,
  });
  return steps;
}
