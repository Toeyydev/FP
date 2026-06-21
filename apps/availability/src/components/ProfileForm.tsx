"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import { useLang } from "@/components/Providers";
import { REQUIRED_PROFILE_FIELDS } from "@/lib/profile";

const REQUIRED = new Set(REQUIRED_PROFILE_FIELDS);

type Doc = { id: string; kind: string; filename: string; mimeType: string; size: number; uploadedAt: string };
type Profile = {
  lineLoginEnabled?: boolean;
  guideId: string | null; displayName: string; email: string;
  documents: Doc[];
  [k: string]: unknown;
};

const FIELDS = [
  ["fullName", "fullName"], ["phone", "phoneLabel"], ["lineId", "lineIdLabel"], ["licenseNo", "licenseNoLabel"],
  ["emergencyName", "emergencyNameLabel"], ["emergencyPhone", "emergencyPhoneLabel"], ["emergencyRelation", "emergencyRelationLabel"],
  ["taxId", "taxIdLabel"], ["idCardAddress", "idCardAddressLabel"], ["currentAddress", "currentAddressLabel"],
  ["bankName", "bankNameLabel"], ["bankAccountNo", "bankAccountNoLabel"], ["bankAccountName", "bankAccountNameLabel"], ["bankBranch", "bankBranchLabel"],
] as const;

