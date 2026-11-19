"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import OperatorNav from "@/components/OperatorNav";
import { PAX_PER_GUIDE } from "@/lib/capacity";

// Settings › Upsell products (PR2) — the list and one product's settings, as mockup v3.
//
// Admin edits; Accountant sees the same page with every control disabled and no buttons.
// Saving an unsold version edits it; saving a sold one creates the next version (the server
// decides — lib/upsell/products). Every request names the product state it was shown, so a
// product someone else changed meanwhile is refused, never overwritten.
//
// Nothing on this page sells: a product is live only while it is Active AND its switch is on
// in Railway, and every switch is off.

type ProductType = "ROUTE_EXTENSION" | "NEW_TOUR" | "JOIN_SOURCE_TOUR";
type ListItem = {
  code: string; name: string; type: ProductType; typeLabel: string; unitPriceSatang: number | null; pricingBasis: string | null;
  versionLabel: string; active: boolean; switchOn: boolean; live: boolean; status: LiveStatus;
};
type LiveStatus = "INACTIVE" | "SWITCH_OFF" | "NOT_ON_SALE_TODAY" | "LIVE";
type TourOption = { id: string; name: string; time: string };
/** "08.30 AM" → "08:30" */
const clock = (time: string) => time.replace(/\s*(AM|PM)$/i, "").replace(".", ":");
type Form = {
  price: string; pricingBasis: string; paymentMethods: string[]; discount: string; refundPolicy: string; revenueCategory: string;
  taxProfileId: string; serviceValidityDays: number | null; fixedCostPerGuest: string; incentivePerGuest: string; eligibleTourIds: string[];
  activeFrom: string; activeTo: string | null;
};
type Detail = {
  canEdit: boolean; today: string; locked: boolean; latestVersion: number; latestSales: number;
  product: { code: string; name: string; type: ProductType; typeLabel: string; updatedAt: string; active: boolean; switchOn: boolean; live: boolean; status: LiveStatus; needsTours: boolean };
  form: Form;
  fixed: { serviceTour: { id: string; name: string } | null; capacityGroupKey: string | null; fixedCostCategory: string; remittanceMethod: string; allowsOtaMix: boolean };
  options: {
    taxProfiles: { id: string; code: string; name: string; status: string }[];
    revenueCategory: { key: string; mapped: boolean }; fixedCostCategoryMapped: boolean;
    onsiteTours: TourOption[]; tours: TourOption[];
  };
  versions: { version: number; activeFrom: string; activeTo: string | null; unitPriceSatang: number; fixedCostPerGuestSatang: number; incentivePerGuestSatang: number; eligibleTourIds: string[]; sales: number; locked: boolean; createdBy: string }[];
};

