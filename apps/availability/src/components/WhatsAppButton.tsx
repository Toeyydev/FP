// A guide's one-tap way to message a guest. Rendered only when the caller already holds
// a certain wa.me link — never for a number that had to be guessed.
//
// No target=_blank on purpose: phones claim wa.me as a universal link and hand the tap
// straight to WhatsApp. Opening a tab first lands on wa.me's own "Continue to Chat" page,
// so the guide would tap twice to reach the same chat. No message is pre-filled.
// Never printed: a guest's number does not belong on a paper job sheet.

export default function WhatsAppButton({ href, display, name }: { href: string; display: string; name?: string | null }) {
  return (
    <span className="no-print" style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <a
        className="btn sm"
        href={href}
        rel="noopener noreferrer"
        aria-label={`WhatsApp ${name?.trim() || display}`}
        style={{ minHeight: 44, minWidth: 44, display: "inline-flex", alignItems: "center", gap: 6, padding: "0 14px", fontWeight: 700, whiteSpace: "nowrap" }}
      >
        <span aria-hidden="true">💬</span> WhatsApp
      </a>
      <span style={{ fontSize: 12, color: "var(--ink-soft)", whiteSpace: "nowrap" }}>{display}</span>
    </span>
  );
}
