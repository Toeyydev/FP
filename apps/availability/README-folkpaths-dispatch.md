# Folkpaths — Availability & Dispatch · design package

Drop this folder into your Cursor project (e.g. `docs/dispatch/`). Build against the spec; use the HTML files as the visual source of truth.

## Files

| File | What it is | Use for |
|------|-----------|---------|
| `folkpaths-dispatch-handoff-spec.md` | **Build-ready spec** — data model, business rules, all screens, states, edge cases, Google Calendar sync, notifications, open TODOs | The master document. Build from this. |
| `folkpaths-availability-manager.html` | Guide-side reference (month calendar + slot editor, combined model) | Guide UI — open in browser, match components to it |
| `folkpaths-operator-dispatch.html` | Operator-side reference (availability matrix + dispatch + buffer + presence) | Operator UI — open in browser, match components to it |
| `folkpaths-guide-ux-copy-review.md` | Bilingual EN/TH copy for every screen | Pull microcopy, labels, error/empty states |

## Build order (suggested)

1. **Data model + business rules** — §2 and §3 of the spec (TimeBand, AvailabilityState, BandStatus, Booking, JobOffer, JobSheet, the 10-seat cap, the 60-min buffer).
2. **Guide availability** — calendar + slot editor (`folkpaths-availability-manager.html`).
3. **Operator dispatch** — matrix + grouping + presence (`folkpaths-operator-dispatch.html`).
4. **Over-capacity split editor** — §6.4.
5. **Notifications + presence** — §11, including the iOS "Add to Home Screen" step.
6. **Live job sheet** — §7 (derived state, re-renders on every edit).
7. **Google Calendar sync** — §12 (guide event + operator master event).

## Settled decisions
- Slot model: **combined** — guides set 3 simple bands; jobs fill real times; bands can be part-booked.
- Group cap: **10 seats**; over 10 → operator alert + manual split (whole bookings only).
- Buffer (min sellable gap): **60 min** default (30/60/90 setting).
- Operator gets a **master Google Calendar copy** of every dispatched tour (labelled with the guide).

## Still open (marked TODO in spec §9 / §12)
- Unanswered-offer behaviour (auto-widen online → everyone, or hold).
- Single party > 10 (co-guide one party, or large-group product).
- Offer expiry length (default 15 min).
- Per-guide capacity (some guides < 10?).

## Stack notes
PWA, bilingual EN/TH, brand green `#0e3b2e`. Status indicators must always pair colour + word + icon (accessibility). All times `Asia/Bangkok`.