export default function ProfileForm({ targetUserId }: { targetUserId: string | null }) {
  const { t } = useLang();
  const [p, setP] = useState<Profile | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [lineCode, setLineCode] = useState<{ code: string; addUrl: string | null } | null>(null);
  const [docMsg, setDocMsg] = useState("");
  const [cal, setCal] = useState<{ enabled: boolean; connected: boolean; email: string | null }>({ enabled: false, connected: false, email: null });
  useEffect(() => { fetch("/api/google/status", { cache: "no-store" }).then((r) => r.json()).then(setCal).catch(() => {}); }, []);
  async function disconnectCal() { await fetch("/api/google/status", { method: "DELETE" }); setCal((c) => ({ ...c, connected: false, email: null })); }
  const fileRefs = { ID_CARD: useRef<HTMLInputElement>(null), BANK_BOOK: useRef<HTMLInputElement>(null), GUIDE_LICENSE: useRef<HTMLInputElement>(null), OTHER: useRef<HTMLInputElement>(null) };
  const sigRef = useRef<HTMLInputElement>(null);
  const qs = targetUserId ? `?userId=${targetUserId}` : "";

  const load = useCallback(async () => {
    const r = await fetch(`/api/profile${qs}`, { cache: "no-store" });
    if (!r.ok) return;
    const d: Profile = await r.json();
    setP(d);
    setForm(Object.fromEntries(FIELDS.map(([k]) => [k, (d as Record<string, unknown>)[k] as string ?? ""])));
  }, [qs]);
  useEffect(() => { load(); }, [load]);

  async function save() {
    // Every required field must be filled (operators editing others can skip).
    if (!targetUserId) {
      const miss = REQUIRED_PROFILE_FIELDS.filter((k) => !(form[k] && form[k].trim()));
      if (miss.length) {
        setMissing(new Set(miss));
        const labelFor = (k: string) => { const f = FIELDS.find(([fk]) => fk === k); return f ? t(f[1] as Parameters<typeof t>[0]) : k; };
        setMsg(`${t("allRequired")} — ${miss.map(labelFor).join(", ")}`);
        const el = document.getElementById(`fld-${miss[0]}`);
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
        (el as HTMLInputElement | null)?.focus();
        return;
      }
      setMissing(new Set());
    }
    setBusy(true); setMsg("");
    const body: Record<string, string> = { ...form };
    if (targetUserId) body.userId = targetUserId;
    const r = await fetch("/api/profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    setBusy(false);
    setMsg(r.ok ? t("saved") : "Error");
    if (r.ok) load();
  }

  // Downscale big photos in the browser so phone images don't hit the size limit.
  async function shrink(file: File): Promise<Blob> {
    if (!file.type.startsWith("image/")) return file; // PDFs etc. upload as-is
    const bmp = await createImageBitmap(file).catch(() => null);
    if (!bmp) return file;
    const max = 1600, scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const ctx = c.getContext("2d"); if (!ctx) return file;
    ctx.drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/jpeg", 0.82));
    return blob && blob.size < file.size ? blob : file;
  }
  async function upload(kind: string, file: File) {
    // Only PDF / JPG / PNG are accepted.
    const okType = ["application/pdf", "image/jpeg", "image/jpg", "image/png"].includes((file.type || "").toLowerCase()) || /\.(pdf|jpe?g|png)$/i.test(file.name);
    if (!okType) { setDocMsg(t("docBadType")); return; }
    setDocMsg(t("uploading"));
    try {
      const blob = await shrink(file);
      const fd = new FormData();
      const name = blob.type === "image/jpeg" ? file.name.replace(/\.[^.]+$/, "") + ".jpg" : file.name;
      fd.append("kind", kind); fd.append("file", blob, name || "upload");
      if (targetUserId) fd.append("userId", targetUserId);
      const r = await fetch("/api/profile/document", { method: "POST", body: fd });
      if (!r.ok) { const e = await r.json().catch(() => ({})); setDocMsg(e?.error === "too-large" ? t("docTooLarge") : t("docUploadFailed")); return; }
      setDocMsg(t("uploaded"));
      await load();
    } catch { setDocMsg(t("docUploadFailed")); }
  }
  async function del(id: string) {
    await fetch(`/api/profile/document/${id}`, { method: "DELETE" });
    await load();
  }
  // Signature: downscale the image and store it as a PNG data-URI for the job order.
  async function uploadSignature(file: File) {
    try {
      setDocMsg(t("uploading"));
      const bmp = await createImageBitmap(file).catch(() => null);
      if (!bmp) { setDocMsg(t("docUploadFailed")); return; }
      const max = 600, scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      const ctx = c.getContext("2d"); if (!ctx) { setDocMsg(t("docUploadFailed")); return; }
      ctx.drawImage(bmp, 0, 0, w, h);
      const dataUri = c.toDataURL("image/png");
      if (dataUri.length > 400_000) { setDocMsg(t("docTooLarge")); return; }
      const r = await fetch("/api/profile/signature", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dataUri, ...(targetUserId ? { userId: targetUserId } : {}) }) });
      setDocMsg(r.ok ? t("uploaded") : t("docUploadFailed"));
      if (r.ok) await load();
    } catch { setDocMsg(t("docUploadFailed")); }
  }
  async function removeSignature() {
    await fetch("/api/profile/signature", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(targetUserId ? { userId: targetUserId } : {}) });
    await load();
  }
  async function connectLine() {
    const r = await fetch("/api/line/connect", { method: "POST" });
    const d = await r.json().catch(() => ({}));
    if (d.code) setLineCode({ code: d.code, addUrl: d.addUrl ?? null });
  }

  if (!p) return <div className="wrap"><AuthHeader backHref="/" /><section className="panel"><div className="op-empty">…</div></section></div>;

  const docBtn = (kind: "ID_CARD" | "BANK_BOOK" | "GUIDE_LICENSE" | "OTHER", label: string) => (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <button type="button" className="btn sm" onClick={() => fileRefs[kind].current?.click()}>{label} — {t("uploadFile")}</button>
      <input ref={fileRefs[kind]} type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(kind, f); e.target.value = ""; }} />
    </div>
  );

  return (
    <div className="wrap">
      <AuthHeader backHref="/" />
      <section className="panel narrow">
        <div className="auth-card">
          <h2>{t("profileTitle")}</h2>
          <p className="sub">{p.guideId ? `${p.guideId} · ` : ""}{p.displayName} · {p.email}</p>
          <div className="auth-note">{t("profileHint")}</div>

          {FIELDS.map(([k, labelKey]) => (
            <div className="fld" key={k}>
              <label>{t(labelKey as Parameters<typeof t>[0])}{REQUIRED.has(k) ? <span style={{ color: "#c0392b" }}> *</span> : ""}</label>
              <input id={`fld-${k}`} required={REQUIRED.has(k)} value={form[k] ?? ""}
                style={missing.has(k) ? { borderColor: "#c0392b", background: "#fff6f5" } : undefined}
                onChange={(e) => { setForm({ ...form, [k]: e.target.value }); if (missing.has(k)) setMissing((prev) => { const n = new Set(prev); n.delete(k); return n; }); }} />
            </div>
          ))}

          <div className="auth-msg" style={{ color: missing.size ? "#c0392b" : "var(--green)" }}>{msg}</div>
          <button className="btn primary" style={{ width: "100%", padding: 11 }} disabled={busy} onClick={save}>{busy ? "…" : t("save")}</button>

          <div className="fld" style={{ marginTop: 22 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <label style={{ margin: 0 }}>{t("docsSection")} <span style={{ color: "var(--ink-soft)", fontWeight: 600 }}>· {t("optional")}</span></label>
              {p.documents.length > 0 && <a className="btn sm" href={`/api/profile/documents/export${targetUserId ? `?userId=${targetUserId}` : ""}`}>{t("downloadAll")}</a>}
            </div>
            <div className="auth-note" style={{ marginTop: 6, marginBottom: 10 }}>{t("docsOpsOnly")}</div>
            {p.documents.length > 0 && (
              <div style={{ display: "grid", gap: 6, marginBottom: 10 }}>
                {p.documents.map((d) => (
                  <div key={d.id} className="doc-item">
                    <div className="doc-row">
                      <span><b>{d.kind === "ID_CARD" ? t("idCardDoc") : d.kind === "BANK_BOOK" ? t("bankBookDoc") : d.kind === "GUIDE_LICENSE" ? t("licenseDoc") : t("otherDoc")}</b> · {d.filename} · {(d.size / 1024).toFixed(0)} KB</span>
                      <span style={{ display: "flex", gap: 8 }}>
                        <a className="glink" href={`/api/profile/document/${d.id}`} target="_blank" rel="noreferrer">{t("viewDoc")}</a>
                        <button className="btn sm danger" onClick={() => del(d.id)}>{t("deleteDoc")}</button>
                      </span>
                    </div>
                    {d.mimeType.startsWith("image/")
                      ? <a href={`/api/profile/document/${d.id}`} target="_blank" rel="noreferrer"><img className="doc-thumb" src={`/api/profile/document/${d.id}`} alt={d.filename} /></a>
                      : <a className="doc-pdf" href={`/api/profile/document/${d.id}`} target="_blank" rel="noreferrer">PDF · {t("viewDoc")}</a>}
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: "grid", gap: 8 }}>
              {docBtn("ID_CARD", t("idCardDoc"))}
              {docBtn("BANK_BOOK", t("bankBookDoc"))}
              {docBtn("GUIDE_LICENSE", t("licenseDoc"))}
              {docBtn("OTHER", t("otherDoc"))}
            </div>
            {docMsg && <div style={{ marginTop: 8, fontSize: 13, fontWeight: 600, color: docMsg === t("uploaded") ? "var(--green)" : "#c0392b" }}>{docMsg}</div>}
          </div>

          <div className="fld" style={{ marginTop: 22 }}>
            <label>{t("signatureLabel")}</label>
            <div className="auth-note" style={{ marginTop: 6, marginBottom: 10 }}>{t("signatureHint")}</div>
            {(p.signature as string | null) && <div style={{ marginBottom: 10 }}><img src={p.signature as string} alt="signature" style={{ height: 64, background: "#fff", border: "1px solid var(--line)", borderRadius: 8, padding: 6 }} /></div>}
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="btn sm" onClick={() => sigRef.current?.click()}>{(p.signature as string | null) ? t("replaceSignature") : t("uploadSignature")}</button>
              {(p.signature as string | null) && <button type="button" className="btn sm danger" onClick={removeSignature}>{t("deleteDoc")}</button>}
              <input ref={sigRef} type="file" accept="image/png,image/jpeg" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadSignature(f); e.target.value = ""; }} />
            </div>
          </div>

          <div className="fld" style={{ marginTop: 22 }}>
            <label>{t("lineSection")}</label>
            {p.lineLinked ? (
              <div className="docrow" style={{ color: "var(--green)", fontWeight: 700 }}>{t("lineConnected")}</div>
            ) : p.lineLoginEnabled ? (
              <a className="btn" style={{ display: "inline-block" }} href="/api/line/login/start">{t("connectLine")}</a>
            ) : lineCode ? (
              <div className="note">
                {t("lineConnectHint")}
                {lineCode.addUrl && <a className="btn" style={{ display: "inline-block", margin: "10px 0 4px" }} href={lineCode.addUrl} target="_blank" rel="noreferrer">➕ Add Folkpaths on LINE</a>}
                <div style={{ marginTop: 8, fontSize: 22, fontWeight: 800, letterSpacing: ".18em", fontFamily: '"Bricolage Grotesque"', color: "var(--ink)", background: "var(--grey-bg)", borderRadius: 10, padding: "8px 12px", textAlign: "center", userSelect: "all" }}>{lineCode.code}</div>
                <div style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 8 }}>↳ Open the Folkpaths LINE chat and <b>send this code</b> — it connects automatically. (Don't type it here.)</div>
              </div>
            ) : (
              <button type="button" className="btn" onClick={connectLine}>{t("connectLine")}</button>
            )}
          </div>

          {cal.enabled && (
            <div className="fld" style={{ marginTop: 18 }}>
              <label>{t("calSection")}</label>
              <div className="auth-note" style={{ marginTop: 0, marginBottom: 8 }}>{t("calHint")}</div>
              {cal.connected ? (
                <div className="docrow" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                  <span style={{ color: "var(--green)", fontWeight: 700 }}>{t("calConnected")}{cal.email ? ` · ${cal.email}` : ""}</span>
                  <button type="button" className="btn sm ghost" onClick={disconnectCal}>{t("calDisconnect")}</button>
                </div>
              ) : (
                <a className="btn" href="/api/google/connect">{t("calConnect")}</a>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
