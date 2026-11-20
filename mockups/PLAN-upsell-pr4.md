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

## Built since (20 Nov 2026, commits 714d864 … 4ba3f50 on feat/upsell-settlement)

- **Coverage is per-sale net custody.** A company-refunded sale stays covered, because the
  guide still holds its cash. A submission is refused unless the covered sales add up to
  what is owed.
- **Automatic sync in the payment worker** (`syncUpsellPeakBatch`), off unless `UPSELL_PEAK_AUTO_SYNC=1`:
  - it recovers expired leases;
  - it re-checks BLOCKED events against their kept needs and their dependencies;
  - it sends the oldest PENDING events first (lease + CAS);
  - it reads UNCERTAIN events back: found → POSTED, otherwise it waits for an Admin. It never resends.
  - A clearing, recognition or cancel waits (BLOCKED, "Waits for the PEAK receipt of …") until the sale's receipt is POSTED.
- **Receipt client and adapter** (official POST/GET `/Receipts`):
  - not VAT-registered → taxStatus 2, vatType 1, isTaxInvoice 0, the guest's total;
  - the Sale Ref is the reference and the Job Ref is in the remark;
  - it credits revenue, or unearned revenue for a future service;
  - the payment goes into guide cash held;
  - read-back is by reference.
- **Revenue recognition journal** on the service date: Dr unearned, Cr revenue.
- **PEAK status on Extras cash:** Queued / Synced / Failed / Uncertain / Blocked.
  - Admin: Send again for FAILED, Check in PEAK for UNCERTAIN.
- **The `markDocumentPaid` race is closed.** `peakPaymentConfirmedAt` is stamped as soon as
  PEAK says paid. A later local failure → PAYMENT_UNCERTAIN.
  - "Payment not found" is refused, and a DB trigger stops it from ever becoming payable again.
- **Re-recording a reversed advance** from Bank transfers → Record advance, with the reference locked; Admin only.
- **Walk-in seat backend** (`recordWalkInSale`), behind `UPSELL_ONSITE_TOUR_ENABLED`, no UI yet:
  - ฿700 a guest, booked to Tour Service Revenue;
  - seats are 12 per guide less every live guest on the job (OTA included);
  - one `walk-in` booking per sale;
  - an old-category version is refused.
  - Mockup: `mockups/pr4w-walkin-sale.html`.

## Remaining before production

1. Owner: slips for Q-T1. Confirm Q-T2 (references with no digits are flagged, never matched).
2. Read-only preflight of the registry backfill on today's data (authorised, not yet run).
3. **PEAK UAT is blocked.** UAT ClientToken returned 600 "API Client Token Validate User
   Failed" (Codex, 20 Nov). It needs PEAK to validate the UAT user; no email has been sent.
   Until then, nothing is verified live.
4. **Configuration still unknown** (BLOCKED in code, named):
   - `PEAK_UPSELL_CONFIG`:
     - `receivingAccounts[<KBank payment-method id>]` {accountCode, accountSubId};
     - `clearingJournalTypeId`, `clearingContactId`;
     - `receiptContactId`, `recognitionJournalTypeId`;
     - `receiptPayment` (ACCOUNT_CODE or PAYMENT_METHOD + id).
   - Mappings: `UPSELL_GUIDE_CASH_HELD`, `UPSELL_ROUTE_REVENUE`, `TOUR_SERVICE_REVENUE`, `UPSELL_UNEARNED_REVENUE`.
   - Tax profile confirmed by the accountant, with `peakDocumentKind`.
   - The wrapper-key case (`peakReceipts` vs `PeakReceipts`): the docs disagree; check on UAT.
5. Void / credit note for sale reversals: still BLOCKED (decided after UAT). PEAK documents
   `POST /Receipts/void` (by id or code).
6. Done: the walk-in UI (lead name optional) and the guest QR (`pr4q-guest-qr-walkin.html`). Both are behind `UPSELL_ONSITE_TOUR_ENABLED` / `UPSELL_WALKIN_QR_ENABLED` (off). Activating needs THREE-TEMPLES-ONSITE v2 at Tour Service Revenue, saved by an Admin in Settings › Products.
7. Over-transfer after a reversal, and partial / SHORT hand-ins: a later PR (refused now, fail-closed).
