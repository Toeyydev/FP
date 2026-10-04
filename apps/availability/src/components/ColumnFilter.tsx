"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

// A column header with a ☰ filter, like a spreadsheet: tick the values to show. The list is
// the distinct values of the rows on screen, with a search for long ones. `selected` null
// means the column is not filtered. Fixed-position, so a scrolling table never clips it.

export type ColumnFilters = Record<string, Set<string> | null>;

/** Rows whose every filtered column holds one of the ticked values. */
export function applyColumnFilters<T>(rows: T[], filters: ColumnFilters, valueOf: Record<string, (row: T) => string>): T[] {
  const active = Object.entries(filters).filter(([k, s]) => s && valueOf[k]);
  if (!active.length) return rows;
  return rows.filter((r) => active.every(([k, s]) => s!.has(valueOf[k](r))));
}

/** The distinct values of one column, in display order. */
export function columnValues<T>(rows: T[], valueOf: (row: T) => string): string[] {
  return [...new Set(rows.map(valueOf))].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

export default function ColumnFilter({ label, values, selected, onChange }: {
  label: string;
  values: string[];
  selected: Set<string> | null;
  onChange: (next: Set<string> | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const width = 240;
    setPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const close = () => setOpen(false);
    // The page or the table scrolled: the list would float away from its column.
    const scrolled = (e: Event) => { if (!pop.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("scroll", scrolled, true);
    document.addEventListener("keydown", esc);
    window.addEventListener("resize", close);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); window.removeEventListener("resize", close); document.removeEventListener("scroll", scrolled, true); };
  }, [open]);

  const on = !!selected;
  const isTicked = (v: string) => !selected || selected.has(v);
  const shown = values.filter((v) => v.toLowerCase().includes(q.trim().toLowerCase()));
  const toggle = (v: string) => {
    const next = new Set(selected ?? values);
    next.has(v) ? next.delete(v) : next.add(v);
    // Every value ticked again is the same as no filter.
    onChange(values.every((x) => next.has(x)) ? null : next);
  };

  return (
    <span className="colf">
      <span>{label}</span>
      <button ref={btn} type="button" className={`colf-btn${on ? " on" : ""}`} aria-label={`Filter ${label}`} aria-expanded={open}
        title={on ? `Filtered: ${selected!.size} of ${values.length}` : `Filter ${label}`} onClick={() => { setQ(""); setOpen((o) => !o); }}>
        ☰{on ? <b>{selected!.size}</b> : null}
      </button>
      {open && pos && (
        <div ref={pop} className="colf-pop" role="dialog" aria-label={`Filter ${label}`} style={{ top: pos.top, left: pos.left }}>
          {values.length > 6 && <input className="colf-search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" aria-label={`Search ${label}`} />}
          <div className="colf-actions">
            <button type="button" onClick={() => onChange(null)}>All</button>
            <button type="button" onClick={() => onChange(new Set())}>None</button>
          </div>
          <div className="colf-list">
            {shown.length === 0 && <span className="colf-empty">Nothing matches</span>}
            {shown.map((v) => (
              <label key={v} className="colf-item">
                <input type="checkbox" checked={isTicked(v)} onChange={() => toggle(v)} />
                <span>{v || "(blank)"}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </span>
  );
}
