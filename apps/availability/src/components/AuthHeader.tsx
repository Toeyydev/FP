"use client";

import Link from "next/link";
import { useLang } from "@/components/Providers";

export function AuthHeader({ backHref }: { backHref?: string }) {
  const { t, lang, setLang } = useLang();
  return (
    <header className="app">
      <div className="brand">
        <div className="wordmark">FOLKPATHS</div>
        <div className="th-name">บริษัท โฟล์คพาธส์ จำกัด</div>
      </div>
      <div className="spacer" />
      {backHref && <Link className="btn sm ghost" href={backHref}>{t("back")}</Link>}
      <button className="btn sm ghost" onClick={() => setLang(lang === "en" ? "th" : "en")}>
        {lang === "en" ? "ไทย" : "EN"}
      </button>
    </header>
  );
}
