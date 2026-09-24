"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Registering the handwriting that goes on a certificate.
//
// The preview before confirming is drawn from the file the admin just chose, in their own
// browser — nothing is uploaded to be looked at. So there is no half-registered state to
// clean up, and a change of mind costs nothing. The server validates the bytes again on
// submit regardless: what the browser shows is a courtesy, never the check.
//
// The live image comes back through this server rather than as a Drive link, so looking
// at it does not hand anyone the means to pass on access to the file. It does not stop an
// admin keeping a copy of what they are shown — nothing could — and it is not embedded in
// the page source or in any JSON, so it stays out of anything that logs responses.

type Version = {
  id: string; userId: string; userName: string | null; version: number; active: boolean;
  sha256: string; bytes: number; width: number; height: number;
  uploadedAt: string; uploadedByName: string | null;
  retiredAt: string | null; retireReason: string | null; filed: boolean;
};
type Impact = { attestedWithCurrent: number; alreadyFiled: number; attestedNotYetFiled: number };
type Info = {
  ok: true; userId: string; userName: string;
  active: Version | null; versions: Version[]; impact: Impact;
  admins: { id: string; name: string }[];
  limits: { maxBytes: number; minDimension: number; maxDimension: number };
  /** Reading is the ADMIN role; changing is narrowed to the authorised attesters. */
  mayChange: boolean;
  cannotChangeReason: string | null;
  attesterListInForce: boolean;
  /** Configured Google accounts allowed to hold the files, and any that did not check out. */
  driveAllowlist: { verified: string[]; problems: string[] };
};

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }) : "—";
const kb = (n: number) => `${Math.round(n / 1024)} KB`;
const short = (h: string) => h.slice(0, 12);

