"use client";
import { useCallback, useEffect, useState } from "react";

// Issuing and certifying a certificate in lieu of a receipt, from the job sheet.
//
// The wording on this panel is deliberate. Pressing the button is รับรองเอกสารทาง
// อิเล็กทรอนิกส์ — an authenticated person accepting a document, recorded with their
// name, their role and the moment. It is not a digital signature: no key signs anything,
// and calling it one would promise a guarantee that is not here. A repository test
// refuses the other phrasing outright.
//
// Nothing on this panel sends who the approver is. The server reads that from the
// session, so what is typed in a browser cannot put somebody else's name on a document.

type Covered = { index: number; description: string; pax: number; price: number; amountSatang: number };
type Certificate = {
  id: string; certificateNo: string; status: string; label: string; labelTh: string; isEvidence: boolean;
  totalSatang: number; payloadHash: string; pdfHash: string | null; driveUrl: string | null;
  attestedByName: string | null; attestedByRole: string | null; attestedAt: string | null;
  uploadedAt: string | null; linkedAt: string | null; voidedAt: string | null; voidReason: string | null;
  coveredRows: Covered[];
  peak: PeakView;
  attachments: Attachment[];
};
type PeakLink = {
  paymentRef: string | null; documentNo: string | null; documentId: string | null;
  documentLink: string | null; source: "COMBINED_PAYMENT" | "JOB_SHEET_SYNC";
  paidDate: string | null; jobCount: number;
};
type PeakView = { link: PeakLink | null; recorded: boolean; reason: string | null; conflict: string | null };
type Attachment = {
  id: string; state: string; requestEncoding: string | null; peakResCode: string | null; peakResDesc: string | null;
  attemptedAt: string | null; resolvedById: string | null; resolvedAt: string | null; resolutionNote: string | null;
  peakDocumentNo: string | null; fileName: string;
};
/** The whole job's money. Beside the certificate for checking, never part of it. */
type Reconciliation = {
  guideFeeGross: number; reviewReward: number; whtBase: number; whtOnFee: number; whtOnReview: number;
  wht: number; reimbursementTotal: number; netTransfer: number; certificateCoversSatang: number;
};
type Info = {
  ok: true; jobRef: string | null; guideReportedAt: string | null;
  rowsNeedingCertificate: Covered[]; totalSatang: number; canIssue: boolean; blockers: string[];
  certificates: Certificate[];
  attachEnabled: boolean;
  reconciliation: Reconciliation;
};

