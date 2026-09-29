"use client";

import Link from "next/link";
import { useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import { useLang } from "@/components/Providers";

export default function ForgotPage() {
  const { t } = useLang();
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [devLink, setDevLink] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await fetch("/api/password/forgot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    setDevLink(d.devLink ?? null);
    setDone(true);
  }

  return (
    <div className="wrap">
      <AuthHeader backHref="/signin" />
      <section className="panel narrow">
        <form className="auth-card" onSubmit={submit}>
          {done ? (
            <>
              <h2>{t("forgotDoneTitle")}</h2>
              <p className="sub">{t("forgotDoneBody")}</p>
              {devLink && <div className="devbox">DEV — reset link (no real email in prototype):<br /><Link className="glink" href={devLink}>{devLink}</Link></div>}
              <p className="sub" style={{ marginTop: 14 }}>{t("forgotClaimHint")}</p>
              <Link className="glink" href="/claim">{t("forgotClaimCta")}</Link>
              <Link className="glink" href="/start">{t("toLogin")}</Link>
            </>
          ) : (
            <>
              <h2>{t("forgotTitle")}</h2>
              <p className="sub">{t("forgotHint")}</p>
              <div className="fld"><label>{t("email")}</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" /></div>
              <button className="btn primary" type="submit" disabled={busy} style={{ width: "100%", marginTop: 10, padding: 11 }}>{busy ? "…" : t("sendLink")}</button>
            </>
          )}
        </form>
      </section>
    </div>
  );
}
