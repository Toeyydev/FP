"use client";

import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import { useLang } from "@/components/Providers";

const LANGS = ["Thai", "English", "Chinese (Mandarin)", "Japanese", "Korean", "French", "German", "Spanish", "Russian"];
const TOURS: [string, string][] = [
  ["T-001", "Grand Palace, Wat Pho & Wat Arun (08:30)"],
  ["T-002", "Grand Palace, Wat Pho & Wat Arun (13:30)"],
  ["T-003", "Wat Pho & Wat Arun (10:00)"],
  ["T-004", "Wat Pho & Wat Arun (15:00)"],
  ["T-005", "Wat Phra Kaew & Grand Palace (14:00)"],
  ["T-006", "Wat Pho Evening — Temple Cats (17:30)"],
  ["T-007", "Eat Like a Local — China Town (16:30)"],
  ["T-008", "Eat Like a Local — China Town (17:30)"],
  ["T-009", "Eat Like a Local — China Town (18:30)"],
];

type Step = "code" | "otp" | "pw" | "onboard" | "done";

async function post(body: unknown) {
  const r = await fetch("/api/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}

export default function ClaimPage() {
  const { t } = useLang();
  const router = useRouter();
  const [step, setStep] = useState<Step>("code");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [code, setCode] = useState("");
  // Operator-sent link form: /claim?c=SELECTOR-SECRET pre-fills the code.
  useEffect(() => {
    const c = new URLSearchParams(window.location.search).get("c");
    if (c) setCode(c);
  }, []);
  const [ident, setIdent] = useState<{ guideId: string | null; displayName: string; maskedTo: string | null }>({ guideId: null, displayName: "", maskedTo: null });
  const [devCode, setDevCode] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [pw, setPw] = useState(""); const [pw2, setPw2] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [langs, setLangs] = useState<string[]>(["Thai", "English"]);
  const [quals, setQuals] = useState<string[]>([]);
  const [consent, setConsent] = useState(false);
  const [email, setEmail] = useState("");

  const errText = (e: string) =>
    ({ invalid: t("errInvalidCode"), expired: t("errExpiredCode"), format: t("errInvalidCode"),
       wrong: t("errWrongOtp"), locked: t("errOtpLocked"), cooldown: t("errCooldown") } as Record<string, string>)[e] || t("errGeneric");

  async function doStart() {
    setBusy(true); setMsg("");
    const r = await post({ action: "start", code });
    setBusy(false);
    if (!r.ok) { setMsg(errText(r.data.error)); return; }
    setIdent({ guideId: r.data.guideId, displayName: r.data.displayName, maskedTo: r.data.maskedTo });
    setDisplayName(r.data.displayName || "");
    setDevCode(r.data.devCode ?? null);
    setStep("otp");
  }
  async function doResend() {
    setMsg("");
    const r = await post({ action: "resend" });
    if (!r.ok) { setMsg(errText(r.data.error)); return; }
    setDevCode(r.data.devCode ?? null);
    setMsg(t("resent"));
  }
  async function doVerify() {
    setBusy(true); setMsg("");
    const r = await post({ action: "verify", otp });
    setBusy(false);
    if (!r.ok) { setMsg(errText(r.data.error)); return; }
    setStep("pw");
  }
  function doPw() {
    setMsg("");
    if (pw.length < 8) { setMsg(t("pwShort")); return; }
    if (pw !== pw2) { setMsg(t("pwMismatch")); return; }
    setStep("onboard");
  }
  async function doComplete() {
    setMsg("");
    if (!consent) { setMsg(t("consentRequired")); return; }
    setBusy(true);
    const r = await post({ action: "complete", password: pw, displayName, languages: langs, qualifications: quals, consent: true });
    if (!r.ok) { setBusy(false); setMsg(t("errGeneric")); return; }
    setEmail(r.data.email);
    setStep("done");
    // auto sign-in with the password just set
    const res = await signIn("credentials", { email: r.data.email, password: pw, redirect: false });
    setBusy(false);
    if (res?.error) { router.push("/start"); return; }
    router.push("/"); router.refresh();
  }

  const stepNo = { code: 1, otp: 2, pw: 3, onboard: 4, done: 5 }[step];
  const toggle = (arr: string[], v: string, set: (x: string[]) => void) =>
    set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  return (
    <div className="wrap">
      <AuthHeader backHref="/start" />
      <section className="panel narrow">
        <div className="stepbar" style={{ paddingTop: 18 }}>
          {[1, 2, 3, 4, 5].map((n) => <i key={n} className={n <= stepNo ? "on" : ""} />)}
        </div>

        {step === "code" && (
          <div className="auth-card">
            <h2>{t("claimTitle")}</h2>
            <p className="sub">{t("claimCodeHint")}</p>
            <div className="fld"><label>{t("codeLabel")}</label>
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t("codePlaceholder")} onKeyDown={(e) => e.key === "Enter" && doStart()} />
            </div>
            <div className="auth-msg">{msg}</div>
            <button className="btn primary" style={{ width: "100%", padding: 11 }} disabled={busy} onClick={doStart}>{t("cont")}</button>
          </div>
        )}

        {step === "otp" && (
          <div className="auth-card">
            <h2>{t("verifyTitle")}</h2>
            <p className="sub">{t("verifyHint")} {ident.maskedTo ? `(${ident.maskedTo})` : ""}</p>
            <div className="identbox">Claiming <b>{ident.guideId ?? "account"}</b> · {ident.displayName}</div>
            {devCode && <div className="devbox">DEV — OTP sent: <code>{devCode}</code> (no real email in prototype)</div>}
            <div className="fld"><label>{t("otpLabel")}</label>
              <input value={otp} inputMode="numeric" maxLength={6} onChange={(e) => setOtp(e.target.value)} placeholder="000000" onKeyDown={(e) => e.key === "Enter" && doVerify()} />
            </div>
            <div className="auth-msg">{msg}</div>
            <div className="linkrow">
              <button className="btn primary" style={{ flex: 1, padding: 11 }} disabled={busy} onClick={doVerify}>{t("cont")}</button>
              <button className="btn ghost" onClick={doResend}>{t("resendCode")}</button>
            </div>
          </div>
        )}

        {step === "pw" && (
          <div className="auth-card">
            <h2>{t("pwTitle")}</h2>
            <div className="fld"><label>{t("newPassword")}</label><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} /></div>
            <div className="fld"><label>{t("confirmPassword")}</label><input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} onKeyDown={(e) => e.key === "Enter" && doPw()} /></div>
            <div className="auth-msg">{msg}</div>
            <button className="btn primary" style={{ width: "100%", padding: 11 }} onClick={doPw}>{t("cont")}</button>
          </div>
        )}

        {step === "onboard" && (
          <div className="auth-card">
            <h2>{t("onboardTitle")}</h2>
            <div className="fld"><label>{t("displayNameLabel")}</label><input value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></div>
            <div className="fld"><label>{t("languagesLabel")}</label>
              <div className="chips">
                {LANGS.map((l) => <span key={l} className={`chip-pick ${langs.includes(l) ? "on" : ""}`} onClick={() => toggle(langs, l, setLangs)}>{l}</span>)}
              </div>
            </div>
            <div className="fld"><label>{t("qualsLabel")}</label>
              <div className="qual-grid">
                {TOURS.map(([id, name]) => (
                  <label key={id} className={quals.includes(id) ? "on" : ""}>
                    <input type="checkbox" checked={quals.includes(id)} onChange={() => toggle(quals, id, setQuals)} />
                    <span><b>{id}</b> · {name}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="fld">
              <label className="checkrow"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> <span>{t("consentLabel")}</span></label>
            </div>
            <div className="auth-msg">{msg}</div>
            <button className="btn primary" style={{ width: "100%", padding: 11 }} disabled={busy} onClick={doComplete}>{t("finish")}</button>
          </div>
        )}

        {step === "done" && (
          <div className="auth-card">
            <h2>{t("claimDoneTitle")}</h2>
            <p className="sub">{t("claimDoneBody")}</p>
            <div className="identbox">{email}</div>
          </div>
        )}
      </section>
    </div>
  );
}
