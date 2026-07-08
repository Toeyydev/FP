"use client";

import { useLang } from "@/components/Providers";

// One consistent tab bar for every guide screen, so the app feels the same
// everywhere (same on Android and iPhone — it's the same web UI). Schedule/Week
// live in the main app; Pay and Me are their own pages.
export function GuideTabs({ active }: { active: "schedule" | "week" | "pay" | "me" }) {
  const { t } = useLang();
  const tabs: { k: string; label: string; href: string }[] = [
    { k: "schedule", label: t("schedule"), href: "/?view=schedule" },
    { k: "week", label: t("week"), href: "/?view=week" },
    { k: "pay", label: t("payNav"), href: "/pay" },
    { k: "me", label: t("myDetails"), href: "/profile" },
  ];
  return (
    <nav className="gtabs" aria-label="Guide sections">
      {tabs.map((tab) => (
        <a key={tab.k} href={tab.href} className={`gtab${active === tab.k ? " on" : ""}`} aria-current={active === tab.k ? "page" : undefined}>{tab.label}</a>
      ))}
    </nav>
  );
}
