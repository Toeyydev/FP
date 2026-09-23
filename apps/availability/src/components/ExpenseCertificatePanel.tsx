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
};
type Info = {
  ok: true; jobRef: string | null; guideReportedAt: string | null;
  rowsNeedingCertificate: Covered[]; totalSatang: number; canIssue: boolean; blockers: string[];
  certificates: Certificate[];
};

const thb = (satang: number) => `฿${(satang / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }) : "—");
const short = (h: string | null | undefined) => (h ?? "").slice(0, 12);

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

  const load = useCallback(async () => {
    const r = await fetch(`/api/jobsheet/certificate?guideId=${encodeURIComponent(guideId)}&date=${date}&slotIdx=${slotIdx}`);
    if (!r.ok) { setInfo(null); return; }
    setInfo(await r.json());
  }, [guideId, date, slotIdx]);

  useEffect(() => { void load(); }, [load]);

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
