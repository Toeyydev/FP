"use client";

import { useEffect, useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";

// "Set up Face ID / fingerprint" — registers a passkey for the logged-in user.
export default function PasskeySetup() {
  const [supported, setSupported] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setSupported(typeof window !== "undefined" && !!window.PublicKeyCredential); }, []);
  if (!supported) return null;

  async function setup() {
    setBusy(true); setMsg("");
    try {
      const opts = await fetch("/api/passkey/register-options", { method: "POST" }).then((r) => r.json());
      if (opts?.error) throw new Error(opts.error);
      const att = await startRegistration(opts);
      const r = await fetch("/api/passkey/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(att) });
      setMsg(r.ok ? "✓ Set up" : "Failed");
    } catch { setMsg("Cancelled"); }
    setBusy(false);
  }
  return <button className="btn sm" disabled={busy} onClick={setup} title="Set up Face ID / fingerprint sign-in for this device">🔑 {msg || "Set up Face ID"}</button>;
}
