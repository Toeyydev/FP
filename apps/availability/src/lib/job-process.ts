// Where a job is in the FolkOPS process, and who it is waiting for.
//
// The TO-BE flow (owner, 2026-10-11) is one process from a booking arriving to its cost
// being in the books:
//
//   Bókun booking → admin offers the job → guide accepts (or declines: back to the admin)
//   → guide prepares, checks in, conducts the tour, checks out and files the tour report
//   → the payout is calculated → admin reviews and approves → admin transfers and uploads
//   the slip (Unpaid → Paid) → the slip is filed in Drive → the accounting is in PEAK.
//
// Until now no single place said which of those steps a job had reached: the answer was
// spread over Booking, JobOffer, Assignment, Checkin, TourReport, JobSheet, the payment
// tables and the PEAK fields, and each screen joined the part it needed. In BPMN terms the
// process had tasks but no token. This is the token: ONE function, read by the process
// board, the job sheet and the mobile API, that turns those facts into a stage and a lane
// (who has to act). It decides nothing and stores nothing — every fact is still owned by
// the table that always owned it.
//
// Pure: no database, no network.

export type ProcessLane = "ADMIN" | "GUIDE" | "DONE";
export type ProcessStage =
  | "BOOKING_RECEIVED"   // guests on a departure, nobody offered or assigned
  | "OFFER_SENT"         // an offer is open — the guide has not answered
  | "OFFER_RETURNED"     // declined by everyone, or expired: back with the admin
  | "ASSIGNED"           // a guide holds the job; the tour has not started
  | "CHECKED_IN"         // the guide checked in today; the tour is running
  | "AWAITING_REPORT"    // the tour has started or passed and no tour report is in
  | "AWAITING_REVIEW"    // reported; the admin has not approved the job sheet
  | "AWAITING_TRANSFER"  // approved; not paid
  | "AWAITING_PEAK"      // paid; FolkOPS holds no PEAK document for it
  | "CLOSED";            // paid and in PEAK (or nothing to post)

export const PROCESS_STAGES: readonly ProcessStage[] = [
  "BOOKING_RECEIVED", "OFFER_SENT", "OFFER_RETURNED", "ASSIGNED", "CHECKED_IN",
  "AWAITING_REPORT", "AWAITING_REVIEW", "AWAITING_TRANSFER", "AWAITING_PEAK", "CLOSED",
];

export const STAGE_INFO: Record<ProcessStage, { lane: ProcessLane; label: string; th: string; next: string; nextTh: string }> = {
  BOOKING_RECEIVED:  { lane: "ADMIN", label: "Booking received",     th: "รับบุ๊คกิ้งแล้ว",        next: "Offer or assign the job to a guide",            nextTh: "มอบหมายงานให้ไกด์" },
  OFFER_SENT:        { lane: "GUIDE", label: "Offer sent",           th: "ส่งข้อเสนองานแล้ว",      next: "Guide accepts or declines",                     nextTh: "ไกด์ตอบรับหรือปฏิเสธ" },
  OFFER_RETURNED:    { lane: "ADMIN", label: "Offer came back",      th: "ข้อเสนอถูกปฏิเสธ/หมดอายุ", next: "Reassign — the offer was declined or expired",  nextTh: "มอบหมายใหม่ — ไกด์ปฏิเสธหรือหมดเวลา" },
  ASSIGNED:          { lane: "GUIDE", label: "Assigned",             th: "มอบหมายแล้ว",           next: "Guide prepares and checks in",                  nextTh: "ไกด์เตรียมตัวและเช็คอิน" },
  CHECKED_IN:        { lane: "GUIDE", label: "On tour",              th: "กำลังนำทัวร์",           next: "Guide conducts the tour, then checks out",      nextTh: "ไกด์นำทัวร์ แล้วเช็คเอาท์" },
  AWAITING_REPORT:   { lane: "GUIDE", label: "Waiting for the report", th: "รอรายงานทัวร์",        next: "Guide files the tour report and expenses",      nextTh: "ไกด์ส่งรายงานทัวร์และค่าใช้จ่าย" },
  AWAITING_REVIEW:   { lane: "ADMIN", label: "To review",            th: "รอตรวจและอนุมัติ",       next: "Review the expenses and approve the job sheet", nextTh: "ตรวจค่าใช้จ่ายและอนุมัติใบงาน" },
  AWAITING_TRANSFER: { lane: "ADMIN", label: "To pay",               th: "รอโอนเงิน",             next: "Transfer and upload the bank slip",             nextTh: "โอนเงินและอัปโหลดสลิป" },
  AWAITING_PEAK:     { lane: "ADMIN", label: "Paid · not in PEAK",   th: "จ่ายแล้ว รอลง PEAK",     next: "Put the payment into PEAK",                     nextTh: "ลงบัญชีใน PEAK" },
  CLOSED:            { lane: "DONE",  label: "Closed",               th: "จบงาน",                 next: "Nothing — paid and in the books",               nextTh: "เสร็จสิ้น — จ่ายแล้วและลงบัญชีแล้ว" },
};

