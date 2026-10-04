"use client";

import { useState } from "react";
import { MEMO_MAX } from "@/lib/bank-memo";

// The bank memo (lib/bank-memo), shown and copied in one press, to paste into the bank app's
// บันทึกช่วยจำ before transferring. If the clipboard is refused, the text is selected instead.
export default function CopyMemo({ memo, label = "Bank memo" }: { memo: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  if (!memo.trim()) return null;
  const copy = async (e: React.MouseEvent<HTMLButtonElement>) => {
    const code = e.currentTarget.parentElement?.querySelector("code");
    try {
      await navigator.clipboard.writeText(memo);
      setCopied(true); setTimeout(() => setCopied(false), 1500);
    } catch {
      if (code) { const r = document.createRange(); r.selectNodeContents(code); const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(r); }
    }
  };
  return (
    <span className="js-bank-memo" style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12, flexWrap: "wrap" }} title="Type this into the bank app's memo (บันทึกช่วยจำ) before you transfer">
      <span style={{ color: "var(--ink-soft)" }}>{label} · บันทึกช่วยจำ</span>
      <code className="mono" style={{ padding: "1px 6px", border: "1px solid var(--line)", borderRadius: 4, userSelect: "all" }}>{memo}</code>
      <button type="button" className="btn sm js-copy-memo" onClick={copy}>{copied ? "Copied ✓" : "Copy"}</button>
      {memo.length > MEMO_MAX && <small style={{ color: "#b45309" }}>longer than {MEMO_MAX} characters — the bank may cut it</small>}
    </span>
  );
}
