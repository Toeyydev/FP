"use client";

import { SessionProvider } from "next-auth/react";
import { createContext, useContext, useEffect, useState } from "react";
import { STRINGS, type Lang, type StringKey } from "@/lib/i18n";

type LangCtx = { lang: Lang; setLang: (l: Lang) => void; t: (k: StringKey) => string };
const Ctx = createContext<LangCtx>({ lang: "en", setLang: () => {}, t: (k) => STRINGS.en[k] });

export function useLang() {
  return useContext(Ctx);
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");

  useEffect(() => {
    const saved = localStorage.getItem("folkpath:lang");
    if (saved === "th" || saved === "en") setLangState(saved);
    // Register the PWA service worker (installable to home screen).
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  // Auto-update: detect when a newer version has been deployed and refresh when
  // the user next returns to the app (never interrupts active use). No manual
  // sign-out / cache-clear needed.
  useEffect(() => {
    const loaded = process.env.NEXT_PUBLIC_BUILD_ID || "dev";
    if (loaded === "dev") return; // skip locally
    let serverVer = "";
    const check = async () => {
      try {
        const r = await fetch("/api/version", { cache: "no-store" });
        const d = await r.json();
        if (d?.version) serverVer = d.version;
      } catch { /* offline — try later */ }
    };
    const maybeReload = () => {
      if (document.visibilityState !== "visible") return;
      if (!serverVer || serverVer === loaded) return;
      // Reload AT MOST ONCE per server-version per session. If a stale cache makes
      // the reload come back on the same old version, we won't reload again — so it
      // can never get stuck in a reload loop.
      try {
        if (sessionStorage.getItem("fp_upd") === serverVer) return;
        sessionStorage.setItem("fp_upd", serverVer);
      } catch { return; }
      window.location.reload();
    };
    document.addEventListener("visibilitychange", maybeReload);
    check();
    const id = window.setInterval(check, 120000); // every 2 min
    return () => { window.clearInterval(id); document.removeEventListener("visibilitychange", maybeReload); };
  }, []);

  const setLang = (l: Lang) => {
    setLangState(l);
    localStorage.setItem("folkpath:lang", l);
  };

  const t = (k: StringKey) => STRINGS[lang][k] ?? STRINGS.en[k] ?? k;

  return (
    <SessionProvider>
      <Ctx.Provider value={{ lang, setLang, t }}>{children}</Ctx.Provider>
    </SessionProvider>
  );
}