export type JobProcessFacts = {
  /** Bangkok date of the tour and its start as minutes into the day. */
  date: string;
  startMin: number;
  /** Bangkok "now": date and minutes into the day. */
  today: string;
  nowMin: number;
  /** A guide holds the job (an Assignment row). */
  assigned: boolean;
  /** The latest offer for the departure, when nobody holds it. */
  offer?: { status: string; expired: boolean; everyoneDeclined: boolean } | null;
  /** Check-in types recorded for the job. */
  checkins?: readonly string[];
  /** A tour report is in, or the guide filed their expenses. */
  reported?: boolean;
  /** The job sheet exists and an operator has saved it (it carries a job number). */
  sheetSaved?: boolean;
  approved?: boolean;
  paid?: boolean;
  /** peakJobStatus(...).state for the job. */
  peak?: "IN_PEAK" | "NOT_IN_PEAK" | "NOTHING_TO_POST" | null;
};

/** Has the tour's start time passed (Bangkok)? */
export function tourStarted(f: Pick<JobProcessFacts, "date" | "startMin" | "today" | "nowMin">): boolean {
  return f.date < f.today || (f.date === f.today && f.nowMin >= f.startMin);
}

/**
 * The stage a job has reached. Read from the END of the process backwards, so the latest
 * thing that is true wins: a job that is paid is past review whether or not anyone filed a
 * report (historical jobs were paid from imported sheets with no report at all).
 */
export function jobStage(f: JobProcessFacts): ProcessStage {
  if (!f.assigned) {
    const o = f.offer;
    if (o && o.status === "OPEN" && !o.expired && !o.everyoneDeclined) return "OFFER_SENT";
    if (o && (o.status === "EXPIRED" || o.expired || o.everyoneDeclined)) return "OFFER_RETURNED";
    return "BOOKING_RECEIVED";
  }
  if (f.paid) return f.peak === "NOT_IN_PEAK" ? "AWAITING_PEAK" : "CLOSED";
  if (f.approved) return "AWAITING_TRANSFER";
  const types = f.checkins ?? [];
  if (f.reported || types.includes("COMPLETE")) return "AWAITING_REVIEW";
  // An operator already filled in the sheet for a tour that has run: it is theirs to review,
  // not the guide's to report (the guide may have told them by phone).
  if (f.sheetSaved && f.date < f.today) return "AWAITING_REVIEW";
  // Checked out: the tour is over; the report is the guide's next step.
  if (types.includes("END")) return "AWAITING_REPORT";
  if (f.date === f.today && (types.includes("ARRIVE") || types.includes("START"))) return "CHECKED_IN";
  if (tourStarted(f)) return "AWAITING_REPORT";
  return "ASSIGNED";
}

/** How far along the path a stage is, 0–1 — for a progress strip. OFFER_RETURNED sits with the offer. */
export function stageProgress(stage: ProcessStage): number {
  const path: ProcessStage[] = ["BOOKING_RECEIVED", "OFFER_SENT", "ASSIGNED", "CHECKED_IN", "AWAITING_REPORT", "AWAITING_REVIEW", "AWAITING_TRANSFER", "AWAITING_PEAK", "CLOSED"];
  const i = path.indexOf(stage === "OFFER_RETURNED" ? "OFFER_SENT" : stage);
  return i / (path.length - 1);
}

/** Where to go to do the next thing for a job at this stage. */
export function stageLink(stage: ProcessStage, job: { guideId: string | null; date: string; slotIdx: number; past: boolean }): string {
  const sheet = job.guideId ? `/job-sheet?guideId=${encodeURIComponent(job.guideId)}&date=${job.date}&slotIdx=${job.slotIdx}` : `/bookings?date=${job.date}`;
  switch (stage) {
    case "BOOKING_RECEIVED":
    case "OFFER_SENT":
    case "OFFER_RETURNED": return job.past ? `/bookings?date=${job.date}` : "/jobs";
    case "ASSIGNED":
    case "CHECKED_IN":
    case "AWAITING_REPORT": return job.past ? sheet : "/tour-log";
    case "AWAITING_REVIEW": return sheet;
    case "AWAITING_TRANSFER":
    case "AWAITING_PEAK": return "/payments";
    case "CLOSED": return sheet;
  }
}