export default function AttesterSignatureSettings() {
  const [info, setInfo] = useState<Info | null>(null);
  const [userId, setUserId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>("");
  const [problems, setProblems] = useState<string[]>([]);
  /** The chosen file, shown from the browser's own copy. Nothing is uploaded to preview. */
  const [pending, setPending] = useState<{ file: File; url: string; width: number; height: number } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [showLive, setShowLive] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async (who?: string) => {
    const q = who ? `?userId=${encodeURIComponent(who)}` : "";
    const r = await fetch(`/api/certificates/signature${q}`);
    if (!r.ok) { setInfo(null); setMsg("ไม่มีสิทธิ์ดูข้อมูลนี้"); return; }
    const d = (await r.json()) as Info;
    setInfo(d);
    setUserId(d.userId);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const choose = (f: File | null) => {
    setProblems([]); setMsg(""); setConfirmed(false);
    if (pending) URL.revokeObjectURL(pending.url);
    if (!f) { setPending(null); return; }
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      const bad: string[] = [];
      const lim = info?.limits;
      if (lim && f.size > lim.maxBytes) bad.push(`ไฟล์ ${kb(f.size)} ใหญ่เกิน ${kb(lim.maxBytes)}`);
      if (lim && (img.width < lim.minDimension || img.height < lim.minDimension || img.width > lim.maxDimension || img.height > lim.maxDimension)) {
        bad.push(`ขนาดภาพ ${img.width}×${img.height} อยู่นอกช่วง ${lim.minDimension}–${lim.maxDimension}`);
      }
      if (!/\.png$/i.test(f.name) && f.type !== "image/png") bad.push("ต้องเป็นไฟล์ PNG");
      setProblems(bad);
      setPending({ file: f, url, width: img.width, height: img.height });
    };
    img.onerror = () => { setProblems(["อ่านไฟล์ภาพนี้ไม่ได้"]); setPending(null); URL.revokeObjectURL(url); };
    img.src = url;
  };

  const submit = async () => {
    if (!pending || !info) return;
    setBusy(true); setMsg("");
    const body = new FormData();
    body.append("file", pending.file);
    body.append("userId", info.userId);
    const r = await fetch("/api/certificates/signature", { method: "POST", body });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg((d.reasons ?? []).join(" ") || "ลงทะเบียนไม่สำเร็จ"); return; }
    setMsg(d.created ? `ลงทะเบียนลายเซ็นฉบับที่ ${d.signature.version} แล้ว` : "ลายเซ็นนี้ถูกลงทะเบียนไว้อยู่แล้ว ไม่ได้สร้างฉบับใหม่");
    URL.revokeObjectURL(pending.url);
    setPending(null); setConfirmed(false);
    if (fileInput.current) fileInput.current.value = "";
    setShowLive(false);
    await load(info.userId);
  };

  const retire = async () => {
    if (!info?.active) return;
    const reason = window.prompt("เหตุผลที่ยกเลิกลายเซ็นนี้ (อย่างน้อย 10 ตัวอักษร) — เก็บไว้กับประวัติ");
    if (reason === null) return;
    setBusy(true); setMsg("");
    const r = await fetch("/api/certificates/signature", {
      method: "DELETE", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: info.userId, reason }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    setMsg(r.ok ? "ยกเลิกลายเซ็นที่ใช้งานอยู่แล้ว ประวัติและไฟล์ยังอยู่ครบ" : (d.reasons ?? []).join(" ") || "ยกเลิกไม่สำเร็จ");
    setShowLive(false);
    await load(info.userId);
  };

  if (!info) {
    return <main className="page"><section className="card"><p>{msg || "กำลังโหลด…"}</p></section></main>;
  }

  const lim = info.limits;
  return (
    <main className="page" style={{ maxWidth: 820 }}>
      <h1 style={{ fontSize: 20, marginBottom: 2 }}>ลายเซ็นผู้รับรอง</h1>
      <p style={{ color: "var(--ink-soft,#78716c)", fontSize: 13, marginTop: 0 }}>
        ภาพลายมือชื่อที่จะปรากฏบนใบรับรองแทนใบเสร็จ เห็นและแก้ไขได้เฉพาะผู้ดูแลระบบ
      </p>

      {info.admins.length > 1 && (
        <section className="card" style={{ marginTop: 12 }}>
          <label style={{ fontSize: 13 }}>ผู้รับรอง{" "}
            <select value={userId} disabled={busy} onChange={(e) => { setPending(null); setShowLive(false); void load(e.target.value); }}>
              {info.admins.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
        </section>
      )}

      {/* What is on file now. */}
      <section className="card" style={{ marginTop: 12 }}>
        <h2 style={{ fontSize: 15, marginTop: 0 }}>ลายเซ็นที่ใช้งานอยู่</h2>
        {info.active ? (
          <>
            <div style={{ fontSize: 13 }}>
              <b>{info.userName}</b> · ฉบับที่ {info.active.version} · ลงทะเบียนเมื่อ {when(info.active.uploadedAt)}
              {info.active.uploadedByName ? ` โดย ${info.active.uploadedByName}` : ""}
            </div>
            <div style={{ fontSize: 12, color: "var(--ink-soft,#78716c)", marginTop: 2 }}>
              {info.active.width}×{info.active.height} · {kb(info.active.bytes)} · ลายนิ้วมือ {short(info.active.sha256)}…
              {!info.active.filed && " · ยังไม่มีไฟล์ในระบบจัดเก็บ"}
            </div>
            <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="btn sm" onClick={() => setShowLive((v) => !v)}>
                {showLive ? "ซ่อนภาพ" : "ดูภาพลายเซ็น"}
              </button>
              <button type="button" className="btn sm ghost" disabled={busy || info.mayChange === false} onClick={() => void retire()}>
                ยกเลิกการใช้งานลายเซ็นนี้
              </button>
            </div>
            {showLive && (
              <div style={{ marginTop: 8, padding: 10, border: "1px solid var(--line,#e7e5e4)", borderRadius: 6, display: "inline-block", background: "#fff" }}>
                {/* Served by this server from the private file — never a Drive link. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/certificates/signature/image?userId=${encodeURIComponent(info.userId)}`} alt={`ภาพลายมือชื่อของ ${info.userName}`} style={{ maxWidth: 260, maxHeight: 90, display: "block" }} />
              </div>
            )}
          </>
        ) : (
          <p style={{ fontSize: 13, margin: 0 }}>
            ยังไม่มีลายเซ็นที่ใช้งานอยู่ ใบรับรองที่ออกตอนนี้จะไม่มีภาพลายมือชื่อ ซึ่งยังถือว่าเป็นเอกสารที่สมบูรณ์ —
            มีชื่อผู้รับรอง สิทธิ์ เวลา และเลขอ้างอิง audit ครบ
          </p>
        )}
      </section>

      {/* Upload, preview, confirm. */}
      {(info.driveAllowlist?.problems?.length ?? 0) > 0 && (
        <section className="card" style={{ marginTop: 12, borderColor: "#fca5a5", background: "#fef2f2" }}>
          <p style={{ margin: 0, fontSize: 13 }}>
            <b>ตั้งค่าบัญชีที่ถือไฟล์ไม่ถูกต้อง</b><br />
            มีอีเมลใน CERTIFICATE_DRIVE_ALLOWED_EMAILS ที่ตรวจสอบกับบัญชีในระบบไม่ผ่าน ระบบจะไม่ยอมรับอีเมลเหล่านี้
            และจะปฏิเสธการจัดเก็บไฟล์ที่ถูกแชร์ให้บัญชีนั้น
          </p>
          <ul style={{ fontSize: 12.5, marginTop: 6, marginBottom: 0 }}>
            {info.driveAllowlist.problems.map((p) => <li key={p}>{p}</li>)}
          </ul>
        </section>
      )}

      {info.mayChange === false && (
        <section className="card" style={{ marginTop: 12, borderColor: "#fcd34d", background: "#fffbeb" }}>
          <p style={{ margin: 0, fontSize: 13 }}>
            <b>บัญชีนี้ดูได้แต่แก้ไขไม่ได้</b><br />
            {info.cannotChangeReason}
          </p>
        </section>
      )}

      <section className="card" style={{ marginTop: 12 }}>
        <h2 style={{ fontSize: 15, marginTop: 0 }}>{info.active ? "เปลี่ยนลายเซ็น" : "ลงทะเบียนลายเซ็น"}</h2>
        <p style={{ fontSize: 12.5, color: "var(--ink-soft,#78716c)", marginTop: 0 }}>
          ไฟล์ PNG ขนาดไม่เกิน {kb(lim.maxBytes)} และด้านละ {lim.minDimension}–{lim.maxDimension} พิกเซล
          การเปลี่ยนจะสร้างเป็นฉบับใหม่ ไม่เขียนทับของเดิม
        </p>
        <input ref={fileInput} type="file" accept="image/png" disabled={busy || info.mayChange === false} onChange={(e) => choose(e.target.files?.[0] ?? null)} />

        {problems.length > 0 && (
          <ul style={{ color: "#b45309", fontSize: 12.5, marginTop: 8 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
        )}

        {pending && problems.length === 0 && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12.5, color: "var(--ink-soft,#78716c)" }}>
              ตัวอย่างก่อนยืนยัน · {pending.width}×{pending.height} · {kb(pending.file.size)}
            </div>
            <div style={{ marginTop: 6, padding: 10, border: "1px solid var(--line,#e7e5e4)", borderRadius: 6, display: "inline-block", background: "#fff" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={pending.url} alt="ตัวอย่างลายเซ็นที่เลือก" style={{ maxWidth: 260, maxHeight: 90, display: "block" }} />
            </div>

            {/* What this changes, in numbers, so the answer is not taken on trust. */}
            <div style={{ marginTop: 8, fontSize: 12.5, background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 6, padding: "8px 10px" }}>
              <b>ใบรับรองที่ออกไปแล้วจะไม่เปลี่ยน</b><br />
              ใบรับรองแต่ละฉบับผูกกับลายเซ็นฉบับที่ใช้รับรองในตอนนั้น ลายเซ็นใหม่จะมีผลกับใบรับรองที่รับรองหลังจากนี้เท่านั้น
              {info.active && (
                <div style={{ marginTop: 4, color: "var(--ink-soft,#78716c)" }}>
                  ปัจจุบันมีใบรับรอง {info.impact.attestedWithCurrent} ฉบับที่รับรองด้วยลายเซ็นฉบับที่ {info.active.version}
                  {" "}({info.impact.alreadyFiled} ฉบับออกไฟล์แล้ว, {info.impact.attestedNotYetFiled} ฉบับยังไม่ออกไฟล์) — ทั้งหมดยังใช้ลายเซ็นฉบับเดิมต่อไป
                </div>
              )}
            </div>

            <label style={{ display: "block", marginTop: 8, fontSize: 12.5 }}>
              <input type="checkbox" checked={confirmed} disabled={busy} onChange={(e) => setConfirmed(e.target.checked)} />{" "}
              ยืนยันว่านี่คือลายมือชื่อของ {info.userName} และอนุญาตให้ใช้บนใบรับรองแทนใบเสร็จ
            </label>
            <div style={{ marginTop: 8 }}>
              <button type="button" className="btn" disabled={busy || !confirmed} onClick={() => void submit()}>
                {busy ? "กำลังบันทึก…" : "ยืนยันและลงทะเบียน"}
              </button>
            </div>
          </div>
        )}

        {msg && <p style={{ marginTop: 10, fontSize: 12.5 }}>{msg}</p>}
      </section>

      {/* History. Nothing is ever deleted, so a document years old can still be checked. */}
      {info.versions.length > 0 && (
        <section className="card" style={{ marginTop: 12 }}>
          <h2 style={{ fontSize: 15, marginTop: 0 }}>ประวัติลายเซ็น</h2>
          <table className="acct-table" style={{ width: "100%", fontSize: 12.5 }}>
            <thead><tr><th>ฉบับที่</th><th>ลงทะเบียนเมื่อ</th><th>ขนาด</th><th>ลายนิ้วมือ</th><th>สถานะ</th></tr></thead>
            <tbody>
              {info.versions.map((v) => (
                <tr key={v.id}>
                  <td>{v.version}</td>
                  <td>{when(v.uploadedAt)}</td>
                  <td>{v.width}×{v.height} · {kb(v.bytes)}</td>
                  <td className="mono">{short(v.sha256)}…</td>
                  <td>
                    {v.active
                      ? <span style={{ color: "#2f7d4f", fontWeight: 700 }}>ใช้งานอยู่</span>
                      : <span style={{ color: "var(--ink-soft,#78716c)" }}>เลิกใช้ {when(v.retiredAt)}{v.retireReason ? ` · ${v.retireReason}` : ""}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ fontSize: 12, color: "var(--ink-soft,#78716c)", marginTop: 6 }}>
            ไม่มีการลบฉบับเก่าและไม่มีการเขียนทับไฟล์ ใบรับรองที่รับรองด้วยฉบับใดยังตรวจสอบกับไฟล์ฉบับนั้นได้เสมอ
          </p>
        </section>
      )}
    </main>
  );
}
