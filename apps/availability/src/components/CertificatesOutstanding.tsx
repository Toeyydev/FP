"use client";

import { useEffect, useMemo, useState } from "react";
import OperatorNav from "@/components/OperatorNav";
import type { OutstandingJob } from "@/lib/certificates/outstanding";

// Jobs that still need a certificate in lieu of receipt (lib/certificates/outstanding):
// rows the guide paid, or paid from a company advance, with no ticket or receipt — and no
// LINKED certificate of that kind yet. Each row opens its job sheet, where the certificate
// is made.

const KIND: Record<OutstandingJob["kind"], string> = { GUIDE_PAID: "ไกด์สำรองจ่าย", COMPANY_ADVANCE: "จ่ายจากเงินทดรอง" };
const STATUS_TH: Record<string, string> = { DRAFT: "ร่าง", READY_TO_ATTEST: "รอรับรอง", ATTESTED: "รับรองแล้ว · รอเก็บใน Drive", UPLOADED: "เก็บใน Drive แล้ว · รอ link" };
const thb = (s: number) => `฿${(s / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function CertificatesOutstanding() {
  const [jobs, setJobs] = useState<OutstandingJob[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"NOT_ISSUED" | "IN_PROGRESS">("NOT_ISSUED");
  useEffect(() => {
    fetch("/api/admin/certificates-outstanding", { cache: "no-store" })
      .then(async (r) => { if (!r.ok) throw new Error(`Could not load the list (HTTP ${r.status})`); return r.json(); })
      .then((d) => setJobs(d.jobs as OutstandingJob[]))
      .catch((e) => setErr(String((e as Error).message)));
  }, []);
  const shown = useMemo(() => (jobs ?? []).filter((j) => j.state === tab), [jobs, tab]);
  const count = (s: OutstandingJob["state"]) => (jobs ?? []).filter((j) => j.state === s).length;

  return (
    <div className="op-layout">
      <OperatorNav active="certificates" />
      <div className="op-main">
        <div className="subtabs">
          <button type="button" className={`subtab${tab === "NOT_ISSUED" ? " active" : ""}`} onClick={() => setTab("NOT_ISSUED")}>ยังไม่ออกใบรับรอง ({count("NOT_ISSUED")})</button>
          <button type="button" className={`subtab${tab === "IN_PROGRESS" ? " active" : ""}`} onClick={() => setTab("IN_PROGRESS")}>กำลังดำเนินการ ({count("IN_PROGRESS")})</button>
        </div>
        <section className="panel">
          <div className="panel-head"><h2>ใบรับรองแทนใบเสร็จรับเงินที่ต้องออก</h2>
            <span className="hint">งานที่มีรายการไม่มีตั๋วหรือใบเสร็จ และยังไม่มีใบรับรองที่ link แล้ว · เปิดใบงานเพื่อสร้างใบรับรอง</span>
          </div>
          {err && <div className="banner danger" role="alert">{err}</div>}
          {!jobs && !err && <div className="skel-row" />}
          {jobs && (
            <div className="tablewrap">
              <table className="adv-table js-cert-outstanding">
                <thead><tr><th>Job No.</th><th>วันที่</th><th>ไกด์</th><th>ทัวร์</th><th>ประเภท</th><th className="r">รายการ</th><th className="r">จำนวนเงิน</th><th>สถานะ</th><th /></tr></thead>
                <tbody>
                  {shown.length === 0 && <tr><td colSpan={9} className="muted">{tab === "NOT_ISSUED" ? "ไม่มีงานที่ค้างออกใบรับรอง" : "ไม่มีใบรับรองที่กำลังดำเนินการ"}</td></tr>}
                  {shown.map((j) => (
                    <tr key={`${j.guideId}|${j.date}|${j.slotIdx}|${j.kind}`} data-kind={j.kind}>
                      <td className="mono" style={{ fontSize: 12 }}>{j.jobRef ?? "—"}</td>
                      <td>{j.date}</td>
                      <td>{j.guideId}</td>
                      <td>{j.tourName ?? "—"}</td>
                      <td>{KIND[j.kind]}</td>
                      <td className="r">{j.rows}</td>
                      <td className="r">{thb(j.totalSatang)}</td>
                      <td>{j.state === "NOT_ISSUED" ? (j.approved ? "ยังไม่ออก" : "ยังไม่ออก · ใบงานยังไม่อนุมัติ") : `${j.certificateNo} · ${STATUS_TH[j.certificateStatus ?? ""] ?? j.certificateStatus}`}</td>
                      <td><a className="btn sm" href={`/job-sheet?guideId=${encodeURIComponent(j.guideId)}&date=${j.date}&slotIdx=${j.slotIdx}`}>เปิดใบงาน</a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
