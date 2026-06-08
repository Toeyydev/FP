"use client";

import { useLang } from "@/components/Providers";

// The #1 UX-review fix: never rely on colour alone. Each availability state gets a
// colour swatch + a word + an icon, so colour-blind guides (and everyone glancing
// at a busy month) can read the board instantly. Bilingual via the i18n seam.
export default function AvailabilityLegend() {
  const { t } = useLang();
  return (
    <div className="avail-legend" role="note" aria-label={t("legendTitle")}>
      <span className="al-item"><span className="al-sw al-free" aria-hidden />{t("legendFree")}</span>
      <span className="al-item"><span className="al-sw al-busy" aria-hidden>✕</span>{t("legendOccupied")}</span>
      <span className="al-item"><span className="al-sw al-booked" aria-hidden>🔒</span>{t("legendBooked")}</span>
      <span className="al-item"><span className="al-sw al-off" aria-hidden>–</span>{t("legendDayOff")}</span>
    </div>
  );
}
