"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import { useLang } from "@/components/Providers";

function ResetInner() {
  const { t } = useLang();
  const token = useSearchParams().get("token") ?? "";
  const [pw, setPw] = useState(""); const [pw2, setPw2] = useState("");
  const [msg, setMsg] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg("");
    if (pw.length < 8) { setMsg(t("pwShort")); return; }
    if (pw !== pw2) { setMsg(t("pwMismatch")); return; }
    setBusy(true);
    const r = await fetch("/api/password/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, password: pw }) });
    setBusy(false);
    if (!r.ok) { setMsg(t("resetBadLink")); return; }
    setDone(true);
  }

  if (!token) return <div className="auth-card"><h2>{t("resetTitle")}</h2><p className="sub">{t("resetBadLink")}</p><Link className="glink" href="/forgot">{t("forgot")}</Link></div>;

  return (
    <form className="auth-card" onSubmit={submit}>
      {done ? (
        <>
          <h2>{t("resetDoneTitle")}</h2>
          <p className="sub">{t("resetDoneBody")}</p>
          <Link className="glink" href="/start">{t("toLogin")}</Link>
        </>
      ) : (
        <>
          <h2>{t("resetTitle")}</h2>
          <p className="sub">{t("resetHint")}</p>
          <div className="fld"><label>{t("newPassword")}</label><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} /></div>
          <div className="fld"><label>{t("confirmPassword")}</label><input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></div>
          <div className="auth-msg">{msg}</div>
          <button className="btn primary" type="submit" disabled={busy} style={{ width: "100%", marginTop: 4, padding: 11 }}>{busy ? "…" : t("resetBtn")}</button>
        </>
      )}
    </form>
  );
}

export default function ResetPage() {
  return (
    <div className="wrap">
      <AuthHeader backHref="/signin" />
      <section className="panel narrow">
        <Suspense fallback={<div className="auth-card">…</div>}><ResetInner /></Suspense>
      </section>
    </div>
  );
}
