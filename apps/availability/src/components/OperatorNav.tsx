"use client";

import { Fragment, useEffect, useState } from "react";

// One shared left rail for every operator page. Sections are grouped by the
// operator's actual workflow: the everyday dispatch loop up top, the pay run
// next, then the set-up-once / check-rarely items under "Manage".
const GROUPS: { label?: string; items: { key: string; label: string; href: string }[] }[] = [
  {
    items: [
      { key: "dashboard", label: "Dashboard", href: "/dashboard" },
      { key: "bookings", label: "Bookings", href: "/bookings" },
      { key: "board", label: "Board", href: "/board" },
      { key: "jobs", label: "Jobs", href: "/jobs" },
    ],
  },
  {
    label: "Money",
    items: [
      { key: "payments", label: "Payments", href: "/payments" },
    ],
  },
  {
    label: "Manage",
    items: [
      { key: "reports", label: "Reports", href: "/reports" },
      { key: "tour-log", label: "Tour log", href: "/tour-log" },
      { key: "guides", label: "Guides", href: "/guides" },
      { key: "tours", label: "Tours", href: "/tours" },
      { key: "products", label: "Products", href: "/product-map" },
      { key: "meeting-points", label: "Meeting points", href: "/meeting-points" },
      { key: "blocked-slots", label: "Block slots", href: "/blocked-slots" },
      { key: "accounts", label: "Accounts", href: "/admin" },
    ],
  },
];

export function OperatorNav({ active }: { active?: string }) {
  // Pending sign-ups badge on Accounts — self-fetched so any page can drop in
  // the rail without threading the count through props.
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
    <nav className="op-nav" aria-label="Sections">
      <a href="/" className="op-nav-link op-home">Home</a>
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
  );
}

export default OperatorNav;
