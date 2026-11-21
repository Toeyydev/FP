// One wording for where a job's Extras cash is (owner, 21 Nov 2026: "รอไกด์โอน / บริษัทได้รับเงินแล้ว"),
// shared by the guide's Job Sheet, the staff view of it and Finance › Extras cash. The status is the
// server's CashSettlement status; nothing here decides it.

export type HandInTone = "wait" | "check" | "bad" | "ok" | "off";
export type HandInLabel = { th: string; en: string; tone: HandInTone };

export function handInLabel(status: string): HandInLabel {
  switch (status) {
    case "SUBMITTED": return { th: "ส่งสลิปแล้ว รอบริษัทตรวจ", en: "Slip sent — the company is checking", tone: "check" };
    case "RETURNED": return { th: "ตีกลับให้ไกด์แก้สลิป", en: "Returned to the guide — fix the slips, do not transfer again", tone: "bad" };
    case "CONFIRMED": return { th: "บริษัทได้รับเงินแล้ว", en: "Received by the company", tone: "ok" };
    case "REVERSED": return { th: "กลับรายการแล้ว", en: "Reversed", tone: "off" };
    default: return { th: "รอไกด์โอน", en: "Waiting for the guide's transfer", tone: "wait" };
  }
}

/** The dates that go with the status: last sent, confirmed (from the submission history). */
export function handInDates(history: { submittedAt: string; confirmedAt: string | null; status: string }[]): { sentAt: string | null; receivedAt: string | null } {
  const last = history[history.length - 1];
  const confirmed = [...history].reverse().find((h) => h.status === "CONFIRMED" && h.confirmedAt);
  return { sentAt: last?.submittedAt ?? null, receivedAt: confirmed?.confirmedAt ?? null };
}
