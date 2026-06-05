"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import { useLang } from "@/components/Providers";
import { REQUIRED_PROFILE_FIELDS } from "@/lib/profile";

const REQUIRED = new Set(REQUIRED_PROFILE_FIELDS);

type Doc = { id: string; kind: string; filename: string; mimeType: string; size: number; uploadedAt: string };
type Profile = {
  guideId: string | null; displayName: string; email: string;
  documents: Doc[];
  [k: string]: unknown;
};

const FIELDS = [
  ["fullName", "fullName"], ["phone", "phoneLabel"], ["lineId", "lineIdLabel"],
  ["emergencyName", "emergencyNameLabel"], ["emergencyPhone", "emergencyPhoneLabel"], ["emergencyRelation", "emergencyRelationLabel"],
  ["taxId", "taxIdLabel"], ["idCardAddress", "idCardAddressLabel"], ["currentAddress", "currentAddressLabel"],
  ["bankName", "bankNameLabel"], ["bankAccountNo", "bankAccountNoLabel"], ["bankAccountName", "bankAccountNameLabel"], ["bankBranch", "bankBranchLabel"],
] as const;

export default function ProfileForm({ targetUserId }: { targetUserId: string | null }) {
  const { t } = useLang();
  const [p, setP] = useState<Profile | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [lineCode, setLineCode] = useState<{ code: string; addUrl: string | null } | null>(null);
  const fileRefs = { ID_CARD: useRef<HTMLInputElement>(null), BANK_BOOK: useRef<HTMLInputElement>(null), OTHER: useRef<HTMLInputElement>(null) };
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
      const missing = REQUIRED_PROFILE_FIELDS.filter((k) => !(form[k] && form[k].trim()));
      if (missing.length) { setMsg(t("allRequired")); return; }
    }
    setBusy(true); setMsg("");
    const body: Record<string, string> = { ...form };
    if (targetUserId) body.userId = targetUserId;
    const r = await fetch("/api/profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    setBusy(false);
    setMsg(r.ok ? t("saved") : "Error");
    if (r.ok) load();
  }

  async function upload(kind: string, file: File) {
    const fd = new FormData();
    fd.append("kind", kind); fd.append("file", file);
    if (targetUserId) fd.append("userId", targetUserId);
    await fetch("/api/profile/document", { method: "POST", body: fd });
    await load();
  }
  async function del(id: string) {
    await fetch(`/api/profile/document/${id}`, { method: "DELETE" });
    await load();
  }
  async function connectLine() {
    const r = await fetch("/api/line/connect", { method: "POST" });
    const d = await r.json().catch(() => ({}));
    if (d.code) setLineCode({ code: d.code, addUrl: d.addUrl ?? null });
  }

  if (!p) return <div className="wrap"><AuthHeader backHref="/" /><section className="panel"><div className="op-empty">…</div></section></div>;

  const docBtn = (kind: "ID_CARD" | "BANK_BOOK" | "OTHER", label: string) => (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <button type="button" className="btn sm" onClick={() => fileRefs[kind].current?.click()}>{label} — {t("uploadFile")}</button>
      <input ref={fileRefs[kind]} type="file" accept="image/*,application/pdf" hidden
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
              <input required={REQUIRED.has(k)} value={form[k] ?? ""} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
            </div>
          ))}

          <div className="auth-msg" style={{ color: "var(--green)" }}>{msg}</div>
          <button className="btn primary" style={{ width: "100%", padding: 11 }} disabled={busy} onClick={save}>{busy ? "…" : t("save")}</button>

          <div className="fld" style={{ marginTop: 22 }}>
            <label>{t("docsSection")}</label>
            {p.documents.length > 0 && (
              <div style={{ display: "grid", gap: 6, marginBottom: 10 }}>
                {p.documents.map((d) => (
                  <div key={d.id} className="codeflash" style={{ background: "var(--grey-bg)", color: "var(--ink)" }}>
                    <span><b>{d.kind === "ID_CARD" ? t("idCardDoc") : d.kind === "BANK_BOOK" ? t("bankBookDoc") : t("otherDoc")}</b> · {d.filename} · {(d.size / 1024).toFixed(0)} KB</span>
                    <span style={{ display: "flex", gap: 8 }}>
                      <a className="glink" href={`/api/profile/document/${d.id}`} target="_blank" rel="noreferrer">{t("viewDoc")}</a>
                      <button className="btn sm danger" onClick={() => del(d.id)}>{t("deleteDoc")}</button>
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: "grid", gap: 8 }}>
              {docBtn("ID_CARD", t("idCardDoc"))}
              {docBtn("BANK_BOOK", t("bankBookDoc"))}
              {docBtn("OTHER", t("otherDoc"))}
            </div>
          </div>

          <div className="fld" style={{ marginTop: 22 }}>
            <label>{t("lineSection")}</label>
            {p.lineLinked ? (
              <div className="docrow" style={{ color: "var(--green)", fontWeight: 700 }}>{t("lineConnected")}</div>
            ) : lineCode ? (
              <div className="note">
                {t("lineConnectHint")}
                <div style={{ marginTop: 8, fontSize: 20, fontWeight: 800, letterSpacing: ".15em", fontFamily: '"Bricolage Grotesque"', color: "var(--ink)" }}>{lineCode.code}</div>
                {lineCode.addUrl && <a className="glink" href={lineCode.addUrl} target="_blank" rel="noreferrer">Add the Folkpath LINE account →</a>}
              </div>
            ) : (
              <button type="button" className="btn" onClick={connectLine}>{t("connectLine")}</button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
