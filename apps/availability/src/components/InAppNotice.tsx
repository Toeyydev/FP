"use client";

import { useEffect, useState } from "react";

// In-app browsers (LINE, Facebook, Messenger, Instagram) can't install PWAs and
// often show a "not secure" warning. Detect them and tell the guide to open in Chrome.
export default function InAppNotice() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const ua = navigator.userAgent || "";
    const inApp = /\bLine\/|FBAN|FBAV|FB_IAB|Instagram|Messenger|MicroMessenger|GSA\//i.test(ua);
    const standalone = window.matchMedia?.("(display-mode: standalone)").matches
      || (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    setShow(inApp && !standalone);
  }, []);
  if (!show) return null;
  return (
    <div className="inapp-notice">
      <b>⚠ Open in Chrome to install</b>
      <div>You&apos;re in another app&apos;s browser (e.g. LINE) — it can&apos;t install Folkpath and may show &ldquo;not secure&rdquo;. Tap the <b>⋮</b> menu (top-right) → <b>Open in Chrome / browser</b>, then add to your home screen.</div>
    </div>
  );
}
