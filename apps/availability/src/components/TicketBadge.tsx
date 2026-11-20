// A booking's entrance-ticket status as the guide sees it: on the job sheet's customer list
// and on Guide Schedule → tour details. The value is the job sheet's Tickets tag, or the
// booking's Rate where the Rate says so (lib/rate-kind). Anything else renders nothing:
// owner decision 2026-11-11 (Option A) — no badge rather than an "unknown" one on every row.

export default function TicketBadge({ tickets }: { tickets: string | null | undefined }) {
  if (tickets !== "included" && tickets !== "not") return null;
  const inc = tickets === "included";
  return (
    <span
      className={`js-ticket-badge ${inc ? "is-included" : "is-not"}`}
      title={inc ? "Entrance tickets are included in this booking" : "Entrance tickets are not included in this booking"}
      style={{
        display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 700, lineHeight: 1.4,
        padding: "2px 8px", borderRadius: 999, border: "1px solid", whiteSpace: "nowrap",
        color: inc ? "var(--green)" : "var(--assign)",
        background: inc ? "var(--green-bg)" : "var(--assign-bg)",
        borderColor: inc ? "var(--green-line)" : "var(--assign-line)",
      }}
    >
      {inc ? "✓ Included" : "✕ Not included"}
    </span>
  );
}
