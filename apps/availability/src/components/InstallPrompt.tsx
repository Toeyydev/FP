"use client";

import { useEffect, useState } from "react";

type BIPEvent = Event & { prompt: () => void; userChoice: Promise<unknown> };

// A friendly, no-jargon "add to home screen" helper. Android shows a one-tap
// Install button; iPhone shows the Share → Add to Home Screen steps. Guides
// never NEED this (the app works in the browser) — it's just convenience.
export default function InstallPrompt() {
  const [deferred, setDeferred] = useState<BIPEvent | null>(null);
  const [show, setShow] = useState(false);
  const [ios, setIos] = useState(false);
  const [android, setAndroid] = useState(false);

  useEffect(() => {
    const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
    if (standalone) return; // already installed
    try { if (sessionStorage.getItem("fp_install_dismissed")) return; } catch { /* ignore */ }

    const ua = navigator.userAgent;
    const inApp = /\bLine\/|FBAN|FBAV|FB_IAB|Instagram|Messenger|MicroMessenger/i.test(ua); // InAppNotice handles these
    if (inApp) return;
    const isiOS = /iphone|ipad|ipod/i.test(ua) && !/crios|fxios|edgios/i.test(ua); // Safari on iOS
    const isAndroid = /android/i.test(ua);
    const onBip = (e: Event) => { e.preventDefault(); setDeferred(e as BIPEvent); setShow(true); };
    window.addEventListener("beforeinstallprompt", onBip);
    if (isiOS) { setIos(true); setShow(true); }
    else if (isAndroid) { setAndroid(true); setShow(true); } // show steps even if Chrome doesn't fire the prompt
    return () => window.removeEventListener("beforeinstallprompt", onBip);
  }, []);

  if (!show) return null;
  // Dismiss for this session only, so it can resurface (no permanent hide).
  const dismiss = () => { setShow(false); try { sessionStorage.setItem("fp_install_dismissed", "1"); } catch { /* ignore */ } };

  return (
    <div className="install-card">
      <div style={{ flex: 1 }}>
        <b>📲 Add Folkpaths to your home screen</b>
        {ios && <div style={{ fontSize: 13, marginTop: 3 }}>Tap <b>Share</b> <span style={{ fontSize: 15 }}>⬆️</span> at the bottom of Safari, then <b>&ldquo;Add to Home Screen&rdquo;</b>.</div>}
        {android && !deferred && <div style={{ fontSize: 13, marginTop: 3 }}>In <b>Chrome</b>, tap <b>⋮</b> (top-right) → <b>Install app</b> (or <b>Add to Home screen</b>).</div>}
        {android && deferred && <div style={{ fontSize: 13, marginTop: 3 }}>One tap to keep it like an app.</div>}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {deferred && <button className="btn primary" onClick={async () => { deferred.prompt(); await deferred.userChoice; dismiss(); }}>Install</button>}
        <button className="btn ghost" onClick={dismiss}>Later</button>
      </div>
    </div>
  );
}
