"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// The guest booking page: the commission-free path.
//
// Everything it shows comes from /api/public/availability, which returns only
// what a guest may see. The price shown here is advisory — the server prices the
// booking again from the tour and departure, so a total edited in the browser
// changes nothing.

type Departure = {
  id: string; date: string; time: string; seatsLeft: number;
  available: boolean; priceAdult: number | null; priceChild: number | null;
};
type Tour = {
  id: string; name: string; time: string; durationMin: number | null; meetingPoint: string | null;
  itinerary: string | null; included: string | null; bring: string | null;
  priceAdult: number | null; priceChild: number | null; currency: string;
};
type Confirmed = {
  voucherCode: string; tourName: string; date: string | null; time: string | null;
  pax: number; total: string | null; currency: string; meetingPoint: string | null;
  emailed?: boolean;
};

const money = (n: number) => `฿${n.toLocaleString("en-US")}`;
const dayLabel = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

export default function BookingPage({ tourId }: { tourId: string }) {
  const [tour, setTour] = useState<Tour | null>(null);
  const [deps, setDeps] = useState<Departure[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ok" | "missing" | "error">("loading");
  const [date, setDate] = useState("");
  const [picked, setPicked] = useState<string>("");
  const [adults, setAdults] = useState(2);
  const [children, setChildren] = useState(0);
  const [form, setForm] = useState({ customerName: "", email: "", phone: "", nationality: "", specialRequests: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<Confirmed | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/public/availability?tourId=${encodeURIComponent(tourId)}`, { cache: "no-store" });
      if (r.status === 404) { setLoadState("missing"); return; }
      if (!r.ok) { setLoadState("error"); return; }
      const d = await r.json();
      setTour(d.tour); setDeps(d.departures ?? []); setLoadState("ok");
      const firstOpen = (d.departures ?? []).find((x: Departure) => x.available);
      if (firstOpen) setDate(firstOpen.date);
    } catch { setLoadState("error"); }
  }, [tourId]);

  useEffect(() => { load(); }, [load]);

  // Only dates that still have a bookable departure — offering a date whose slots
  // are all gone is a dead end the guest has to discover by clicking.
  const openDates = useMemo(() => {
    const s = new Set(deps.filter((d) => d.available).map((d) => d.date));
    return [...s].sort();
  }, [deps]);

  const onDate = useMemo(() => deps.filter((d) => d.date === date), [deps, date]);
  const sel = useMemo(() => deps.find((d) => d.id === picked) ?? null, [deps, picked]);

  useEffect(() => {
    // Keep the selection valid when the date changes.
    if (sel && sel.date === date) return;
    const first = onDate.find((d) => d.available);
    setPicked(first ? first.id : "");
  }, [date, onDate, sel]);

  const pax = adults + children;
  const priceA = sel?.priceAdult ?? tour?.priceAdult ?? null;
  const priceC = sel?.priceChild ?? tour?.priceChild ?? priceA;
  const total = priceA == null ? null : priceA * adults + (priceC ?? priceA) * children;
  const overCapacity = !!sel && pax > sel.seatsLeft;
  const canSubmit = !!sel && !overCapacity && pax > 0 && form.customerName.trim().length >= 2 &&
    /\S+@\S+\.\S+/.test(form.email) && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!sel || !canSubmit) return;
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/public/book", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ departureId: sel.id, adults, children, ...form }),
      });
      const d = await r.json().catch(() => ({}));
      setBusy(false);
      if (!r.ok) {
        setErr(d.message || "We could not complete that booking.");
        // Seats may have gone while the form was open; refresh so the page tells
        // the truth about what is left rather than repeating the same failure.
        if (r.status === 409) load();
        return;
      }
      setDone(d);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      setBusy(false);
      setErr("Something went wrong sending your booking. Please try again.");
    }
  }

  if (loadState === "loading") {
    return <main className="gb"><div className="gb-wrap"><div className="gb-skel" /><div className="gb-skel short" /></div></main>;
  }
  if (loadState === "missing" || loadState === "error") {
    return (
      <main className="gb"><div className="gb-wrap gb-empty">
        <h1>This tour isn&apos;t bookable online</h1>
        <p>{loadState === "missing"
          ? "It may not be on sale yet, or the link may be out of date."
          : "We couldn't load availability just now. Please try again in a moment."}</p>
        <p>Email <a href="mailto:folkpaths@gmail.com">folkpaths@gmail.com</a> and we&apos;ll book you in directly.</p>
      </div></main>
    );
  }

  if (done) {
    return (
      <main className="gb">
        <div className="gb-wrap">
          <div className="gb-done">
            <div className="gb-done-k">Booking confirmed</div>
            <div className="gb-code">{done.voucherCode}</div>
            <h1>{done.tourName}</h1>
            <p className="gb-done-when">
              {done.date ? dayLabel(done.date) : ""}{done.time ? ` · ${done.time}` : ""} · {done.pax} guest{done.pax === 1 ? "" : "s"}
            </p>
            {done.meetingPoint && <p className="gb-done-meet">Meet at <b>{done.meetingPoint}</b></p>}
            {done.total && <p className="gb-done-total">Total {money(Number(done.total))}</p>}
            <div className="gb-note">
              <b>Nothing to pay yet.</b> We&apos;ll send a PromptPay QR, or you can pay us on the day.
              Keep your code — your guide will ask for it at the meeting point.
            </div>
            {/* Only claim an email was sent when one actually was. Telling a guest
                to check an inbox that will stay empty is worse than saying nothing. */}
            <p className="gb-done-mail">
              {done.emailed
                ? <>A confirmation is on its way to <b>{form.email}</b>, with a calendar invite.</>
                : <>Please save this code — write it down or screenshot this page. If you don&apos;t
                   hear from us within a day, email <a href="mailto:folkpaths@gmail.com">folkpaths@gmail.com</a>.</>}
            </p>
          </div>
        </div>
      </main>
    );
  }

  const t = tour!;
  return (
    <main className="gb">
      <header className="gb-hero">
        <div className="gb-wrap">
          <div className="gb-brand">Folkpaths</div>
          <div className="gb-kick">Bangkok · Licensed Thai guide · Small group</div>
          <h1>{t.name}</h1>
          <dl className="gb-facts">
            <div><dt>Starts</dt><dd>{t.time}</dd></div>
            {t.durationMin && <div><dt>Duration</dt><dd>{Math.round(t.durationMin / 60)} hours</dd></div>}
            {t.meetingPoint && <div><dt>Meet at</dt><dd>{t.meetingPoint}</dd></div>}
          </dl>
        </div>
      </header>

      <div className="gb-wrap gb-grid">
        <div className="gb-col">
          {t.itinerary && <section><h2>The day</h2><p className="gb-prose">{t.itinerary}</p></section>}
          {t.included && <section><h2>What&apos;s included</h2><p className="gb-prose">{t.included}</p></section>}
          {t.bring && <section><h2>What to bring</h2><p className="gb-prose">{t.bring}</p></section>}
          {!t.itinerary && !t.included && !t.bring && (
            <section>
              <h2>About this tour</h2>
              <p className="gb-prose">
                A small-group tour with a licensed Thai guide, run by Folkpaths in Bangkok.
                Pick a date and time to see what&apos;s available.
              </p>
            </section>
          )}
          <section className="gb-direct">
            <h2>Booked direct</h2>
            <p>
              No agency in between. You&apos;re booking with the company whose guide meets you —
              which is why we can hold the group small and answer your email ourselves.
            </p>
          </section>
        </div>

        <aside>
          <form className="gb-book" onSubmit={submit} noValidate>
            <div className="gb-price">
              <span>From</span>
              <b>{t.priceAdult != null ? money(t.priceAdult) : "—"}</b>
              <em>per adult</em>
            </div>

            <div className="gb-body">
              {!openDates.length ? (
                <p className="gb-none">
                  No dates open for booking right now. Email <a href="mailto:folkpaths@gmail.com">folkpaths@gmail.com</a> and
                  we&apos;ll find you a place.
                </p>
              ) : (
                <>
                  <label className="gb-f"><span>Date</span>
                    <select value={date} onChange={(e) => setDate(e.target.value)}>
                      {openDates.map((d) => <option key={d} value={d}>{dayLabel(d)}</option>)}
                    </select>
                  </label>

                  <div className="gb-f"><span>Choose a departure</span>
                    <div className="gb-slots">
                      {onDate.map((d) => (
                        <button key={d.id} type="button" className="gb-slot"
                          aria-pressed={d.id === picked} disabled={!d.available}
                          onClick={() => setPicked(d.id)}>
                          <b>{d.time}</b>
                          <span className={d.seatsLeft > 0 && d.seatsLeft <= 4 ? "low" : ""}>
                            {d.seatsLeft === 0 ? "Sold out" : `${d.seatsLeft} seat${d.seatsLeft === 1 ? "" : "s"} left`}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="gb-f"><span>Guests</span>
                    <div className="gb-steps">
                      <Stepper label="adult" n={adults} min={1} onChange={setAdults} />
                      <Stepper label="child" n={children} min={0} onChange={setChildren} />
                    </div>
                    {priceC != null && priceA != null && priceC !== priceA && (
                      <p className="gb-hint">Child {money(priceC)}</p>
                    )}
                  </div>

                  <label className="gb-f"><span>Name</span>
                    <input value={form.customerName} onChange={(e) => setForm({ ...form, customerName: e.target.value })}
                      autoComplete="name" placeholder="Name the booking is under" /></label>
                  <label className="gb-f"><span>Email</span>
                    <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
                      autoComplete="email" placeholder="Where your confirmation goes" /></label>
                  <div className="gb-two">
                    <label className="gb-f"><span>Phone</span>
                      <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} autoComplete="tel" /></label>
                    <label className="gb-f"><span>Nationality</span>
                      <input value={form.nationality} onChange={(e) => setForm({ ...form, nationality: e.target.value })} /></label>
                  </div>
                  <label className="gb-f"><span>Anything we should know?</span>
                    <textarea value={form.specialRequests} onChange={(e) => setForm({ ...form, specialRequests: e.target.value })}
                      rows={2} placeholder="Dietary needs, mobility, birthdays…" /></label>

                  {total != null && (
                    <div className="gb-total">
                      <div><span>Adult × {adults}</span><span>{money((priceA ?? 0) * adults)}</span></div>
                      {children > 0 && <div><span>Child × {children}</span><span>{money((priceC ?? priceA ?? 0) * children)}</span></div>}
                      <div className="g"><span>Total</span><span>{money(total)}</span></div>
                    </div>
                  )}

                  {overCapacity && sel && (
                    <p className="gb-err">Only {sel.seatsLeft} seat{sel.seatsLeft === 1 ? "" : "s"} left at {sel.time}. Try another departure or reduce the party.</p>
                  )}
                  {err && <p className="gb-err">{err}</p>}

                  <button className="gb-cta" type="submit" disabled={!canSubmit}>
                    {busy ? "Reserving…" : `Reserve ${pax} seat${pax === 1 ? "" : "s"}`}
                  </button>
                  <p className="gb-fine">No card needed — pay by PromptPay or on the day.</p>
                </>
              )}
            </div>
          </form>
        </aside>
      </div>
    </main>
  );
}

function Stepper({ label, n, min, onChange }: { label: string; n: number; min: number; onChange: (v: number) => void }) {
  return (
    <div className="gb-step">
      <button type="button" onClick={() => onChange(Math.max(min, n - 1))} disabled={n <= min} aria-label={`One ${label} fewer`}>−</button>
      <span><b>{n}</b> {label}</span>
      <button type="button" onClick={() => onChange(n + 1)} aria-label={`One ${label} more`}>+</button>
    </div>
  );
}
