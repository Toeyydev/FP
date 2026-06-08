# Folkpaths — Availability & Dispatch System

**Developer handoff spec · v1**
App: guide.folkpaths.com (bilingual EN/TH PWA · guide availability & job dispatch)
Audience: solo operator (Folkpaths) + freelance tour guides
Reference mockups: `folkpaths-availability-manager.html` (guide), `folkpaths-operator-dispatch.html` (operator)

---

## 1. Overview

The system does three jobs:

1. **Guides set availability** in simple time bands on their phone.
2. **The operator dispatches jobs** to guides who are free for the job's time slot, grouping customer bookings and splitting oversized groups.
3. **A live job sheet** is the single source of truth for each assigned tour and re-renders the moment the operator edits anything.

The core principle throughout: automate the common case, escalate the exception to the operator. Guides only ever do the simplest possible action; precision is sourced from data the system already holds.

---

## 2. Core data model

### TimeBand (enum)
`MORNING` (08:00–12:00) · `AFTERNOON` (12:00–17:00) · `EVENING` (17:00–21:00)
Fixed bands. Exact hours are NOT set by guides — they come from the job.

### AvailabilityState (per guide, per date, per band) — what the guide sets
`AVAILABLE` · `DAY_OFF`
(That's all a guide can set. `BOOKED` is system-derived, never set by hand.)

### BandStatus (computed, per guide/date/band) — what gets displayed
| Status | Meaning | Colour |
|--------|---------|--------|
| `FREE` | Available, no job | green |
| `PART_BOOKED` | Has ≥1 job but a sellable gap remains (gap ≥ buffer) | green + red notch |
| `FULL` | Booked with no sellable gap left | red |
| `DAY_OFF` | Guide marked off | grey |

`PART_BOOKED` vs `FULL` is decided by the **buffer** (see §3).

### Booking
One customer reservation. Fields: `id`, `customerName`, `pax`, `productId`, `date`, `startTime`, `endTime`, `language`, `notes`, `status` (`UNASSIGNED` / `OFFERED` / `CONFIRMED`).

### JobOffer
A dispatchable unit = one or more bookings merged by `productId` + `date` + `time slot`. Fields: `id`, `bookings[]`, `totalPax`, `band`, `startTime`, `endTime`, `mode` (`FIRST_TO_ACCEPT` / `DIRECT`), `offeredTo[]`, `expiresAt`, `status`.

### JobSheet
Generated when a JobOffer is accepted. The live tour record (see §7). Re-renders on every operator edit.

### Guide
Fields include `maxGroupSize` (per-guide, default 10, hard cap 10), `languages[]`, `skills[]`, `rating`, `presence` (`ONLINE` / `OFFLINE` + `lastSeenAt`).

---

## 3. Business rules

1. **Group cap = 10 seats.** No single group/guide exceeds 10. `maxGroupSize` is per-guide but may never exceed 10.
2. **Buffer (min sellable gap)** = operator setting, default **60 min**, options 30/60/90. A leftover gap counts as sellable (→ `PART_BOOKED`) only if `gap ≥ buffer`; otherwise the band is `FULL`.
3. **Booking grouping** is automatic: bookings with the same `productId` + `date` + overlapping/identical time slot merge into one JobOffer, regardless of when each booking arrived.
4. **Over-capacity escalation:** if a merged JobOffer's `totalPax > 10`, suppress auto-offer, raise an operator alert, and open the manual split editor (§6.4).
5. **Whole-booking integrity:** the split editor moves entire bookings between groups — never individual guests. A family is never split across guides.
6. **Single party > 10:** cannot be split (one reservation). Flag as `LARGE_GROUP` → operator decides (co-guide one party with 2 guides, OR route to a large-group product). [OPEN DECISION — see §9]
7. **Offer expiry:** every `FIRST_TO_ACCEPT` offer has `expiresAt` (default 15 min). On expiry with no accept, return to operator.
8. **Unanswered-offer widening:** offer to online guides first; if unaccepted after timeout, widen to offline guides. [OPEN DECISION — see §9]
9. **Accept → Booked:** first accept wins; the guide's matching band flips to `BOOKED`, the JobSheet is created, a **Google Calendar event is created on the guide's calendar** (§12), and the offer closes for everyone else.

---

## 4. Screens

### 4.1 Guide — Availability calendar (mobile, primary screen)
Month grid; each day cell shows date + a 3-segment bar (morning/afternoon/evening) coloured by `BandStatus`. `PART_BOOKED` segment = green with a ~42%-width red inset. Tap a day → slot editor.

### 4.2 Guide — Day slot editor (bottom sheet)
Three band rows. Each `AVAILABLE`/`DAY_OFF` row is tappable to toggle. `BOOKED`/`FULL` rows are locked (lock icon) and show the real job time(s) pulled from the JobSheet, e.g. "Temple tour · 09:00–11:30". A `PART_BOOKED` row shows the job + "Still free 15:00–17:00 — can take another job". Footer: "Whole day off" + "Save".

### 4.3 Guide — Incoming job offer (push + in-app)
Push notification when offline; in-app banner + offer card when online. Card shows tour, date, time, pax, language, pay, meeting point, a live countdown ("Respond within mm:ss"), and Accept / Pass.

### 4.4 Operator — Dispatch board (desktop, primary screen)
Open JobOffer summary at top. Guide-availability matrix (guides × dates, each cell a 3-segment band bar, job's date column highlighted). Below: list of guides free for the job's slot, each with a 3-dot band indicator for that date, presence dot, "best match" ranking, and select checkboxes. Footer: mode toggle (First to accept / Assign directly) + Send. Header: buffer setting.

### 4.5 Operator — Booking grouping
Incoming bookings auto-merge into one JobOffer card showing the bundled bookings, total pax, and a capacity meter (x / 10).

### 4.6 Operator — Over-capacity split editor (§6.4)
Alert banner + two (or more) group cards, each with its bookings, a live capacity meter (x / 10), and an assigned-guide slot. "Add group" + "Offer both groups".

### 4.7 Operator — Presence list
Guides with `ONLINE now` (green dot) / `OFFLINE · last seen Xh` (grey dot).

---

## 5. Design tokens

Brand: deep green `#0e3b2e` (primary actions, brand chrome).

| Token | Light value | Usage |
|-------|-------------|-------|
| `color-brand` | `#0e3b2e` | Primary buttons, active nav, brand |
| `color-available` | `#1d7a45` / bg `#e7f4ec` | FREE / available |
| `color-booked` | `#c23b38` / bg `#fceceb` | FULL / booked |
| `color-dayoff` | `#9aa39d` / bg `#eef0ee` | DAY_OFF |
| `color-warn` | `#9a6a12` / bg `#fbf0d8` | part-booked chip, language mismatch, alerts |
| `color-surface` | `#ffffff` | cards |
| `color-page` | `#f4f5f3` | page background |
| `color-line` | `#e4e7e3` | 1px borders |
| `radius-md` | 9px | inputs, cells, chips |
| `radius-lg` | 14px | cards |
| `radius-pill` | 50% | avatars, presence dots |
| `font-base` | system / Noto Sans Thai | all text (bilingual) |

Every state carries colour **+ a word + an icon** — never colour alone (accessibility: red/green colour-blindness). This is mandatory on all band/status indicators.

---

## 6. States & interactions

### 6.1 Availability band (guide)
| Element | State | Behaviour |
|---------|-------|-----------|
| Band row | available | Tap → toggles AVAILABLE ⇄ DAY_OFF; optimistic update, sync offline |
| Band row | booked/full | Locked; tap shows job detail, not editable |
| Day cell | past | Dimmed (opacity .45), not editable |
| Day cell | today | 2px brand outline |
| "Whole day off" | tap | Sets all three bands to DAY_OFF (with confirm if a band is booked) |

### 6.2 Job offer (guide)
| Element | State | Behaviour |
|---------|-------|-----------|
| Countdown | running | Live mm:ss; turns red < 2 min |
| Countdown | expired | Card greys out, "Offer expired" |
| Accept | tapped | Confirms, band → BOOKED, JobSheet created, success toast |
| Accept | already taken | "This job was just taken by another guide" |
| Pass | tapped | Confirm "Pass on this job?"; removed from this guide's list |

### 6.3 Dispatch (operator)
| Element | State | Behaviour |
|---------|-------|-----------|
| Guide row | free | selectable |
| Guide row | full / day off | locked, greyed, lock icon, reason shown |
| Guide row | language mismatch | selectable + amber "Thai only" tag |
| Presence dot | online | green; offline → grey + last-seen |
| Send button | label | Reflects count + mode ("Send to 2 selected guides") |

### 6.4 Over-capacity split editor (operator)
| Element | State | Behaviour |
|---------|-------|-----------|
| Group meter | ≤ 10 | green |
| Group meter | > 10 | red; "Offer" disabled until resolved |
| Booking chip | drag | Moves whole booking between groups; meters recompute live |
| Guide slot | empty | "Assign guide" → picks from guides free for the slot |
| Offer both groups | enabled | Only when every group ≤ 10 and has a guide |

---

## 7. The live job sheet (single source of truth)

The job sheet is generated on acceptance and is **derived state** — it always reflects the current bookings + operator edits. It is NOT a static snapshot.

### Contents
Tour name, date, time slot (real times), meeting point, language, total pax, per-booking breakdown (customer name, pax, notes/special requests), assigned guide, pay, and a change log.

### Live-update rule
Any operator edit re-renders the job sheet, pushes the change to the assigned guide, **and syncs the guide's Google Calendar event** (§12):
- Reassign guide → old guide's sheet revoked + band freed + calendar event deleted; new guide's sheet created + band booked + calendar event created.
- Move a booking between split groups → both affected sheets recompute pax and customer lists; both calendar event descriptions update.
- Edit time / meeting point / add a booking / cancel a booking → sheet updates; calendar event updated (time/location/description); guide notified ("Your job sheet changed: meeting point is now …").
- Cancel the whole job → sheet voided; guide's band freed; calendar event deleted; guide notified.

### Versioning
Each sheet carries a `version` + `changeLog[]` (who/what/when). The guide always sees the latest version; material changes (time, place, pax, cancellation) trigger a notification, cosmetic ones don't. Guide UI shows a "Updated • just now" marker on change.

### Sync / offline
Writes are optimistic with offline queue; on reconnect the sheet reconciles to server truth. If a guide is mid-tour offline, they keep the last-synced sheet and receive updates on reconnect.

---

## 8. Edge cases

- **No guides free for a slot:** dispatch shows empty state "No one's free for this slot" + suggest adjacent slots / nudge guides to update availability.
- **No internet (guide):** banner "You're offline — we'll sync when you're back"; availability edits queue.
- **PWA push on iOS:** web push requires "Add to Home Screen" (iOS 16.4+). Onboarding must include a one-time "Add Folkpaths to your home screen so you never miss a job" step, or offline iPhone guides get no push.
- **Booking arrives after offer sent:** if a new same-slot booking lands while an offer is live and keeps total ≤ 10, append to the live offer/sheet; if it pushes > 10, raise over-capacity alert.
- **Two guides accept near-simultaneously:** server enforces single-winner (atomic); loser sees "just taken".
- **Long Thai/English strings:** band labels and tour names truncate with ellipsis; never wrap the 3-segment bar.
- **Single booking > 10:** see §9 open decision.

---

## 9. Open decisions (mark as TODO before build)

1. **Unanswered-offer widening** — auto-widen online → everyone after timeout, OR hold with the selected guides until expiry? (Recommended: auto-widen after ~10–15 min.)
2. **Single party > 10 seats** — co-guide one party with 2 guides, OR route to a separate large-group product? (Recommended: co-guide.)
3. **Offer expiry length** — default 15 min; confirm.
4. **Guide capacity per person** — confirm default `maxGroupSize` (≤ 10) and whether some guides have lower caps.

---

## 10. Accessibility

- Status is never colour-only — always paired with text label + icon.
- Calendar grid: each day is a button; arrow-key navigation; `aria-label` "13 June, morning booked, afternoon part-booked, evening free".
- Offer countdown: `aria-live="polite"` updates at sensible intervals (not every second).
- Touch targets ≥ 44px (bands, day cells, buttons).
- Bilingual: all strings keyed for EN/TH; layout tested at Thai string lengths.
- Presence and band dots have text equivalents for screen readers.

---

## 11. Notification matrix

| Event | Guide online | Guide offline |
|-------|-------------|---------------|
| New job offer | In-app banner + card | Push → lands in Jobs tab |
| Offer expired/lost | In-app toast | Silent; reflected in Jobs tab |
| Job sheet material change | In-app banner | Push |
| Job cancelled | In-app banner | Push |
| Availability reminder (weekly) | Push/in-app | Push |
| Job accepted | — | Google Calendar event created (§12) |
| Job sheet change / cancel | In-app banner | Push + Google Calendar event updated/deleted |

---

## 12. Google Calendar sync (guide)

When a guide accepts a job, the tour appears on **their own Google Calendar** automatically. One-way sync (app → calendar); the app is the source of truth.

### Connection
- Guide connects Google Calendar once via OAuth in **Profile → Connected calendar** (scope: `calendar.events`). Store `refreshToken` + the target `calendarId` (default `primary`).
- If not connected, accepting still works — show a one-time nudge: "Connect Google Calendar so your tours show up automatically." Never block acceptance on it.

### Event lifecycle
| Trigger | Calendar action |
|---------|-----------------|
| Guide accepts offer | `events.insert` — create event |
| Operator edits time | `events.patch` — update `start`/`end` |
| Operator edits meeting point | `events.patch` — update `location` |
| Booking added/moved/cancelled (pax change) | `events.patch` — update `description` |
| Guide reassigned off the job | `events.delete` on old guide's calendar |
| Job cancelled | `events.delete` |

Store the returned `googleEventId` on the JobSheet so later updates/deletes target the right event. Use idempotency to avoid duplicates on retry.

### Event mapping
| Calendar field | From |
|----------------|------|
| `summary` | "Folkpaths · {tour name}" |
| `start` / `end` | Job real start/end times (Asia/Bangkok) |
| `location` | Meeting point |
| `description` | Pax total, per-booking names/notes, language, pay, link to in-app job sheet |
| `reminders` | Popup 1 day before + 2 hours before (override defaults) |
| `colorId` | Optional Folkpaths brand colour |

### Edge cases
- **Token expired / revoked:** retry refresh; if it fails, surface "Reconnect Google Calendar" in-app and fall back to in-app job sheet + push only. Never lose the job because calendar sync failed.
- **Offline at accept:** queue the `events.insert` and fire on reconnect; the in-app job sheet is authoritative meanwhile.
- **Guide edits the event in Google:** ignored — next app-side change overwrites it (app is source of truth). Make this clear in the connect screen.
- **Timezone:** always write `Asia/Bangkok` so guests/guides travelling don't see shifted times.

### Operator master calendar (resolved)
The operator's own Google Calendar receives a **master copy of every dispatched tour** — one event per tour, created when the tour is dispatched/accepted (NOT for unassigned or pending bookings). The operator event additionally shows the **assigned guide** in the title/description, so the operator's calendar is a live board of who is running what.
- `summary`: "{tour name} — {guide name}"
- `description`: guests, bookings, language, pay, guide contact, link to job sheet
- Reassign → operator event description updates the guide name (event is NOT deleted, only patched).
- Cancel → operator event deleted.
- Created/updated/deleted in the same lifecycle as the guide event (§ Event lifecycle), targeting the operator's `calendarId`.