const thb = (satang: number) => `฿${(satang / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }) : "—");
const short = (h: string | null | undefined) => (h ?? "").slice(0, 12);

const baht = (n: number) => `฿${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What each attachment state means, in the words of the person who has to act on it. */
const ATTACH_TH: Record<string, { label: string; tone: string; note: string }> = {
  CLAIMED: { label: "กำลังแนบ", tone: "#0369a1", note: "เริ่มส่งไฟล์แล้ว ยังไม่มีคำตอบจาก PEAK" },
  PEAK_ACCEPTED: { label: "PEAK ตอบรับ · รอตรวจ", tone: "#b45309", note: "PEAK ตอบรหัส 200 แต่ PEAK ไม่มี API ให้อ่านไฟล์กลับ จึงยังยืนยันไม่ได้ว่าไฟล์อยู่ในเอกสารจริง — เปิด PEAK แล้วบันทึกสิ่งที่เห็น" },
  REFUSED: { label: "PEAK ปฏิเสธ", tone: "#b91c1c", note: "PEAK ปฏิเสธในแบบที่แน่ใจได้ว่าไม่มีไฟล์ถูกเก็บ ส่งใหม่ได้" },
  ATTACHMENT_UNCERTAIN: { label: "ไม่ทราบผล · ต้องตรวจ", tone: "#b45309", note: "คำขอไม่สำเร็จหรือได้คำตอบที่อ่านไม่ได้ ไฟล์อาจถูกแนบหรือไม่ก็ได้ ระบบจะไม่ส่งซ้ำอัตโนมัติ — เปิด PEAK แล้วบันทึกสิ่งที่เห็น" },
  ATTACHED_CONFIRMED: { label: "แนบแล้ว · ยืนยันโดยผู้ตรวจ", tone: "#2f7d4f", note: "มีผู้ดูแลเปิดเอกสารใน PEAK และเห็นไฟล์นี้" },
  NOT_FOUND_IN_PEAK: { label: "ไม่พบไฟล์ใน PEAK", tone: "#b91c1c", note: "มีผู้ดูแลเปิดเอกสารใน PEAK แล้วไม่พบไฟล์" },
};

const TONE: Record<string, string> = {
  DRAFT: "#78716c", READY_TO_ATTEST: "#b45309", ATTESTED: "#0369a1",
  UPLOADED: "#0369a1", LINKED: "#2f7d4f", VOID: "#b91c1c",
};

export default function ExpenseCertificatePanel({ guideId, date, slotIdx, isAdmin, onChanged }: {
  guideId: string; date: string; slotIdx: number; isAdmin: boolean; onChanged?: () => void;
}) {
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>("");
  const [confirmed, setConfirmed] = useState(false);
  const [preview, setPreview] = useState(false);

  // Nothing is even asked for unless the reader is an admin. The endpoint refuses anyone
  // else and the panel is not mounted for them, but a component that fetches on mount is
  // one prop away from being mounted somewhere it should not be, and a 403 in the network
  // tab of a guide's browser still says a certificate exists.
  const load = useCallback(async () => {
    if (!isAdmin) { setInfo(null); return; }
    const r = await fetch(`/api/jobsheet/certificate?guideId=${encodeURIComponent(guideId)}&date=${date}&slotIdx=${slotIdx}`);
    if (!r.ok) { setInfo(null); return; }
    setInfo(await r.json());
  }, [guideId, date, slotIdx, isAdmin]);

  useEffect(() => { void load(); }, [load]);

  // Whatever was passed in, this panel draws nothing for a non-admin. The number, the
  // hashes, the Drive link and the attester's name are all admin-only, so there is no
  // partial view of it worth rendering.
  if (!isAdmin) return null;

  const act = async (url: string, body: object, ok: string) => {
    setBusy(true); setMsg("");
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg((d.reasons ?? []).join(" ") || "That did not work."); return false; }
    setMsg(ok); setConfirmed(false);
    await load(); onChanged?.();
    return true;
  };

  if (!info) return null;
  const live = info.certificates.find((c) => c.status !== "VOID") ?? null;
  const rows = live ? live.coveredRows : info.rowsNeedingCertificate;
  const total = live ? live.totalSatang : info.totalSatang;
  if (!rows.length && !info.certificates.length) return null;

  return (
    <section className="card" style={{ marginTop: 14 }}>
      <h3 style={{ margin: "0 0 2px", fontSize: 14 }}>ใบรับรองแทนใบเสร็จรับเงิน</h3>
      <div style={{ fontSize: 11.5, color: "var(--muted,#78716c)", marginBottom: 10 }}>
        สำหรับค่าใช้จ่ายที่ไกด์สำรองจ่ายและผู้ให้บริการไม่ออกใบเสร็จ · ใช้เป็นหลักฐานประกอบการบันทึกบัญชีภายใน ไม่ใช่ใบกำกับภาษี
      </div>

      {info.guideReportedAt && (
        <div style={{ fontSize: 11.5, marginBottom: 8 }}>
          ไกด์ส่งรายงานค่าใช้จ่ายผ่านบัญชีของตนเมื่อ <b>{when(info.guideReportedAt)}</b>
        </div>
      )}

      {rows.length > 0 && (
        <>
          <button type="button" className="btn sm" onClick={() => setPreview((p) => !p)} style={{ marginBottom: 6 }}>
            {preview ? "ซ่อนรายการ" : `ดูรายการ ${rows.length} รายการ · ${thb(total)}`}
          </button>
          {preview && (
            <div className="grid-scroll">
              <table className="acct-table" aria-label="รายการที่ไม่มีใบเสร็จ">
                <thead><tr><th style={{ width: 36 }}>ที่</th><th>รายการ</th><th style={{ width: 60 }}>จำนวน</th><th className="r" style={{ width: 90 }}>จำนวนเงิน</th></tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={`${r.index}-${r.description}`}>
                      <td className="num">{i + 1}</td><td>{r.description}</td>
                      <td className="num">{r.pax}</td><td className="r num">{thb(r.amountSatang)}</td>
                    </tr>
                  ))}
                  <tr><td colSpan={3} className="r"><b>รวม</b></td><td className="r num"><b>{thb(total)}</b></td></tr>
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {info.blockers.length > 0 && !live && (
        <ul style={{ margin: "8px 0", paddingLeft: 18, fontSize: 11.5, color: "#b45309" }}>
          {info.blockers.map((b) => <li key={b}>{b}</li>)}
        </ul>
      )}

      {live && (
        <div style={{ border: "1px solid var(--line,#e7e5e4)", borderRadius: 6, padding: "8px 10px", marginTop: 8, fontSize: 11.5 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
            <b>{live.certificateNo}</b>
            <span style={{ color: TONE[live.status] ?? "#78716c", fontWeight: 700 }}>{live.labelTh}</span>
          </div>
          {live.attestedAt && (
            <div style={{ marginTop: 4 }}>
              รับรองโดย <b>{live.attestedByName}</b> ({live.attestedByRole}) เมื่อ {when(live.attestedAt)}
            </div>
          )}
          <div style={{ marginTop: 4, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 10.5, color: "var(--muted,#78716c)" }}>
            ลายนิ้วมือข้อมูลต้นทาง {short(live.payloadHash)}…{live.pdfHash ? ` · ไฟล์ ${short(live.pdfHash)}…` : ""}
          </div>
          {live.driveUrl && <div style={{ marginTop: 4 }}><a href={live.driveUrl} target="_blank" rel="noopener noreferrer">เปิดเอกสารใน Drive</a></div>}
          {!live.isEvidence && (
            <div style={{ marginTop: 6, color: "#b45309" }}>
              ยังใช้เป็นหลักฐานไม่ได้จนกว่าจะผูกกับรายการในใบงานเรียบร้อย
            </div>
          )}
        </div>
      )}

      {/* Which PEAK document this certificate accompanies.

          Everything here was recorded by the payment itself — the job sheet's own key,
          the FOLK-PAY reference the transfer wrote, and the EXP PEAK gave back. Nothing
          is matched by a guide's name or a nearby date, and issuing a certificate creates
          no PEAK document and changes no amount on the one it names. */}
      {live && (
        <div style={{ border: "1px solid var(--line,#e7e5e4)", borderRadius: 6, padding: "8px 10px", marginTop: 8, fontSize: 11.5 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>เอกสารอ้างอิง</div>
          <table className="acct-table" style={{ width: "100%", fontSize: 11.5 }}>
            <tbody>
              <tr><th style={{ textAlign: "left", fontWeight: 600, color: "var(--muted,#78716c)", width: "42%" }}>ใบงานเลขที่</th><td>{info.jobRef ?? "—"}</td></tr>
              <tr><th style={{ textAlign: "left", fontWeight: 600, color: "var(--muted,#78716c)" }}>ใบรับรองเลขที่</th><td>{live.certificateNo}</td></tr>
              <tr><th style={{ textAlign: "left", fontWeight: 600, color: "var(--muted,#78716c)" }}>อ้างอิงการจ่าย</th><td className="mono">{live.peak?.link?.paymentRef ?? "—"}</td></tr>
              <tr><th style={{ textAlign: "left", fontWeight: 600, color: "var(--muted,#78716c)" }}>เอกสาร PEAK</th><td className="mono">{live.peak?.link?.documentNo ?? "—"}</td></tr>
              <tr><th style={{ textAlign: "left", fontWeight: 600, color: "var(--muted,#78716c)" }}>วันที่จ่ายจริง</th><td>{live.peak?.link?.paidDate ?? "ยังไม่จ่าย"}</td></tr>
            </tbody>
          </table>

          {live.peak?.link && live.peak?.link.jobCount > 1 && (
            <div style={{ marginTop: 4, color: "var(--muted,#78716c)" }}>
              เอกสาร PEAK ฉบับนี้ครอบคลุม {live.peak?.link.jobCount} ใบงานในการโอนครั้งเดียว แต่ละใบงานมีใบรับรองของตัวเองได้
            </div>
          )}
          {live.peak?.link?.documentLink && (
            <div style={{ marginTop: 4 }}><a href={live.peak?.link.documentLink} target="_blank" rel="noopener noreferrer">เปิดเอกสารใน PEAK</a></div>
          )}
          {live.peak?.conflict && (
            <div style={{ marginTop: 6, color: "#b91c1c" }}>{live.peak?.reason}</div>
          )}
          {!live.peak?.link && !live.peak?.conflict && (
            <div style={{ marginTop: 4, color: "var(--muted,#78716c)" }}>{live.peak?.reason}</div>
          )}

          {/* Attaching the PDF. Off by default, and while it is off the honest thing to
              offer is the two links a person needs to do it by hand. */}
          {(live.attachments ?? []).length > 0 ? (
            <div style={{ marginTop: 6 }}>
              {(live.attachments ?? []).map((a) => {
                const m = ATTACH_TH[a.state] ?? { label: a.state, tone: "#78716c", note: "" };
                return (
                  <div key={a.id} style={{ marginTop: 4 }}>
                    <span style={{ color: m.tone, fontWeight: 700 }}>{m.label}</span>
                    {a.attemptedAt && <span style={{ color: "var(--muted,#78716c)" }}> · {when(a.attemptedAt)}</span>}
                    {a.peakResCode && <span style={{ color: "var(--muted,#78716c)" }}> · PEAK {a.peakResCode}</span>}
                    {a.requestEncoding && <span style={{ color: "var(--muted,#78716c)" }}> · {a.requestEncoding}</span>}
                    <div style={{ color: "var(--muted,#78716c)" }}>{m.note}</div>
                  </div>
                );
              })}
            </div>
          ) : live.peak?.link && live.isEvidence ? (
            <div style={{ marginTop: 6 }}>
              <div style={{ color: "var(--muted,#78716c)" }}>
                {info.attachEnabled
                  ? "ยังไม่ได้แนบไฟล์กับเอกสาร PEAK"
                  : "ระบบยังไม่เปิดการแนบไฟล์เข้า PEAK อัตโนมัติ — เปิดทั้งสองอย่างแล้วแนบด้วยมือใน PEAK"}
              </div>
              {/* Both doors, side by side, because doing this by hand means having the
                  PDF and the document open at once. Split across two boxes it reads as
                  two unrelated links. */}
              <div style={{ marginTop: 4, display: "flex", gap: 6, flexWrap: "wrap" }}>
                {live.driveUrl && <a className="btn sm" href={live.driveUrl} target="_blank" rel="noopener noreferrer">เปิดไฟล์ใบรับรอง (PDF)</a>}
                {live.peak?.link?.documentLink
                  ? <a className="btn sm" href={live.peak.link.documentLink} target="_blank" rel="noopener noreferrer">เปิดเอกสาร PEAK</a>
                  : <span className="btn sm ghost" aria-disabled="true" title={`ค้นหา ${live.peak?.link?.documentNo ?? ""} ใน PEAK`}>ค้นหา {live.peak?.link?.documentNo} ใน PEAK</span>}
              </div>
            </div>
          ) : null}
        </div>
      )}

      {/* Reconciliation — beside the certificate, never part of it.

          The EXP holds the whole job: the fee, the review reward, the withholding and the
          reimbursement. The certificate covers the unreceipted reimbursement only, which
          is why the two totals differ and why PEAK's own printout of the EXP cannot serve
          as evidence for the part with no receipt. These figures are here so an admin can
          check that difference without opening another page, and they are labelled so
          nobody mistakes them for something the certificate says. */}
      {live && info.reconciliation && (
        <details style={{ marginTop: 8, fontSize: 11.5 }}>
          <summary style={{ cursor: "pointer", color: "var(--muted,#78716c)" }}>
            ข้อมูลประกอบการกระทบยอด — ไม่ใช่ส่วนหนึ่งของใบรับรอง
          </summary>
          <table className="acct-table" style={{ width: "100%", marginTop: 6, fontSize: 11.5 }}>
            <tbody>
              <tr><td>ค่าจ้างไกด์</td><td className="r num">{baht(info.reconciliation?.guideFeeGross ?? 0)}</td></tr>
              <tr><td>ค่าตอบแทนรีวิว</td><td className="r num">{baht(info.reconciliation?.reviewReward ?? 0)}</td></tr>
              <tr><td>ภาษีหัก ณ ที่จ่าย</td><td className="r num">−{baht(info.reconciliation?.wht ?? 0)}</td></tr>
              <tr><td>เงินสำรองจ่ายคืนไกด์</td><td className="r num">{baht(info.reconciliation?.reimbursementTotal ?? 0)}</td></tr>
              <tr><td><b>ยอดโอนสุทธิ</b></td><td className="r num"><b>{baht(info.reconciliation?.netTransfer ?? 0)}</b></td></tr>
              <tr><td style={{ color: "var(--muted,#78716c)" }}>ในจำนวนนี้ ใบรับรองครอบคลุม</td><td className="r num" style={{ color: "var(--muted,#78716c)" }}>{thb(info.reconciliation?.certificateCoversSatang ?? 0)}</td></tr>
            </tbody>
          </table>
          <div style={{ marginTop: 4, color: "var(--muted,#78716c)" }}>
            ตัวเลขข้างต้นอยู่ในเอกสาร PEAK ฉบับเดียวกัน แต่ไม่ปรากฏบนใบรับรอง ใบรับรองแสดงเฉพาะรายการที่ไม่มีใบเสร็จเท่านั้น
          </div>
        </details>
      )}

      {isAdmin && (
        <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          {!live && info.canIssue && (
            <button type="button" className="btn" disabled={busy} onClick={() => act("/api/jobsheet/certificate", { guideId, date, slotIdx }, "สร้างใบรับรองแล้ว")}>
              สร้างใบรับรองแทนใบเสร็จ
            </button>
          )}
          {live?.status === "READY_TO_ATTEST" && (
            <>
              <label style={{ display: "flex", gap: 6, alignItems: "flex-start", fontSize: 11.5, flexBasis: "100%" }}>
                <input type="checkbox" checked={confirmed} onChange={(ev) => setConfirmed(ev.target.checked)} />
                <span>ข้าพเจ้าตรวจสอบรายการและรับรองว่าเป็นค่าใช้จ่ายที่เกิดขึ้นจริงเพื่อกิจการ</span>
              </label>
              <button type="button" className="btn" disabled={busy || !confirmed}
                onClick={() => act(`/api/jobsheet/certificate/${live.id}`, { action: "attest" }, "รับรองเอกสารแล้ว")}>
                รับรองเอกสารทางอิเล็กทรอนิกส์
              </button>
            </>
          )}
          {live?.status === "ATTESTED" && (
            <button type="button" className="btn" disabled={busy}
              onClick={() => act(`/api/jobsheet/certificate/${live.id}`, { action: "upload" }, "จัดเก็บใน Drive แล้ว")}>
              จัดเก็บเอกสารใน Drive
            </button>
          )}
          {live?.status === "UPLOADED" && (
            <button type="button" className="btn" disabled={busy}
              onClick={() => act(`/api/jobsheet/certificate/${live.id}`, { action: "link" }, "ผูกกับรายการในใบงานแล้ว")}>
              ผูกกับรายการในใบงาน
            </button>
          )}
          {live && (
            <button type="button" className="btn sm" disabled={busy} onClick={() => {
              const reason = window.prompt("เหตุผลที่ยกเลิกใบรับรองนี้ (อย่างน้อย 10 ตัวอักษร) — จะถูกเก็บไว้กับเอกสาร");
              if (reason) void act(`/api/jobsheet/certificate/${live.id}`, { action: "void", reason }, "ยกเลิกใบรับรองแล้ว");
            }}>
              ยกเลิกใบรับรอง
            </button>
          )}
        </div>
      )}

      {msg && <div style={{ marginTop: 8, fontSize: 11.5 }}>{msg}</div>}

      {info.certificates.filter((c) => c.status === "VOID").length > 0 && (
        <details style={{ marginTop: 10, fontSize: 11.5 }}>
          <summary>ใบที่ยกเลิกแล้ว ({info.certificates.filter((c) => c.status === "VOID").length})</summary>
          <ul style={{ paddingLeft: 18, marginTop: 6 }}>
            {info.certificates.filter((c) => c.status === "VOID").map((c) => (
              <li key={c.id}>{c.certificateNo} — ยกเลิกเมื่อ {when(c.voidedAt)}: {c.voidReason}</li>
            ))}
          </ul>
        </details>
      )}

      <div style={{ marginTop: 10, fontSize: 10.5, color: "var(--muted,#78716c)", lineHeight: 1.5 }}>
        การรับรองใช้การยืนยันตัวตนจากการเข้าสู่ระบบ และบันทึกชื่อ สิทธิ์ เวลา ไว้ใน audit log —
        ไม่ใช่การลงลายมือชื่ออิเล็กทรอนิกส์แบบเข้ารหัส ลายนิ้วมือข้อมูลใช้ตรวจว่าใบงานถูกแก้หลังรับรองหรือไม่ ไม่ได้ใช้พิสูจน์ตัวบุคคล
      </div>
    </section>
  );
}
