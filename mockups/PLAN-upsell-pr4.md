# Tour Upsell — PR4-0 / PR4-0b / PR4 / PR4-P status (local plan update)

Supersedes the matching sections (00-C, 00-D) of the published plan, which could not be edited
from this session. No private data: every figure, name and reference is invented.

## Stack (all drafts — nothing merged or deployed; every upsell switch off)

| PR | Branch | What |
|---|---|---|
| #411 PR4-0 | `feat/bank-transaction-registry` | Central bank-transaction registry, DB-enforced |
| #412 PR4-0b | `feat/bank-correction-admin` | Admin corrections (routes + re-record a reversed transfer); UI waits on `pr4-0b-bank-corrections.html` |
| PR4 | `feat/upsell-settlement` | Extras cash hand-in, confirm/return, reverse sale, PEAK outbox; UI waits on `pr4-upsell-settlement-v9a.html` |
| PR4-P | — | PEAK adapter + UAT (interfaces and sender state machine ready in PR4) |

## Decisions recorded (owner + Codex, 19–20 Nov 2026)

- **History is never repaired automatically.** The registry backfill stops on any double use
  (live, or a reversed record followed by another on the same reference) and names the documents.
  An Admin resolves each case from the slip (PR4-0b).
- **Revenue mapping.** `ROUTE_EXTENSION` → *Additional Tour Revenue (Upsell)*
  (`UPSELL_ROUTE_REVENUE`). A full walk-in seat (`JOIN_SOURCE_TOUR`) → *Tour Service Revenue*
  (`TOUR_SERVICE_REVENUE`), not Upsell. Account codes are mapped by the accountant in
  PeakAccountMapping; none is written in code; no VAT rate is assumed.
- **Walk-in selling is not built yet** (PR3 sells Route Extension only). The seeded, inactive
  THREE-TEMPLES-ONSITE v1 still carries the old category; the walk-in PR gives it a version 2.
- **Hand-in.** After the end-tour report; one or more immutable transfers, each with amount, actual
  date/time, reference, slip, and the receiving account *as it was when reported*; exactly the
  amount owed (no partial / SHORT); every send is a recorded submission.
- **Return = pending verification.** Reported transfers stay recorded; the guide keeps the right
  ones and replaces only a wrong slip; a transfer is never requested twice.
- **Receiving account** starts unset (hand-in waits: "Contact Admin"); an Admin picks the PEAK
  payment channel (resolved against PEAK) and confirms suitability; every change is a new version.
- **Confirm** is per submission with every transfer ticked; one transaction: transfers confirmed,
  one remittance entry, the bank-clearing event queued; stale submission or moved ledger → refused.
- **Reverse sale.** Recorded in error: the selling guide's exact affirmation, then an Admin.
  Refunded: the full sale only, with proof and who paid it back; a company-paid refund never reduces
  the guide's cash. Refused while a hand-in is sent or confirmed, or while transfers are reported.
- **Approval and the guide's ordinary fees** never depend on the hand-in.
- **PEAK.** Receipt (payment date, via guide-held cash), revenue (service date) and bank clearing
  (each central transfer, cleared once) are distinct events, frozen when they happen. Missing tax
  confirmation, mapping or receiving account → BLOCKED with the reasons shown. Void vs credit note is
  chosen per document type after UAT. Timeout → UNCERTAIN → read back, never a blind resend.

## Remaining before production

1. Owner: slips for Q-T1; confirm Q-T2 (no-digit references flagged, never matched).
2. Read-only preflight of the registry backfill on today's data (authorised; not yet run).
3. PR4-0b and PR4 UI after functional review of the two mockups.
4. Slip upload for hand-in transfers in the guide app (the API takes an uploaded slip's URL or evidence id).
5. PR4-P: PEAK adapter, UAT K1–K4, mapping of `UPSELL_GUIDE_CASH_HELD`, revenue categories and the
   receiving account; tax profile confirmed by the accountant. Include the existing
   `markDocumentPaid` post-PEAK race: reconcile, show UNCERTAIN — the precheck does not remove it.
6. Over-transfer after a reversal (money already banked exceeds what is owed) and partial / SHORT
   hand-ins: later PR (currently refused, fail-closed).
