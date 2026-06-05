"use client";

import { signIn } from "next-auth/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import { useLang } from "@/components/Providers";
import InstallPrompt from "@/components/InstallPrompt";

type Tab = "login" | "signup";

export default function StartPage() {
  const { t } = useLang();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("login");

  // login state
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [remember, setRemember] = useState(false);
  const [loginMsg, setLoginMsg] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);

  // signup state
  const [fullName, setFullName] = useState("");
  const [nickname, setNickname] = useState("");
  const [phone, setPhone] = useState("");
  const [suEmail, setSuEmail] = useState("");
  const [suPw, setSuPw] = useState("");
  const [showSuPw, setShowSuPw] = useState(false);
  const [suMsg, setSuMsg] = useState("");
  const [suBusy, setSuBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function doLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginMsg(""); setLoginBusy(true);
    const res = await signIn("credentials", { email, password: pw, redirect: false });
    if (res?.error) { setLoginBusy(false); setLoginMsg(t("badCreds")); return; }
    if (remember) await fetch("/api/session/remember", { method: "POST" });
    setLoginBusy(false);
    router.push("/"); router.refresh();
  }

  async function doSignup(e: React.FormEvent) {
    e.preventDefault();
    setSuMsg("");
    // Every field is required — no blanks.
    if (!fullName.trim() || !nickname.trim() || !phone.trim() || !suEmail.trim() || !suPw) { setSuMsg(t("allRequired")); return; }
    if (suPw.length < 8) { setSuMsg(t("pwShort")); return; }
    setSuBusy(true);
    const r = await fetch("/api/request", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ fullName, nickname, phone, email: suEmail, password: suPw }),
    });
    setSuBusy(false);
    if (r.status === 409) { setSuMsg(t("accountExists")); return; }
    if (!r.ok) { setSuMsg(t("errGeneric")); return; }
    setSent(true);
  }

  return (
    <div className="wrap">
      <AuthHeader />
      <InstallPrompt />
      <section id="authView" className="panel">
        <div className="auth-card">
          {sent ? (
            <>
              <h2>{t("signupSentTitle")}</h2>
              <p className="sub">{t("signupSentBody")}</p>
              <button className="btn" style={{ width: "100%", padding: 11 }} onClick={() => { setSent(false); setTab("login"); }}>{t("toLogin")}</button>
            </>
          ) : (
            <>
              <div className="authtabs" role="tablist">
                <button role="tab" aria-selected={tab === "login"} className={`authtab ${tab === "login" ? "active" : ""}`} onClick={() => setTab("login")}>{t("tabLogin")}</button>
                <button role="tab" aria-selected={tab === "signup"} className={`authtab ${tab === "signup" ? "active" : ""}`} onClick={() => setTab("signup")}>{t("tabSignup")}</button>
              </div>

              {tab === "login" ? (
                <form onSubmit={doLogin}>
                  <div className="fld"><label>{t("email")}</label>
                    <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
                  </div>
                  <div className="fld"><label>{t("password")}</label>
                    <div className="pw-wrap">
                      <input type={showPw ? "text" : "password"} autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
                      <button type="button" className="eye" aria-label={showPw ? t("hidePw") : t("showPw")} onClick={() => setShowPw((s) => !s)}>{showPw ? "🙈" : "👁"}</button>
                    </div>
                  </div>
                  <div className="rememberrow">
                    <label><input className="cb" type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />{t("rememberMe")}</label>
                    <Link className="glink" href="/forgot">{t("forgot")}</Link>
                  </div>
                  <div className="auth-msg">{loginMsg}</div>
                  <button className="btn primary" type="submit" disabled={loginBusy} style={{ width: "100%", marginTop: 2, padding: 11 }}>{loginBusy ? "…" : t("signInBtn")}</button>
                  <div className="switchline">{t("noAccountSignup").split("?")[0]}? <button type="button" onClick={() => setTab("signup")}>{t("tabSignup")}</button></div>
                </form>
              ) : (
                <form onSubmit={doSignup}>
                  <div className="fld"><label>{t("fullName")} *</label>
                    <input required value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" />
                  </div>
                  <div className="fld"><label>{t("nickname")} *</label>
                    <input required value={nickname} onChange={(e) => setNickname(e.target.value)} />
                    <div className="fieldhelp">{t("nicknameHelp")}</div>
                  </div>
                  <div className="fld"><label>{t("phoneLabel")} *</label>
                    <input required type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="08x-xxx-xxxx" />
                  </div>
                  <div className="fld"><label>{t("email")} *</label>
                    <input required type="email" autoComplete="email" value={suEmail} onChange={(e) => setSuEmail(e.target.value)} placeholder="name@example.com" />
                  </div>
                  <div className="fld"><label>{t("password")} *</label>
                    <div className="pw-wrap">
                      <input required type={showSuPw ? "text" : "password"} autoComplete="new-password" value={suPw} onChange={(e) => setSuPw(e.target.value)} />
                      <button type="button" className="eye" aria-label={showSuPw ? t("hidePw") : t("showPw")} onClick={() => setShowSuPw((s) => !s)}>{showSuPw ? "🙈" : "👁"}</button>
                    </div>
                    <div className="fieldhelp">{t("passwordHelp")}</div>
                  </div>
                  <div className="auth-msg">{suMsg}</div>
                  <button className="btn primary" type="submit" disabled={suBusy} style={{ width: "100%", marginTop: 8, padding: 11 }}>{suBusy ? "…" : t("createAccount")}</button>
                  <div className="switchline">{t("haveAccountLogin").split("?")[0]}? <button type="button" onClick={() => setTab("login")}>{t("tabLogin")}</button></div>
                </form>
              )}
            </>
          )}
        </div>
      </section>
      <div className="login-logo">FOLKPATHS</div>
    </div>
  );
}
