"use client";

import { useEffect, useState } from "react";
import type { ProcessLane, ProcessStage } from "@/lib/job-process";

// Where THIS job is on the path, on the job sheet: the steps in order, the one it stands on
// marked, and what has to happen next. Read from /api/process (lib/job-process) — the same
// answer the Job process board gives. `refresh` changes when the sheet is saved or approved.

type StageInfo = { stage: ProcessStage; lane: ProcessLane; label: string; th: string };
type Job = { stage: ProcessStage; lane: ProcessLane; label: string; th: string; next: string; nextTh: string };
const PATH: ProcessStage[] = ["BOOKING_RECEIVED", "OFFER_SENT", "ASSIGNED", "CHECKED_IN", "AWAITING_REPORT", "AWAITING_REVIEW", "AWAITING_TRANSFER", "AWAITING_PEAK", "CLOSED"];

export default function JobProcessStrip({ guideId, date, slotIdx, refresh }: { guideId: string; date: string; slotIdx: number; refresh?: string | null }) {
  const [job, setJob] = useState<Job | null>(null);
  const [stages, setStages] = useState<StageInfo[]>([]);
  useEffect(() => {
    let live = true;
    fetch(`/api/process?guideId=${encodeURIComponent(guideId)}&date=${date}&slotIdx=${slotIdx}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live && d) { setJob(d.job ?? null); setStages(d.stages ?? []); } })
      .catch(() => {});
    return () => { live = false; };
  }, [guideId, date, slotIdx, refresh]);
  if (!job) return null;
  const at = PATH.indexOf(job.stage);
  return (
    <div className="proc-strip no-print js-proc-strip" data-stage={job.stage} role="group" aria-label="Where this job is in the process">
      <ol>
        {PATH.map((s, i) => {
          const info = stages.find((x) => x.stage === s);
          return <li key={s} className={i < at ? "past" : i === at ? "now" : ""} title={info?.th}>{info?.label ?? s}</li>;
        })}
      </ol>
      <div className="proc-strip-next">
        <b>{job.lane === "DONE" ? "Done" : job.lane === "ADMIN" ? "Waiting on the admin" : "Waiting on the guide"}</b> — {job.next}
        <small> · {job.nextTh}</small>
        <a href="/process" style={{ marginLeft: 8 }}>All jobs →</a>
      </div>
    </div>
  );
}
