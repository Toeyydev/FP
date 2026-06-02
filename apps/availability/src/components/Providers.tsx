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
