"use client";

import { useEffect, useState } from "react";
import { useLang } from "@/components/Providers";

// A friendly one-time intro for a guide's first visit. Explains the app in a
// few lines so nobody feels lost. Shown once (localStorage), dismissible.
export default function GuideWelcome() {
  const { t } = useLang();
  const [show, setShow] = useState(false);
  useEffect(() => { try { if (!localStorage.getItem("fp_guide_welcomed")) setShow(true); } catch { /* ignore */ } }, []);
  if (!show) return null;
  const close = () => { setShow(false); try { localStorage.setItem("fp_guide_welcomed", "1"); } catch { /* ignore */ } };

  const Row = ({ icon, title, sub }: { icon: string; title: string; sub: string }) => (
    <div className="welcome-row"><span className="welcome-ic">{icon}</span><div><b>{title}</b><div style={{ fontSize: 13, color: "var(--ink-soft,#777)" }}>{sub}</div></div></div>
  );

  return (
    <div className="scrim show" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal" style={{ maxWidth: 420 }}>
        <h3>👋 {t("welcomeTitle")}</h3>
        <div className="mbody" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Row icon="📅" title={t("welcomeTours")} sub={t("welcomeToursSub")} />
          <Row icon="🟢" title={t("welcomeAvail")} sub={t("welcomeAvailSub")} />
          <Row icon="🧭" title={t("welcomeOffers")} sub={t("welcomeOffersSub")} />
          <Row icon="📝" title={t("welcomeDetails")} sub={t("welcomeDetailsSub")} />
        </div>
        <div className="mfoot"><button className="btn primary" style={{ width: "100%", padding: 12 }} onClick={close}>{t("welcomeGotIt")}</button></div>
      </div>
    </div>
  );
}
