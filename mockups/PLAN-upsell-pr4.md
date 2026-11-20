# Tour Upsell — PR4-0 / PR4-0b / PR4 / PR4-P status (local plan update)

Supersedes the matching sections (00-C, 00-D) of the published plan, which could not be edited
from this session. No private data: every figure, name and reference is invented.

## Stack (all drafts — nothing merged or deployed; every upsell switch off)

| PR | Branch | What |
|---|---|---|
| #411 PR4-0 | `feat/bank-transaction-registry` | Central bank-transaction registry, DB-enforced |
| #412 PR4-0b | `feat/bank-correction-admin` | Admin corrections (routes + re-record a reversed transfer); UI waits on `pr4-0b-bank-corrections.html` |
| #413 PR4 | `feat/upsell-settlement` | Extras cash hand-in (code before transfer), confirm/return, reverse sale, PEAK outbox; guide + Admin screens built to `pr4-upsell-settlement-v9a.html` |
| PR4-P | `feat/upsell-settlement` (67a0616) | PEAK adapter for the bank-clearing journal, behind `UPSELL_PEAK_AUTO_SYNC`; receipts not built (UAT) |

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

- **Owner answers (20 Nov 2026), final — not asked again.** Not VAT-registered. The ฿200 upsell
  and the ฿700 full walk-in are TOTAL guest payments (no VAT added). Receiving bank KASIKORN,
  account holder บจก.โฟล์คพาธส์. The exact PEAK channel is resolved read-only and never assumed
  to be the advance account. Only the masked last digits are shown.
- **Direction is ops.folkpaths.com → PEAK.** Durable automatic sync with read-back of id, code and
  status. No manual duplicate entry in PEAK.
- **Hand-in code before any transfer.**
  - Idempotent *Get the hand-in code* after the end-tour report, own job only. A GET never mints one.
  - The code (FOLK-CSH-…) is the bank memo, shown with the job ref and the sales it covers.
  - It stays the same across Return. It is never a bank reference or a dedupe key.
  - Coverage is frozen per submission. The code appears on the guide and Admin screens and on the
    PEAK journal (reference and description).
- **PEAK clearing journal (PR4-P).**
  - Dr the receiving bank (code and sub-id per PEAK payment method from `PEAK_UPSELL_CONFIG`),
    Cr guide cash held (the account frozen on the event).
  - A refusal inside HTTP 200 → FAILED. A 5xx, a timeout or a drop → UNCERTAIN, never resent.
  - Journals have no reference lookup. An Admin enters the code from PEAK, and it is verified
    (live, lines, date) before POSTED.

## Remaining before production

1. Owner: slips for Q-T1; confirm Q-T2 (no-digit references flagged, never matched).
2. Read-only preflight of the registry backfill on today's data (authorised; not yet run).
3. Done: the PR4-0b and PR4 screens, the slip upload (evidence id), and the browser e2e
   (hand-in 17/17, bank transfers 12/12).
4. PR4-P, still open:
   - **UAT / account questions (concrete inputs):**
     - (a) the PEAK payment-method id of the KASIKORN receiving account, plus its account code and sub-id for journals;
     - (b) the PEAK account for `UPSELL_GUIDE_CASH_HELD`;
     - (c) the accounts for `UPSELL_ROUTE_REVENUE` and `TOUR_SERVICE_REVENUE`;
     - (d) the journal type and contact for the clearing journal;
     - (e) the PEAK no-VAT receipt document type and its API contract (no receipts client exists);
     - (f) UAT access to check all of the above;
     - (g) the accountant confirms the tax profile.
   - Receipt / void / credit-note adapters after (e).
   - The existing `markDocumentPaid` post-PEAK race: reconcile it and show UNCERTAIN. The precheck does not remove it.
   - An automatic sender loop (cron/worker). Today it is the Admin send/read-back routes only.
5. Walk-in sale (JOIN_SOURCE_TOUR, ฿700 total, Tour Service Revenue, THREE-TEMPLES-ONSITE v2): mockup first.
6. Re-record a reversed transfer for advances from the Bank transfers screen (guide payments only so far).
7. Over-transfer after a reversal (money already banked exceeds what is owed) and partial / SHORT
   hand-ins: later PR (currently refused, fail-closed).
