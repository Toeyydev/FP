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
  return (
    <div style={{ fontSize: 12, marginTop: 4 }} role="status">
      <span>{state.documentNo || labels[state.status] || state.status}</span>
      {state.error && <div className="muted" style={{ whiteSpace: "normal", maxWidth: 280 }}>{state.error}</div>}
    </div>
  );
}
