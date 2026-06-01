# Folkpath Operations System — Build Brief

> Source of truth for the build. Keep in the repo and update as decisions are made.
> Decisions log lives at the bottom (§11).

---

## 1. Context

Folkpath is a Bangkok-based guided-tour operator. It sells a fixed catalogue of cultural
day-tours (temple tours, an evening temple-cat visit, a China Town food walk) at set
departure times across an 08:30–18:30 day. Demand arrives from multiple channels —
GetYourGuide, Viator, the company's own site, and offline — and is managed through **Bokun**
(Tripadvisor/Viator family), which aggregates bookings into one calendar.

Tours are delivered by ~25 **freelance guides** (independent contractors, paid per job with
Thai withholding tax; the system holds each guide's tax ID and bank details). Any qualified
guide can be assigned to any departure.

The operational loop — **guide dispatch**:

```
Booking arrives (Bokun/OTA) → match an available, qualified guide → send the job sheet →
guide confirms → guide runs the tour → reconcile actual pax + expenses → pay the guide
```

Manual pain today: (a) copying Bokun bookings by hand, (b) chasing guide confirmations,
(c) not knowing who is free before assigning.

**Honest note:** Bokun already provides a booking calendar and a Resource Management module
that can assign guides (as "user resources", taggable by language, with cool-down between
departures) and let guides see their schedule in the Bokun mobile app. Verify in Phase 0
what Bokun already covers. The genuine gap is *guides proactively posting availability ahead
of assignment* and *real-time custom analytics*. Build custom only where Bokun falls short.

---

## 2. Existing assets (in /assets)

- **`Folkpath_Job_Template.xlsx`** — tabs:
  - `Sheet1` (JobSheet) — letterhead + per-job sheet driven by formulas (INDEX/MATCH, VLOOKUP).
    Typing a job ID into G2 auto-fills guide details, booking list, expenses scaling to checked-in
    pax (no-shows excluded), Thai WHT, and a grand total = amount paid to the guide.
  - `GuideMaster` — 25 guides: `display_name, guide_id (G-001..G-025), tax_id, address_th,
    email, phone, bank_name, bank_acc_no, bank_acc_name, bank_branch`. (LINE_USER_ID, languages,
    qualifications NOT yet present — to be added.)
  - `TourMaster` — `Tour_No (T-001..T-009), Tour_lists, Tour_times`. (No lookup_key/base_price column.)
  - `Bookings` — `seq, booking_no, customer_name, booked_pax, tickets_inc, channel, notes`.
- **`Flow_A_Bokun_to_Master.json`** — an existing automation flow export (Bokun → master). To audit.
- **MISSING (requested in brief, not found):** `BokunPull.gs`, `Delivery.gs` (Apps Script with the
  HMAC-SHA1 Bokun signing + LINE delivery logic), and `folkpath_availability_app.html` (the
  availability prototype). Several candidate HTML prototypes exist in Downloads — owner to confirm which.

---

## 3. Reference data

**Slots:** hourly blocks 08:30–18:30 → 10 one-hour blocks (08:30…17:30) + whole-day toggle.
*Actual departure times in TourMaster: 08:30, 10:00, 13:30, 14:00, 15:00, 16:30, 17:30, 18:30.*
*(Open Q5: free-form hourly vs snapped to departure times.)*

**Tours (TourMaster):**
| ID | Tour | Time |
|----|------|------|
| T-001 | Wat Phra Kaew & Grand Palace, Wat Pho & Wat Arun | 08:30 |
| T-002 | Wat Phra Kaew & Grand Palace, Wat Pho & Wat Arun | 13:30 |
| T-003 | Wat Pho & Wat Arun | 10:00 |
| T-004 | Wat Pho & Wat Arun | 15:00 |
| T-005 | Wat Phra Kaew & Grand Palace | 14:00 |
| T-006 | Wat Pho Evening Visit with Temple Cats | 17:30 |
| T-007 | Eat Like a Local — China Town | 16:30 |
| T-008 | Eat Like a Local — China Town | 17:30 |
| T-009 | Eat Like a Local — China Town | 18:30 |

**Guides:** G-001…G-025. Languages/qualifications NOT yet captured — add `languages` and
`qualifications` (allowed Tour IDs); owner to fill.

---

## 4. Data model (target)

Move source of truth from spreadsheet into a database (keep xlsx JobSheet layout only for PDF).

- **guide** — id, display_name, contact, tax_id, bank_*, line_user_id, languages[], qualifications[]
  (tour ids), cool_down_minutes, last_assigned_at, active, auth identity.
- **tour** — id, name, default_time, duration_minutes, base_price_thb, expected_costs.
- **booking** — bokun_booking_id, channel, customer_name, pax, tickets_inc, tour_id, tour_date,
  tour_time, status, gross_amount_thb, channel_commission_rate, created_at, raw_payload.
- **job** — job_id (`FOLK-BKK-YYYYMMDD-NN`), tour_id, date, time, [bookings], total_pax,
  assigned_guide_id, status (unassigned/offered/confirmed/declined/completed), float_amount.
- **availability** — guide_id, date, slot (or whole_day), state (available / occupied / assigned).
- **assignment / offer** — job_id, guide_id, offered_at, responded_at, response.
- **reconciliation** — job_id, per-pax checked-in/no-show, expenses, wht, guide_payout.
- **audit_log** — timestamp, actor, action, entity, detail.

---

## 5. Projects

- **A. Bokun integration service** — receive Bokun webhooks (bookings/create|update|cancel),
  fetch full details via REST/GraphQL (HMAC-SHA1), upsert `booking`, regroup into `job`. Replaces
  the old 6am pull. Idempotent; logs every event. *Done:* test booking appears in DB within seconds.
- **B. Data backbone** — the DB above + internal API; export path to xlsx JobSheet for PDF.
  *Done:* every entity has CRUD, migrations, seed from existing tabs.
- **C. Guide app (PWA)** — real sign-in (role-based); set availability week/month/year (hourly +
  whole-day); receive offers (push), Confirm/Decline; view job sheet; Thai+English; installable.
  *Done:* guide logs in on phone, sets availability, appears live on operator side.
- **D. Assignment engine** — find qualified + available + cool-down-respecting guides; round-robin
  fairness (last_assigned_at); chosen dispatch mode; declines re-route. *Done:* assigning picks a
  valid guide per mode, declines re-route.
- **E. Operator console + dashboard** — live ops (today's jobs, pax, confirm status, guide×slot grid,
  month heatmap) + analytics (exec revenue/channel mix; ops guide perf/popularity/no-show). Real-time.
  *Done:* a guide or Bokun change reflects without manual refresh.
- **F. Job sheet + delivery** — PDF preserving xlsx semantics (pax scaling, no-show exclusion, WHT,
  totals); deliver via LINE (greeting + PDF + Flex confirm/decline); webhook collects confirmations;
  preview-then-final at cutoff. *Done:* assign+confirm end-to-end on test LINE account.
- **G. Reconciliation + payment** — actual pax/no-shows/expenses, Thai WHT, payment slip; feeds
  analytics. *Done:* completed job → correct payout matching xlsx logic.

---

## 6. Cross-cutting requirements

- **Real-time:** webhook-driven ingestion + push to clients (no daily batch as primary path).
- **Auth:** real role-based accounts (guide/operator/admin); secrets server-side only.
- **Localization:** Thai + English UI; Asia/Bangkok TZ; THB; Thai WHT rules.
- **Channels:** GetYourGuide, Viator, Bokun-managed, offline.
- **Notifications:** LINE for guides; operator alerts for no-guide / declines / unconfirmed.
- **Reliability:** idempotent ingestion, full audit log, safe re-runs.

---

## 7. Recommended stack (flexible)

- **Backend:** Node.js + TypeScript (or Python/FastAPI).
- **DB:** PostgreSQL.
- **Frontend:** React PWA (guide app + operator console), installable, push-capable.
- **Hosting:** stable public HTTPS endpoint for Bokun + LINE webhooks.
- **Analytics:** custom dashboard, or Looker Studio on synced Postgres/Sheet.

---

## 8. Build order & validation gates

- **Phase 0** — Prove foundation & avoid rebuilding Bokun. Authenticate to Bokun, read one booking,
  receive one test webhook. Audit Bokun's native Resource Management vs needs.
  *Gate:* owner confirms what's custom-worth-building.
- **Phase 1 — B + A:** data backbone + real-time Bokun ingestion.
- **Phase 2 — E (ops half):** operator console; live bookings/jobs + manual assignment.
- **Phase 3 — C:** guide PWA — auth + availability + offers/confirm.
- **Phase 4 — D:** assignment engine.
- **Phase 5 — F:** job sheet PDF + LINE delivery + confirmation webhook.
- **Phase 6 — E (analytics half):** real-time dashboard.
- **Phase 7 — G:** reconciliation + payment + WHT.

---

## 9. Open questions for the owner

1. **Dispatch mode:** auto-offer to first match / broadcast take-first-accept / flag candidates for operator?
2. **Source of truth:** fully to a database, or keep Google Sheets and sync?
3. **Guide load:** one tour per day, or chained across slots? Cool-down between tours?
4. **Qualifications:** which tours can each guide run, which languages?
5. **Availability granularity:** free-form hourly vs snapped to departure times?
6. **Cutoff:** minutes before a tour the job sheet locks (data freeze)?
7. **LINE:** reuse existing customer Official Account, or separate one for guides?

---

## 10. Definition of done (whole system)

Booking lands in Bokun → operator console within seconds → assigned (per chosen mode) to a qualified,
available guide → guide gets LINE job sheet and confirms in-app → dashboard reflects live → after the
tour, reconciliation produces the correct payout. No manual copy-paste, no chasing confirmations.

---

## 11. Decisions log

| Date | Question | Decision |
|------|----------|----------|
| 2026-06-01 | Q1 Dispatch mode | **Auto-offer to first match** — round-robin pick of best qualified+available guide; on decline, re-offer to next. |
| 2026-06-01 | Q2 Source of truth | **Fully in a database (PostgreSQL)** — xlsx kept only as PDF export template. |
| 2026-06-01 | Q3 Guide load | **Chained with a cool-down** — multiple tours/day allowed with a minimum gap. Gap length TBD by owner. |
| 2026-06-01 | Q5 Availability granularity | **Snapped to the 8 actual departure times** (+ whole-day toggle), not free-form hourly. |
| 2026-06-01 | Q4 Qualifications | _Open — owner to supply per-guide tour qualifications + languages._ |
| 2026-06-01 | Q6 Cutoff (data freeze) | _Open._ |
| 2026-06-01 | Q7 LINE account | _Open — reuse customer OA vs separate guide OA._ |
