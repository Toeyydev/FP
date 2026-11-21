"use client";

import { useEffect, useState } from "react";
import { HandInStatusCard, type View } from "@/components/UpsellHandIn";

// The Extras cash of one job, as staff see it in the Job Sheet's Finance & accounting panel (owner,
// 21 Nov 2026): every sale (Sale Ref), the Job Ref the guide puts in the transfer memo, the Hand-in
// Ref, where the cash is (รอไกด์โอน / บริษัทได้รับเงินแล้ว), the dates and the slips. Read only —
// confirming or returning a hand-in stays on Finance › Extras cash. Draws nothing while Extras is
// off (404), for a job with no Extras, or when the server cannot be reached.

const baht = (s: number) => `฿${(s / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const head = { fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--ink-soft)", fontWeight: 700 } as const;

export default function UpsellJobStaff({ guideId, date, slotIdx }: { guideId: string; date: string; slotIdx: number }) {
  const [v, setV] = useState<View | null>(null);
  useEffect(() => {
    let live = true;
    void fetch(`/api/upsell/hand-in/by-job?guideId=${encodeURIComponent(guideId)}&date=${date}&slotIdx=${slotIdx}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null)).then((d) => { if (live) setV(d?.view ?? null); }).catch(() => { if (live) setV(null); });
    return () => { live = false; };
  }, [guideId, date, slotIdx]);

  const sales = v?.sales ?? [];
  if (!v || (sales.length === 0 && v.slips.length === 0 && v.transfers.length === 0)) return null;
  const total = sales.filter((s) => s.status !== "REVERSED").reduce((n, s) => n + s.grossSatang, 0);
  return (
    <div className="js-extras-staff" style={{ marginBottom: 12 }}>
      <div style={head}>Extras cash · เงินขายเพิ่ม</div>
      <div style={{ fontSize: 12.5, margin: "4px 0 6px", overflowWrap: "anywhere" }}>
        Job Ref <b className="js-extras-jobref">{v.jobRef ?? "—"}</b>{v.settlementNo ? <> · Hand-in <b className="js-extras-handin">{v.settlementNo}</b></> : null}
      </div>
      <ul className="js-extras-sales" style={{ listStyle: "none", margin: "0 0 8px", padding: 0, fontSize: 12.5, display: "grid", gap: 2 }}>
        {sales.map((s) => (
          <li key={s.saleNo} className="js-extras-sale" style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <span style={{ minWidth: 0, overflowWrap: "anywhere", textDecoration: s.status === "REVERSED" ? "line-through" : "none" }}>{s.saleNo} · {s.productName} · {s.guests} {s.guests === 1 ? "guest" : "guests"}</span>
            <b style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{baht(s.grossSatang)}</b>
          </li>
        ))}
        {sales.length > 1 && <li style={{ display: "flex", justifyContent: "space-between", gap: 8, borderTop: "1px solid var(--line)", paddingTop: 2 }}><span>Total sold</span><b style={{ fontVariantNumeric: "tabular-nums" }}>{baht(total)}</b></li>}
      </ul>
      <HandInStatusCard v={v} staff />
      <a href="/upsell-cash" style={{ display: "inline-block", marginTop: 6, fontSize: 12, fontWeight: 700 }}>Open Extras cash →</a>
    </div>
  );
}
