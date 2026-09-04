"use client";

import { Fragment, useEffect, useState, type ReactNode } from "react";
import { signOut } from "next-auth/react";

// One shared sidebar for every operator page — same structure everywhere (as the
// Dashboard): the workflow-grouped rail, an optional footer slot (the Dashboard
// drops its Google Drive status here), and Sign out pinned at the bottom.
// Grouped Operations / Finance / Reporting / Settings — existing pages only
// (no dead links; Expenses / PEAK Sync / Logs pages join their groups when built).
const GROUPS: { label?: string; items: { key: string; label: string; href: string }[] }[] = [
  {
    items: [
      { key: "dashboard", label: "Dashboard", href: "/dashboard" },
    ],
  },
  {
    label: "Operations",
    items: [
      { key: "reservations", label: "Reservations", href: "/reservations" },
      { key: "bookings", label: "Bookings", href: "/bookings" },
      { key: "board", label: "Availability board", href: "/board" },
      { key: "jobs", label: "Jobs", href: "/jobs" },
      { key: "guides", label: "Guides", href: "/guides" },
      { key: "tours", label: "Tours", href: "/tours" },
      { key: "blocked-slots", label: "Block slots", href: "/blocked-slots" },
    ],
  },
  {
    label: "Finance",
    items: [
      { key: "payments", label: "Payments", href: "/payments" },
      { key: "payment-batches", label: "Payment batches", href: "/payment-batches" },
      { key: "payment-slips", label: "Payment slips", href: "/payment-slips" },
    ],
  },
  {
    label: "Accounting",
    items: [
      { key: "peak-sync", label: "PEAK sync", href: "/peak-sync" },
      { key: "accounting-logs", label: "Accounting logs", href: "/accounting-logs" },
    ],
  },
  {
    label: "Reporting",
    items: [
      { key: "reports", label: "Reports", href: "/reports" },
      { key: "tour-log", label: "Tour log", href: "/tour-log" },
    ],
  },
  {
    label: "Settings",
    items: [
      { key: "accounts", label: "Accounts", href: "/admin" },
    ],
  },
];

export function OperatorNav({ active, children }: { active?: string; children?: ReactNode }) {
  // Pending sign-ups badge on Accounts — self-fetched so any page can drop in
  // the sidebar without threading the count through props.
  const [pending, setPending] = useState(0);
  useEffect(() => {
    let ok = true;
    fetch("/api/admin/pending-count", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (ok && j && typeof j.count === "number") setPending(j.count); })
      .catch(() => {});
    return () => { ok = false; };
  }, []);

  return (
    <div className="op-side">
      <nav className="op-nav" aria-label="Sections">
        <a href="/" className="op-brand" title="Home">
          <b>FolkOPS</b>
          <span>Operations</span>
        </a>
        {GROUPS.map((g, gi) => (
          <Fragment key={gi}>
            {g.label && <span className="op-nav-group">{g.label}</span>}
            {g.items.map((s) => (
              <a
                key={s.key}
                href={s.href}
                className={`op-nav-link${active === s.key ? " active" : ""}`}
                aria-current={active === s.key ? "page" : undefined}
              >
                {s.label}
                {s.key === "accounts" && pending > 0 && <span className="navbadge op-nav-badge">{pending}</span>}
              </a>
            ))}
          </Fragment>
        ))}
      </nav>
      {children}
      <button
        type="button"
        className="btn sm ghost op-signout"
        onClick={async () => { await fetch("/api/session/logout", { method: "POST" }); signOut({ callbackUrl: "/start" }); }}
      >
        Sign out
      </button>
    </div>
  );
}

export default OperatorNav;
