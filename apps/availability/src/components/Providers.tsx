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
    // Thai day-of-week colour (สีประจำวัน): theme the app accent by today's day,
    // recomputed in Bangkok time. Re-checked when the app regains focus so it
    // rolls over at midnight without a manual reload.
    const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const setDay = () => {
      const bkk = new Date(Date.now() + 7 * 3600 * 1000);
      document.documentElement.dataset.day = DAYS[bkk.getUTCDay()];
    };
    setDay();
    document.addEventListener("visibilitychange", setDay);
    // Register the PWA service worker (installable to home screen). Check for a
    // newer worker whenever the app regains focus, so a fresh deploy is picked up
    // promptly (the worker's activate step reloads open clients onto it).
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/service-worker.js").then((reg) => {
        const poke = () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); };
        document.addEventListener("visibilitychange", poke);
      }).catch(() => {});
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
    // Re-check every 2 min AND act on it, so an app left open in the foreground
    // still picks up a new deploy (not only when the tab is re-focused).
    const id = window.setInterval(() => { check().then(maybeReload); }, 120000);
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
