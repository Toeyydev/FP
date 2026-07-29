"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";

// Thin-line outline icons (stroke, no fill) — minimal, premium.
const svg = (d: string) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{d.split("|").map((p, i) => <path key={i} d={p} />)}</svg>
);
const ICON: Record<string, React.ReactNode> = {
  home: svg("M3 10.5 12 3l9 7.5|M5 9.5V21h14V9.5"),
  calendar: svg("M7 3v3|M17 3v3|M4 8h16|M5 6h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z"),
  pay: svg("M3 7h18v10H3z|M3 11h18|M7 15h2"),
  user: svg("M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z|M5 21a7 7 0 0 1 14 0"),
  grid: svg("M4 4h7v7H4z|M13 4h7v7h-7z|M4 13h7v7H4z|M13 13h7v7h-7z"),
  list: svg("M8 6h13|M8 12h13|M8 18h13|M3.5 6h.01|M3.5 12h.01|M3.5 18h.01"),
  dispatch: svg("M12 21s7-6.7 7-12a7 7 0 1 0-14 0c0 5.3 7 12 7 12z|M12 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"),
  board: svg("M4 4h16v16H4z|M9 4v16|M15 4v16"),
  more: svg("M5 12h.01|M12 12h.01|M19 12h.01"),
};

type Item = { href: string; label: string; icon: string };

export default function BottomNav({ role }: { role?: string }) {
  const pathname = usePathname() || "/";
  const [more, setMore] = useState(false);
  if (!role || pathname.startsWith("/start") || pathname.startsWith("/signin") || pathname.startsWith("/claim") || pathname.startsWith("/reset") || pathname.startsWith("/forgot")) return null;

  const guide = role === "GUIDE";
  const items: Item[] = guide
    ? [
        { href: "/", label: "Home", icon: "home" },
        { href: "/?view=week", label: "Availability", icon: "calendar" },
        { href: "/pay", label: "Pay", icon: "pay" },
        { href: "/profile", label: "Profile", icon: "user" },
      ]
    : [
        { href: "/dashboard", label: "Dashboard", icon: "grid" },
        { href: "/bookings", label: "Bookings", icon: "list" },
        { href: "/jobs", label: "Dispatch", icon: "dispatch" },
        { href: "/", label: "Board", icon: "board" },
      ];
  const moreLinks: Item[] = [
    { href: "/payments", label: "Payments", icon: "pay" },
    { href: "/payment-slips", label: "Payment slips", icon: "list" },
    { href: "/reports", label: "Reports", icon: "grid" },
    { href: "/tour-log", label: "Tour log", icon: "list" },
    { href: "/guides", label: "Guides", icon: "user" },
    { href: "/tours", label: "Tours", icon: "board" },
    { href: "/blocked-slots", label: "Block slots", icon: "calendar" },
    { href: "/admin", label: "Accounts", icon: "user" },
  ];
  const active = (href: string) => href === "/" ? pathname === "/" : pathname.startsWith(href.split("?")[0]);

  return (
    <>
      <nav className="bottomnav">
        {items.map((it) => (
          <a key={it.label} href={it.href} className={`bn-item${active(it.href) ? " on" : ""}`}>{ICON[it.icon]}<span>{it.label}</span></a>
        ))}
        {!guide && <button type="button" className="bn-item" onClick={() => setMore(true)}>{ICON.more}<span>More</span></button>}
      </nav>
      {more && (
        <div className="bn-sheet-scrim" onClick={() => setMore(false)}>
          <div className="bn-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="bn-sheet-grab" />
            <div className="bn-sheet-grid">
              {moreLinks.map((it) => (
                <a key={it.label} href={it.href} className="bn-sheet-item">{ICON[it.icon]}<span>{it.label}</span></a>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