const SWITCH_NAME: Record<ProductType, string> = {
  ROUTE_EXTENSION: "UPSELL_ROUTE_EXTENSION_ENABLED", NEW_TOUR: "UPSELL_FOOD_TOUR_ENABLED", JOIN_SOURCE_TOUR: "UPSELL_ONSITE_TOUR_ENABLED",
};
const C = { ink: "#18181B", soft: "#52525B", softer: "#5F5F67", brand: "#0E3B2E", line: "#E5E7EB", rule: "#F0F0F0", field: "#8A8A93", warn: "#6B4508" };
const baht = (satang: number) => `฿${(satang / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const shortDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const addDays = (d: string, n: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

// Live needs Active + its switch + a version on sale today; otherwise the first missing one.
const TONE: Record<LiveStatus, { bg: string; fg: string; mark: string; text: string }> = {
  LIVE: { bg: "#EAF4EF", fg: "#0B6136", mark: "●", text: "Active · live" },
  SWITCH_OFF: { bg: "#FBF4E4", fg: C.warn, mark: "●", text: "Active · switch off" },
  NOT_ON_SALE_TODAY: { bg: "#FBF4E4", fg: C.warn, mark: "●", text: "Active · no version on sale today" },
  INACTIVE: { bg: "#F4F4F5", fg: C.soft, mark: "○", text: "Inactive" },
};
function Status({ p }: { p: { status: LiveStatus } }) {
  const tone = TONE[p.status];
  return (
    <span className="up-status" style={{ flex: "0 0 auto", display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 10px", borderRadius: 99, background: tone.bg, color: tone.fg, fontSize: 12.5, fontWeight: 650 }}>
      <span aria-hidden="true">{tone.mark}</span> {tone.text}
    </span>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="op-layout">
      <OperatorNav active="upsell-products" />
      <div className="op-main" style={{ color: C.ink, fontSize: 14 }}>
        <div style={{ maxWidth: 1040, margin: "0 auto", padding: "8px 16px 40px", boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 16 }}>{children}</div>
      </div>
    </div>
  );
}

// ── list ─────────────────────────────────────────────────────────────────────

export function UpsellProductList() {
  const [items, setItems] = useState<ListItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/admin/upsell-products", { cache: "no-store" })
      .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(); setItems(d.products ?? []); })
      .catch(() => setErr("Could not load the upsell products."));
  }, []);
  return (
    <Shell>
      <div style={{ fontSize: 12.5, color: C.softer }}>Settings › Upsell products</div>
      <h1 style={{ margin: 0, fontSize: 22, fontWeight: 650 }}>Upsell products</h1>
      {err && <div role="alert" style={{ color: "var(--danger)" }}>{err}</div>}
      {!items && !err && <p style={{ color: C.softer, margin: 0 }}>Loading…</p>}
      {items && (
        <ul aria-label="Upsell products" className="up-list" style={{ listStyle: "none", margin: 0, padding: 0, background: "#fff", border: `1px solid ${C.line}`, borderRadius: 10 }}>
          {items.map((p, i) => (
            <li key={p.code} style={{ borderBottom: i < items.length - 1 ? `1px solid ${C.line}` : undefined }}>
              <a href={`/admin/upsell-products/${encodeURIComponent(p.code)}`} data-product={p.code}
                style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 20px", minHeight: 64, padding: "12px 16px", boxSizing: "border-box", color: C.ink, textDecoration: "none" }}>
                <span style={{ flex: "1 1 220px", display: "flex", flexDirection: "column", minWidth: 0 }}>
                  <span style={{ fontWeight: 650, color: C.brand }}>{p.name}</span>
                  <span style={{ fontSize: 12.5, color: C.softer, overflowWrap: "anywhere" }}>{p.code} · {p.typeLabel}</span>
                </span>
                <span style={{ flex: "0 0 auto", fontVariantNumeric: "tabular-nums" }}>
                  {p.unitPriceSatang !== null ? `${baht(p.unitPriceSatang)} / ${p.pricingBasis === "PER_GROUP" ? "group" : "guest"}` : "—"}
                </span>
                <span style={{ flex: "0 0 auto", fontSize: 13, color: C.soft }}>{p.versionLabel}</span>
                <Status p={p} />
              </a>
            </li>
          ))}
        </ul>
      )}
      <p style={{ margin: 0, fontSize: 13, color: C.softer }}>Live = Active and its switch is on in Railway. Admin edits; Accountant can view.</p>
    </Shell>
  );
}

// ── one product ──────────────────────────────────────────────────────────────

const rowStyle = { display: "flex", flexWrap: "wrap", gap: "6px 16px", alignItems: "center", padding: "10px 0", borderTop: `1px solid ${C.rule}` } as const;
const labelStyle = { flex: "0 0 200px", color: C.soft } as const;
const valueStyle = { flex: "1 1 260px", minWidth: 0 } as const;
const inputStyle = { minHeight: 44, border: `1px solid ${C.field}`, borderRadius: 8, padding: "0 12px", font: "inherit", boxSizing: "border-box", background: "#fff", color: C.ink } as const;
const choiceStyle = (on: boolean) => ({
  display: "inline-flex", alignItems: "center", gap: 8, minHeight: 44, padding: "0 14px", borderRadius: 8,
  border: `1px solid ${on ? C.brand : C.field}`, background: on ? "#EAF4EF" : "#fff", fontWeight: on ? 600 : 400, cursor: "pointer",
}) as const;
const tick = { width: 18, height: 18, flexShrink: 0, accentColor: C.brand, margin: 0 } as const;

function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 10, padding: "4px 18px 8px" }}>
      <h2 id={id} style={{ margin: "14px 0 6px", fontSize: 15, fontWeight: 650 }}>
        {title}{note && <span style={{ fontWeight: 400, fontSize: 13, color: C.softer }}> · {note}</span>}
      </h2>
      {children}
    </section>
  );
}
function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return <div style={rowStyle}><span style={labelStyle}>{label}</span><div style={valueStyle}>{children}</div></div>;
}
function Fixed({ label, children }: { label: string; children: ReactNode }) {
  return <Row label={label}><span>{children}</span></Row>;
}
function Choices({ legend, name, value, options, onChange, multi }: {
  legend: string; name: string; value: string | string[]; options: { v: string; label: string }[]; onChange: (v: string) => void; multi?: boolean;
}) {
  return (
    <fieldset style={{ ...rowStyle, border: 0, margin: 0, padding: "10px 0", minWidth: 0 }}>
      <legend style={{ ...labelStyle, float: "left", padding: 0 }}>{legend}</legend>
      <div style={{ ...valueStyle, display: "flex", flexWrap: "wrap", gap: 8 }}>
        {options.map((o) => {
          const on = Array.isArray(value) ? value.includes(o.v) : value === o.v;
          return (
            <label key={o.v} style={choiceStyle(on)}>
              <input type={multi ? "checkbox" : "radio"} name={name} value={o.v} checked={on} onChange={() => onChange(o.v)} style={tick} /> {o.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
/** The eligible tours: one row per tour — its id, start time and full name (owner, 19 Nov 2026). */
function TourList({ tours, value, onToggle, hint, hintWarn }: { tours: TourOption[]; value: string[]; onToggle: (id: string) => void; hint: string; hintWarn: boolean }) {
  return (
    <fieldset className="up-tours" aria-describedby="tours-hint" style={{ ...rowStyle, border: 0, margin: 0, padding: "10px 0", minWidth: 0 }}>
      <legend style={{ ...labelStyle, float: "left", padding: 0 }}>Eligible source tours</legend>
      <div style={{ ...valueStyle, display: "flex", flexDirection: "column" }}>
        {tours.map((x) => (
          <label key={x.id} style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 44, cursor: "pointer" }}>
            <input type="checkbox" name="tours" value={x.id} checked={value.includes(x.id)} onChange={() => onToggle(x.id)} style={tick} />
            <span><b>{x.id}</b> · {clock(x.time)} · {x.name}</span>
          </label>
        ))}
        <span id="tours-hint" style={{ fontSize: 13, color: hintWarn ? C.warn : C.softer, marginTop: 2 }}>{hint}</span>
      </div>
    </fieldset>
  );
}
function Money({ id, label, value, onChange, hint, width = 120 }: { id: string; label: string; value: string; onChange: (v: string) => void; hint: string; width?: number }) {
  return (
    <div style={rowStyle}>
      <label htmlFor={id} style={labelStyle}>{label}</label>
      <span style={{ ...valueStyle, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <input id={id} name={id} inputMode="decimal" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={`${id}-hint`}
          style={{ ...inputStyle, width, textAlign: "right" }} />
        <span id={`${id}-hint`}>{hint}</span>
      </span>
    </div>
  );
}

export function UpsellProductEdit({ code }: { code: string }) {
  const [d, setD] = useState<Detail | null>(null);
  const [f, setF] = useState<Form | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const msgRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/admin/upsell-products/${encodeURIComponent(code)}`, { cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setLoadErr(r.status === 404 ? "No such upsell product." : "Could not load this product."); return; }
    setLoadErr(null); setD(j); setF(j.form);
  }, [code]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (msg) msgRef.current?.focus(); }, [msg]);

  if (loadErr) return <Shell><a href="/admin/upsell-products" style={{ color: C.brand }}>‹ Upsell products</a><div role="alert" style={{ color: "var(--danger)" }}>{loadErr}</div></Shell>;
  if (!d || !f) return <Shell><p style={{ color: C.softer }}>Loading…</p></Shell>;

  const t = d.product.type;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => (x ? { ...x, [k]: v } : x));
  const toggle = (k: "paymentMethods" | "eligibleTourIds", v: string) => setF((x) => {
    if (!x) return x;
    const has = x[k].includes(v);
    return { ...x, [k]: has ? x[k].filter((y) => y !== v) : [...x[k], v].sort() };
  });
  const nextNo = d.locked ? d.latestVersion + 1 : d.latestVersion;
  const latestFrom = d.versions[d.versions.length - 1]?.activeFrom ?? d.today;
  const minFrom = d.locked ? addDays(d.today, 1) > latestFrom ? addDays(d.today, 1) : addDays(latestFrom, 1)
    : latestFrom < d.today ? latestFrom : d.today;
  const priceSatang = Math.round(Number((f.price || "0").replace(/,/g, "")) * 100) || 0;

  const body = () => {
    const b: Record<string, unknown> = {
      expectedUpdatedAt: d.product.updatedAt, price: f.price, discount: f.discount, refundPolicy: f.refundPolicy,
      revenueCategory: f.revenueCategory, taxProfileId: f.taxProfileId, activeFrom: f.activeFrom, activeTo: f.activeTo || null,
    };
    if (t !== "JOIN_SOURCE_TOUR") b.pricingBasis = f.pricingBasis;
    if (t === "NEW_TOUR") {
      b.paymentMethods = f.paymentMethods;
      b.serviceValidityDays = Number(f.serviceValidityDays); b.fixedCostPerGuest = f.fixedCostPerGuest; b.incentivePerGuest = f.incentivePerGuest;
    }
    if (t !== "NEW_TOUR") b.eligibleTourIds = f.eligibleTourIds;
    return b;
  };
  const save = async () => {
    if (busy) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/admin/upsell-products/${encodeURIComponent(code)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body()) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ ok: false, text: j.message ?? "Not saved." }); return; }
      await load();
      setMsg({ ok: true, text: j.kind === "NEW_VERSION" ? `Saved as v${j.version}, on sale from ${shortDay(f.activeFrom)}.` : `Saved v${j.version}.` });
    } finally { setBusy(false); }
  };
  const setActive = async (active: boolean) => {
    if (busy) return;
    const ask = active
      ? `Activate ${d.product.name}? It is not sold until ${SWITCH_NAME[t]} is also on in Railway.`
      : `Deactivate ${d.product.name}? Nothing new can be sold; sales already made carry on.`;
    if (!window.confirm(ask)) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/admin/upsell-products/${encodeURIComponent(code)}/active`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedUpdatedAt: d.product.updatedAt, active }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ ok: false, text: j.message ?? "Not changed." }); return; }
      await load();
      setMsg({ ok: true, text: active ? "Active. Not live until its switch is on." : "Inactive." });
    } finally { setBusy(false); }
  };

  const draftTax = d.options.taxProfiles.find((x) => x.id === f.taxProfileId)?.status !== "CONFIRMED";
  const hint = (id: string, text: string) => <span id={id} style={{ fontSize: 13, color: C.warn }}>{text}</span>;

  return (
    <Shell>
      <div style={{ maxWidth: 820, width: "100%", margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
        <a href="/admin/upsell-products" style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", minHeight: 44, fontSize: 13, color: C.brand }}>‹ Upsell products</a>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 650 }}>{d.product.name}</h1>
            <div style={{ fontSize: 13, color: C.softer, overflowWrap: "anywhere" }}>{d.product.code} · {d.product.typeLabel}</div>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
            <Status p={d.product} />
            {d.canEdit && (
              <button type="button" className="up-active" disabled={busy || (!d.product.active && d.product.needsTours)} onClick={() => setActive(!d.product.active)}
                aria-describedby={!d.product.active && d.product.needsTours ? "act-why" : undefined}
                style={{ minHeight: 44, padding: "0 16px", border: `1px solid ${d.product.active ? C.field : C.brand}`, borderRadius: 8, background: "#fff", color: d.product.active ? C.ink : C.brand, font: "inherit", fontWeight: 600, cursor: "pointer" }}>
                {d.product.active ? "Deactivate…" : "Activate…"}
              </button>
            )}
          </div>
        </div>

        {!d.product.active && d.product.needsTours && (
          <div id="act-why" role="note" style={{ background: "#FBF4E4", border: "1px solid #EADFC3", color: C.warn, borderRadius: 10, padding: "12px 14px", fontSize: 13.5 }}>
            Choose at least one eligible source tour{d.canEdit ? " and save" : ""} before {d.canEdit ? "you can activate" : "it can be activated"}. Until then no guide sees this product.
          </div>
        )}
        {!d.canEdit && <div role="note" style={{ background: "#F4F4F5", borderRadius: 10, padding: "10px 14px", fontSize: 13.5, color: C.soft }}>Read only — an Admin changes these settings.</div>}
        {d.locked && (
          <div role="note" style={{ background: "#FBF4E4", border: "1px solid #EADFC3", color: C.warn, borderRadius: 10, padding: "12px 14px", fontSize: 13.5 }}>
            v{d.latestVersion} has {d.latestSales} {d.latestSales === 1 ? "sale" : "sales"}, so it is locked. Saving creates <b>v{nextNo}</b>; those sales keep v{d.latestVersion}&rsquo;s rules.
          </div>
        )}

        <form onSubmit={(e) => { e.preventDefault(); void save(); }} style={{ display: "contents" }}>
          <fieldset disabled={!d.canEdit || busy} style={{ border: 0, margin: 0, padding: 0, minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
            <legend className="sr-only" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>{d.product.name} settings</legend>

            <Section id="s-price" title="Price and payment">
              <Money id="price" label="Price (฿)" value={f.price} onChange={(v) => set("price", v)} hint={t === "JOIN_SOURCE_TOUR" || f.pricingBasis === "PER_GUEST" ? "per guest" : "per group"} />
              {t !== "JOIN_SOURCE_TOUR" && (
                <Choices legend="Charged" name="basis" value={f.pricingBasis} onChange={(v) => set("pricingBasis", v)}
                  options={[{ v: "PER_GUEST", label: "Per guest" }, { v: "PER_GROUP", label: "Per group" }]} />
              )}
              {t !== "NEW_TOUR"
                ? <Fixed label="Guest pays by">Cash to the guide only <span style={{ color: C.softer }}>(fixed)</span></Fixed>
                : <Choices legend="Guest pays by" name="methods" multi value={f.paymentMethods} onChange={(v) => toggle("paymentMethods", v)}
                    options={[{ v: "CASH", label: "Cash to the guide" }, { v: "BANK_TRANSFER", label: "Bank transfer" }]} />}
              <Choices legend="Discount" name="discount" value={f.discount} onChange={(v) => set("discount", v)}
                options={[{ v: "NONE", label: "Not allowed" }, { v: "ADMIN_APPROVAL", label: "Guide asks, Admin approves" }]} />
            </Section>

            <Section id="s-svc" title="Service">
              {t === "ROUTE_EXTENSION" && <>
                <Fixed label="Creates">Extra stops on the same tour · same guide</Fixed>
                <TourList tours={d.options.tours} value={f.eligibleTourIds} onToggle={(v) => toggle("eligibleTourIds", v)}
                  hintWarn={f.eligibleTourIds.length === 0}
                  hint={f.eligibleTourIds.length === 0
                    ? `None chosen yet. A guide sees “Sell ${d.product.name}” only on a job of a tour ticked here.`
                    : `Sold only on jobs of ${f.eligibleTourIds.join(", ")}.`} />
              </>}
              {t === "NEW_TOUR" && <>
                <Fixed label="Creates">New booking and job · guide assigned separately</Fixed>
                <Fixed label="Tour">{d.fixed.serviceTour?.name ?? "—"} <span style={{ color: C.softer }}>(the time picks the tour id)</span></Fixed>
                <Fixed label="Seat group">{d.fixed.capacityGroupKey ?? "—"} <span style={{ color: C.softer }}>({PAX_PER_GUIDE} seats per guide, a system setting)</span></Fixed>
                <div style={rowStyle}>
                  <label htmlFor="valid" style={labelStyle}>Usable for (days)</label>
                  <span style={{ ...valueStyle, display: "flex", alignItems: "center", gap: 8 }}>
                    <input id="valid" inputMode="numeric" autoComplete="off" value={f.serviceValidityDays ?? ""} aria-describedby="valid-hint"
                      onChange={(e) => set("serviceValidityDays", e.target.value === "" ? null : Number(e.target.value.replace(/\D/g, "")))}
                      style={{ ...inputStyle, width: 72, textAlign: "right" }} />
                    <span id="valid-hint">from payment</span>
                  </span>
                </div>
              </>}
              {t === "JOIN_SOURCE_TOUR" && <>
                <Fixed label="Creates">Booking on existing job · no new job</Fixed>
                <TourList tours={d.options.onsiteTours} value={f.eligibleTourIds} onToggle={(v) => toggle("eligibleTourIds", v)}
                  hintWarn={false} hint={`Only ${d.options.onsiteTours.map((x) => x.id).join(" and ")} can take an on-site seat.`} />
                <Fixed label="Guide">Selling Guide = Service Guide <span style={{ color: C.softer }}>(fixed)</span></Fixed>
                <Fixed label="OTA mix">Allowed for this product</Fixed>
                <Fixed label="Capacity">Max {PAX_PER_GUIDE} guests on the job, OTA + on-site <span style={{ color: C.softer }}>(system setting)</span></Fixed>
              </>}
            </Section>

            {t === "NEW_TOUR" && (
              <Section id="s-cost" title="Guide costs">
                <Money id="fc" label="Fixed food cost (฿)" width={96} value={f.fixedCostPerGuest} onChange={(v) => set("fixedCostPerGuest", v)} hint="per paid guest → service guide" />
                <Fixed label="Counted on">Paid guests, no-shows included <span style={{ color: C.softer }}>(fixed)</span></Fixed>
                <Money id="inc" label="Sales incentive (฿)" width={96} value={f.incentivePerGuest} onChange={(v) => set("incentivePerGuest", v)} hint="per paid guest → selling guide, after service approval" />
              </Section>
            )}
            {t === "ROUTE_EXTENSION" && (
              <Section id="s-cash" title="Cash hand-in">
                <Fixed label="Hand in"><span style={{ fontVariantNumeric: "tabular-nums" }}>All of it — {baht(priceSatang)} {f.pricingBasis === "PER_GROUP" ? "per group" : "per guest"}</span></Fixed>
                <Fixed label="Remittance">Bank transfer to Folkpaths only <span style={{ color: C.softer }}>(fixed)</span></Fixed>
                <Fixed label="When">With that tour&rsquo;s end-tour report</Fixed>
              </Section>
            )}
            {t === "JOIN_SOURCE_TOUR" && <>
              <Section id="s-cost" title="Guide costs">
                <Fixed label="Fixed cost · incentive">None — no fixed cost, no incentive</Fixed>
              </Section>
              <Section id="s-cash" title="Cash hand-in">
                <Fixed label="Hand in"><span style={{ fontVariantNumeric: "tabular-nums" }}>All of it — {baht(priceSatang)} per guest</span></Fixed>
                <Fixed label="Remittance">Bank transfer only · the guest&rsquo;s payment stays cash</Fixed>
                <Fixed label="When">With that tour&rsquo;s end-tour report</Fixed>
              </Section>
              <Section id="s-ref" title="References" note="made by the system, never typed">
                <Fixed label="Sale ref"><code style={{ fontSize: 13 }}>FOLK-UPS-YYYYMM-NNN</code></Fixed>
                <Fixed label="Job ref"><code style={{ fontSize: 13 }}>FOLK-BKK-YYYYMMDD-NN</code> · the tour&rsquo;s own job</Fixed>
                <Fixed label="Settlement ref"><code style={{ fontSize: 13 }}>FOLK-CSH-YYYYMM-NNN</code></Fixed>
              </Section>
            </>}

            <Section id="s-acc" title="Accounting">
              <div style={rowStyle}>
                <label htmlFor="rev" style={labelStyle}>Revenue category</label>
                <div style={{ ...valueStyle, display: "flex", flexDirection: "column", gap: 4 }}>
                  <select id="rev" value={f.revenueCategory} onChange={(e) => set("revenueCategory", e.target.value)} aria-describedby={d.options.revenueCategory.mapped ? undefined : "rev-hint"}
                    style={{ ...inputStyle, padding: "0 10px", maxWidth: 440, width: "100%" }}>
                    <option value={d.options.revenueCategory.key}>{d.options.revenueCategory.key}{d.options.revenueCategory.mapped ? "" : " · awaiting accountant"}</option>
                  </select>
                  {!d.options.revenueCategory.mapped && hint("rev-hint", "New category, not mapped yet: PEAK export stays blocked.")}
                </div>
              </div>
              {t === "NEW_TOUR" && (
                <div style={rowStyle}>
                  <label htmlFor="fcc" style={labelStyle}>Food cost category</label>
                  <div style={{ ...valueStyle, display: "flex", flexDirection: "column", gap: 4 }}>
                    <select id="fcc" value={d.fixed.fixedCostCategory} onChange={() => {}} aria-describedby={d.options.fixedCostCategoryMapped ? undefined : "fcc-hint"}
                      style={{ ...inputStyle, padding: "0 10px", maxWidth: 440, width: "100%" }}>
                      <option value={d.fixed.fixedCostCategory}>{d.fixed.fixedCostCategory}</option>
                    </select>
                    {!d.options.fixedCostCategoryMapped && hint("fcc-hint", "Not mapped yet: PEAK export stays blocked.")}
                  </div>
                </div>
              )}
              <div style={rowStyle}>
                <label htmlFor="tax" style={labelStyle}>Tax profile</label>
                <div style={{ ...valueStyle, display: "flex", flexDirection: "column", gap: 4 }}>
                  <select id="tax" value={f.taxProfileId} onChange={(e) => set("taxProfileId", e.target.value)} aria-describedby={draftTax ? "tax-hint" : undefined}
                    style={{ ...inputStyle, padding: "0 10px", maxWidth: 440, width: "100%" }}>
                    {d.options.taxProfiles.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.status === "CONFIRMED" ? "Confirmed" : "Draft"}</option>)}
                  </select>
                  {draftTax && hint("tax-hint", "PEAK waits until the accountant confirms it.")}
                </div>
              </div>
              <Choices legend="Refunds" name="refund" value={f.refundPolicy} onChange={(v) => set("refundPolicy", v)}
                options={[{ v: "NON_REFUNDABLE", label: "Non-refundable" }, { v: "ADMIN_ONLY", label: "Admin can refund" }]} />
            </Section>

            <Section id="s-dates" title={`v${nextNo} on sale`}>
              <div style={rowStyle}>
                <label htmlFor="from" style={labelStyle}>From</label>
                <span style={{ ...valueStyle, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                  <input id="from" type="date" value={f.activeFrom} min={minFrom} onChange={(e) => set("activeFrom", e.target.value)} aria-describedby={d.locked ? "from-hint" : undefined} style={{ ...inputStyle, padding: "0 10px" }} />
                  {d.locked && f.activeFrom && <span id="from-hint">v{d.latestVersion} ends {shortDay(addDays(f.activeFrom, -1))} when you save</span>}
                </span>
              </div>
              <div style={rowStyle}>
                <label htmlFor="to" style={labelStyle}>Until</label>
                <span style={{ ...valueStyle, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                  <input id="to" type="date" value={f.activeTo ?? ""} min={f.activeFrom} onChange={(e) => set("activeTo", e.target.value || null)} aria-describedby="to-hint" style={{ ...inputStyle, padding: "0 10px" }} />
                  <span id="to-hint">empty = no end</span>
                </span>
              </div>
            </Section>

            {t === "NEW_TOUR" && <p style={{ margin: 0, fontSize: 13, color: C.softer }}>Cash is handed in with the end-tour report of the tour where it was sold.</p>}
          </fieldset>

          <div ref={msgRef} tabIndex={-1} role={msg && !msg.ok ? "alert" : "status"} aria-live="polite"
            style={{ display: msg ? "block" : "none", outline: "none", padding: "10px 14px", borderRadius: 10, fontSize: 13.5,
              background: msg?.ok ? "#EAF4EF" : "#FBEDEA", color: msg?.ok ? "#0B6136" : "#9A3324", border: `1px solid ${msg?.ok ? "#CBE5D6" : "#EFCFC7"}` }}>
            {msg?.text}
          </div>

          {d.canEdit && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "flex-end" }}>
              <a href="/admin/upsell-products" style={{ display: "inline-flex", alignItems: "center", minHeight: 44, padding: "0 18px", border: `1px solid ${C.field}`, borderRadius: 8, color: C.ink, textDecoration: "none", background: "#fff" }}>Cancel</a>
              <button type="submit" className="up-save" disabled={busy}
                style={{ minHeight: 44, padding: "0 20px", border: 0, borderRadius: 8, background: C.brand, color: "#fff", font: "inherit", fontWeight: 600, cursor: "pointer" }}>
                {busy ? "Saving…" : d.locked ? `Save as v${nextNo}` : "Save"}
              </button>
            </div>
          )}
        </form>

        <details style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 10 }}>
          <summary style={{ display: "flex", alignItems: "center", minHeight: 44, padding: "0 18px", cursor: "pointer", fontWeight: 600 }}>Versions</summary>
          <ol className="up-versions" style={{ margin: 0, padding: "0 18px 14px 36px", display: "flex", flexDirection: "column", gap: 6, fontSize: 13.5, fontVariantNumeric: "tabular-nums" }}>
            {d.versions.map((v) => (
              <li key={v.version}>
                v{v.version} · {v.activeTo ? `${shortDay(v.activeFrom)}–${shortDay(v.activeTo)}` : `from ${shortDay(v.activeFrom)}`} · {baht(v.unitPriceSatang)}
                {t === "NEW_TOUR" && ` · food ${baht(v.fixedCostPerGuestSatang)} · incentive ${baht(v.incentivePerGuestSatang)}`}
                {t !== "NEW_TOUR" && ` · ${v.eligibleTourIds.length ? v.eligibleTourIds.join(", ") : "no tours"}`}
                {` · ${v.sales} ${v.sales === 1 ? "sale" : "sales"} · ${v.locked ? "locked" : "editable"} · by ${v.createdBy}`}
              </li>
            ))}
          </ol>
        </details>
      </div>
    </Shell>
  );
}
