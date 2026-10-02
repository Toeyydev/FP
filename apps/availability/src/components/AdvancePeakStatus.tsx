import { BOOKED_IN_GUIDE_PAYMENT, isBookedInGuidePayment } from "@/lib/advances/rules";

export type AdvancePeakState = { status: string; documentNo: string | null; error: string | null };

const labels: Record<string, string> = {
  PENDING: "รอส่ง PEAK",
  BLOCKED: "รอตรวจข้อมูล",
  SENDING: "กำลังส่ง PEAK",
  UNCERTAIN: "ตรวจเอกสารใน PEAK ก่อนส่งซ้ำ",
  POSTED: "ส่ง PEAK แล้ว",
  CANCELLED: "ยกเลิกการส่ง",
};

export default function AdvancePeakStatus({ state }: { state?: AdvancePeakState | null }) {
  if (!state) return null;
  // Recorded as carried by the job's guide-payment document (lib/advances/booked-in-guide-payment):
  // say that in words, not with the stored marker.
  if (isBookedInGuidePayment(state)) {
    return (
      <div className="js-peak-booked" style={{ fontSize: 12, marginTop: 4 }} role="status">
        <span>Booked in guide payment <span className="mono">{state.documentNo}</span> — not posted to PEAK again</span>
        <div className="muted" style={{ whiteSpace: "normal", maxWidth: 280 }}>{(state.error ?? "").replace(`${BOOKED_IN_GUIDE_PAYMENT}: `, "")}</div>
      </div>
    );
  }
  return (
    <div style={{ fontSize: 12, marginTop: 4 }} role="status">
      <span>{state.documentNo || labels[state.status] || state.status}</span>
      {state.error && <div className="muted" style={{ whiteSpace: "normal", maxWidth: 280 }}>{state.error}</div>}
    </div>
  );
}
