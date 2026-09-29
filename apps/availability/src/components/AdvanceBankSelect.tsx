"use client";

import { useEffect, useState } from "react";

export default function AdvanceBankSelect({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [bank, setBank] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/advances/peak-config")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => { if (live) setBank(data?.bank ?? null); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  return (
    <label>
      บัญชีธนาคารบริษัท
      <select value={value} disabled={disabled || !bank} onChange={(event) => onChange(event.target.value)}>
        <option value="">{bank ? "เลือกบัญชีที่เงินจริงเข้า–ออก" : "รอตั้งค่าบัญชีสำหรับ PEAK"}</option>
        {bank && <option value={bank.id}>{bank.name}</option>}
      </select>
    </label>
  );
}
