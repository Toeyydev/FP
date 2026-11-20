"use client";

// Ticket receipts — the guide's upload-only section for rows paid from the Company ADV
// (owner 2026-11-15). Not tour expenses: no amounts to change, nothing to claim. The guide
// uploads each ticket's receipt with the existing receipt upload (ReceiptFiles) and sees the
// operator's verdict: Verified, Rejected or a new receipt requested, with the note meant for them.

import ReceiptFiles, { type AttachmentView, type ReceiptChange } from "@/components/ReceiptFiles";
import { receiptRowStatus } from "@/lib/guide-fixed-expenses";
import type { Expense } from "@/lib/jobsheet";

type Props = {
  sheetKey: { guideId: string; date: string; slotIdx: number };
  rows: { row: Expense; index: number }[];
  attachments: Record<string, AttachmentView[]>;
  canUpload: boolean;
  locked: boolean;
  onChanged: (c: ReceiptChange) => void;
};

const chip = (bg: string, line: string, fg: string): React.CSSProperties => ({ fontSize: 12, fontWeight: 700, color: fg, background: bg, border: `1px solid ${line}`, borderRadius: 999, padding: "2px 9px", whiteSpace: "nowrap" });

export default function GuideTicketReceipts({ sheetKey, rows, attachments, canUpload, locked, onChanged }: Props) {
  if (!rows.length) return null;
  return (
    <section className="js-ticket-receipts" style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 14, display: "grid", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <h3 style={{ margin: 0 }}>Ticket receipts</h3><small style={{ color: "var(--ink-soft)" }}>ใบเสร็จค่าบัตร</small>
      </div>
      <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>Paid from the Company ADV — not part of your expenses. Upload the receipts only.</div>
      {rows.map(({ row, index }) => {
        const files = (row.rowId && attachments[row.rowId]) || [];
        const st = receiptRowStatus(files);
        const note = files.map((f) => f.reviewNote).filter(Boolean).at(-1);
        return (
          <div key={row.rowId ?? index} className="js-ticket-row" data-status={st} style={{ borderTop: "1px solid var(--line)", paddingTop: 8, display: "grid", gap: 4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <b style={{ fontSize: 14 }}>{row.description}</b>
              <span style={
                st === "VERIFIED" ? chip("var(--green-bg)", "var(--green-line)", "var(--green)")
                : st === "REJECTED" || st === "REPLACEMENT_REQUESTED" ? chip("var(--danger-bg)", "var(--danger-line)", "var(--danger)")
                : chip("var(--grey-bg)", "var(--line)", "var(--ink-soft)")}>
                {st === "VERIFIED" ? "✓ Verified" : st === "REJECTED" ? "Rejected" : st === "REPLACEMENT_REQUESTED" ? "New receipt needed" : st === "TO_REVIEW" ? "Uploaded · being checked" : "No receipt yet"}
              </span>
            </div>
            {(st === "REJECTED" || st === "REPLACEMENT_REQUESTED") && note && <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>Operator: “{note}”</div>}
            <ReceiptFiles compact sheetKey={sheetKey} row={row} index={index} files={files} canAdd={canUpload} locked={locked} onChanged={onChanged} />
          </div>
        );
      })}
    </section>
  );
}
