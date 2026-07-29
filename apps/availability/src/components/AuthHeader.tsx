"use client";

import Link from "next/link";
import { useLang } from "@/components/Providers";

export function AuthHeader({ backHref, home = true }: { backHref?: string; home?: boolean }) {
  const { t, lang, setLang } = useLang();
  return (
    <header className="app">
      {home && <Link className="btn sm ghost" href="/">Home</Link>}
      <div className="spacer" />
      {backHref && <Link className="btn sm ghost" href={backHref}>{t("back")}</Link>}
      <button className="btn sm ghost" onClick={() => setLang(lang === "en" ? "th" : "en")}>
        {lang === "en" ? "ไทย" : "EN"}
      </button>
    </header>
  );
}
