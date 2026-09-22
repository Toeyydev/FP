# Folkpaths → PEAK Accounting Workflow

**Scope:** auto-post a **guide payout** (money paid *out* to a guide for tours done)
as a **PEAK Expense document**, and read the `EXP-…` document number back into
Folkpaths. Revenue (OTA income) is **out of scope** for this phase.

Legend (matching PEAK's flow diagrams):
- 🔶 **Decision** — a branch that needs a rule
- 🟨 **Process** — a step Folkpaths performs
- 🩷 **API** — a call to PEAK Open API

---

## 1. Trigger

🟨 On **ops.folkpaths.com → Payments**, the operator settles a **transfer** to a
guide. A transfer covers **one or several tours** paid together (already how the
app works — one slip / one PEAK ref per transfer). Options today:
- **📎 Slip · covers N** — one bank slip covers all the guide's pending tours, or
- **📎 Slip** on a single tour — one transfer for that tour, or
- **Mark paid** — record the payment without a slip file.

Each of these marks the tour(s) **PAID** and is the moment the PEAK expense should
be created.

---

## 2. Compute the payout (per transfer)

🟨 From the tours in the transfer, the app sums from each job sheet:
- **Gross guide fee** = Σ (fee price × time) across the tours
- **WHT** = 3% of the gross guide fee (withholding tax)
- **Reimbursable expenses** = Σ expense lines (entrance tickets, water, ferry, …)
- **Net paid** = (Gross fee − WHT) + Reimbursable expenses  ← the bank-transfer amount

---

## 3. Should we post to PEAK?

🔶 **Is PEAK connected AND configured?** (`peakEnabled` = creds set, `peakPayoutReady`
= account-chart config set)
- **No** → operator types the `EXP-…` ref by hand (current behaviour). *End.*
- **Yes** → continue to auto-post. ↓

🔶 **Was a PEAK ref already recorded for this transfer?** (idempotency)
- **Yes** → do nothing (never create a duplicate expense). *End.*
- **No** → post. ↓

---

## 4. Authenticate

🩷 `POST /api/v1/ClientToken` → returns a Client Token (cached ~24h).
Every later call carries `Client-Token` + `User-Token` + `Time-Stamp` +
`Time-Signature` (HMAC-SHA1, secret = connectId).

---

## 5. Resolve the guide as a PEAK contact (vendor)

🔶 **Does the guide exist as a PEAK contact?** (matched by Tax ID / name)
- **Exists** → use it.
- **Missing** → *decision for the business:*
  - (a) require the accountant to create the guide in PEAK first, **or**
  - (b) 🩷 `POST /api/v1/Contacts` — auto-create from the guide's name + Tax ID
    (already stored, AES-encrypted, in their Folkpaths profile).

> **Open question for accountant:** (a) or (b)?

---

## 6. Create the expense

🩷 `POST /api/v1/Expenses/allinone`

| PEAK field | Folkpaths value |
|---|---|
| `issuedDate` / `dueDate` | transfer date (yyyyMMdd) |
| `contact` `{name, type, taxNumber}` | guide name + Tax ID; `type` = individual-vendor code |
| `products[0]` | **Guide fee** — `price` = gross fee, `accountCode` = *guide-fee account*, `withHoldingTaxAmount` = 3% WHT |
| `products[1]` | **Reimbursable expenses** — `price` = total expenses, `accountCode` = *reimbursement account*, WHT 0 |
| `paidPayments` | `paymentDate` = transfer date, `paymentMethod` = *bank-transfer account* |
| `reference` / `remark` | the job sheet no.(s) `FOLK-BKK-…` + guide id |

🟨 Response → `peakExpenses.expenses[0].code` = the **`EXP-…`** document number.

---

## 7. Store + finish

- 🟨 Save the `EXP-…` code as **`peakRef`** on the transfer's TourPayment rows
  (auto-fills what the operator types today).
- 🟨 Notify the guide (already built): "payment transferred" + completed tours.
- 🟨 On PEAK failure → keep the payment recorded, surface the error; the operator
  can still add the ref manually. (PEAK posting never blocks payment.)

---

## Accounting entries (what the expense books in PEAK)

For one transfer of gross fee **G**, WHT **W = 3%·G**, expenses **E**:

| | Dr | Cr |
|---|---|---|
| Guide fee expense *(guide-fee account)* | **G** | |
| Reimbursable expenses *(reimbursement account)* | **E** | |
| Withholding tax payable (PND3) | | **W** |
| Bank *(transfer account)* | | **G − W + E** |

> **Confirm with accountant:** the exact **account codes**, the **individual-vendor
> contact `type`**, the **bank payment-method id**, and that **3% WHT (PND3)** is the
> right treatment for guide fees.

---

## Environment (set in Railway — secrets never in code)

| Var | Purpose |
|---|---|
| `PEAK_CONNECT_ID`, `PEAK_CONNECT_KEY` | developer auth (sign + Client Token) |
| `PEAK_USER_TOKEN` | business owner's consent token |
| `PEAK_BASE_URL` | unset = UAT sandbox; set prod URL to go live |
| `PEAK_ACCT_GUIDE_FEE`, `PEAK_ACCT_EXPENSES` | account codes |
| `PEAK_CONTACT_TYPE`, `PEAK_PAYMENT_METHOD`, `PEAK_VAT_TYPE` | contact / payment / VAT codes |

---

## Test plan (PEAK Phase 2 — UAT sandbox)

1. `GET /api/peak/test` → confirm the Client-Token handshake (tune signing if needed).
2. `POST /api/peak/test { guideId, jobs, paymentDate, dryRun:true }` → **preview**
   the exact payload (no posting).
3. `POST /api/peak/test { …, dryRun:false }` → post ONE expense to the sandbox,
   read back the `EXP-…` code, verify the accounting entries look right.
4. Flip live: set the prod `PEAK_BASE_URL`, pay a real guide, confirm the `EXP-` ref
   auto-fills on Payments.

---

## ASCII flow

```
Operator pays guide (Payments)
        │
        ▼
Compute: gross fee · 3% WHT · expenses · net paid
        │
   ┌────┴─────────────┐
   │ PEAK connected?  │──No──► operator types EXP- ref (manual)  ─► END
   └────┬─────────────┘
       Yes
        │
   ┌────┴─────────────┐
   │ ref already set? │──Yes─► skip (no duplicate)               ─► END
   └────┬─────────────┘
        No
        ▼
POST /ClientToken ──► token
        ▼
Guide is a PEAK contact? ──No──► create contact (or accountant sets up)
        ▼ Yes
POST /Expenses/allinone  {contact, fee+WHT, expenses, bank payment}
        ▼
PEAK returns EXP-…  ──► save as peakRef · notify guide  ─► END
```

---

## Guide ticket advances, returns, and ticket settlement

This workflow is only for money the company sends a guide to buy customer tickets.
Transport, meals and other tour costs do not use this advance ledger. These records
use **Daily Journals** because an advance is an asset balance, not an expense. FolkOPS creates one immutable outbox item in the same database transaction
as each ledger event. The worker posts it once and stores PEAK's document number.

| FolkOPS event | Daily journal |
|---|---|
| Company sends a ticket advance | Dr existing `เงินทดรองจ่าย - ไกด์` / Cr company bank |
| Guide returns unused money | Dr company bank / Cr guide advance asset |
| Approved ticket expense uses the advance | Dr ticket expense / Cr guide advance asset |

Automatic posting requires a Job No., the guide's linked PEAK contact, the selected
company bank account, a unique bank reference and a transfer slip. A guide-submitted
return remains a claim until an operator confirms it against the company bank and
allocates the full amount to advances.

Set the following only after the accountant confirms the account and journal IDs:

```json
PEAK_ADVANCE_CONFIG={
  "advanceAccountCode":"<account code of the existing เงินทดรองจ่าย - ไกด์ account>",
  "advanceAccountSubId":"<optional subaccount>",
  "bankName":"<name shown in FolkOPS>",
  "bankAccountCode":"<bank ledger account>",
  "bankAccountSubId":"<PEAK bank subaccount id>",
  "journalTypeIds":{
    "ADVANCE":"<payment journal type id>",
    "RETURN":"<receipt journal type id>",
    "EXPENSE":"<general journal type id>"
  },
  "expenseAccounts":{}
}
```

**Environment variables for the advance ledger**

| Variable | Set it on | Unset means | What it does |
|---|---|---|---|
| `PEAK_ADVANCE_CONFIG` | FP + payment-worker | nothing is sent | The accounts, the bank sub-account and the journal books, as JSON. The web app reads it for the screens; the worker reads it to send. |
| `PEAK_ADVANCE_AUTO_SYNC` | FP + payment-worker | `0` — off | `1` lets the worker post queued movements to PEAK. The web app only reports it. |
| `ADVANCE_WRITES_FROZEN` | FP (+ payment-worker to stop the sender) | `0` — writes allowed | `1` refuses every ordinary advance write: recording an advance or a return, confirming, allocating, settling, reversing. |
| `ADVANCE_EXISTING_PEAK_LINKS_ENABLED` | FP **and** payment-worker | `0` — off | `1` lets an admin record a PEAK document that already exists, even while writes are frozen. On the worker it stands the sender down. Nothing else opens. |

Both services read these through `lib/advances/freeze.ts`, so "on" means the same thing
on either side. A flag set on only one of them is the dangerous case: set both.

The worker says which of these it has at startup — `advancePeakConfig: ready|incomplete|unreadable|not-set` and `advanceAutoSync: true|false`. Status words only; it never logs a value.

Only the active `ENTRANCE_TICKET` mapping fills `expenseAccounts` at runtime. Set
`PEAK_ADVANCE_AUTO_SYNC=1` on the worker only after the configuration and
`PEAK_USER_TOKEN` are present and one preview has been checked. Do not backfill the
outbox automatically: older advances may already exist in PEAK and must be reconciled
or recorded as an existing document first.

Do not create a separate PEAK account named “เงินทดรองค่าตั๋วไกด์”. “Ticket only” is
the FolkOPS usage rule; every advance, ticket settlement, and return clears through
the existing PEAK account `เงินทดรองจ่าย - ไกด์` shown in its account activity.

If a PEAK write times out, loses its response, or the local save fails after sending,
the item becomes `UNCERTAIN`. The worker will not retry it. Check PEAK and reconcile
the document number before taking any further action.

### Money that is already in PEAK

Some advances, returns and ticket costs were entered in PEAK by hand before FolkOPS
tracked them. **Payments → Advances → PEAK doc…** (admin only) records that document
number against the movement. It calls no PEAK write endpoint: it reads the document,
checks that the accounts and the amount are the ones this movement would have used,
and then closes the outbox item as `POSTED` against the existing number — so turning
the sender on cannot produce a second document for money that moved once.

- A return is confirmed, put against its advance, and linked in ONE transaction. If
  any step fails, none of it happened.
- A ticket settlement writes the ledger line and links it, again in one transaction,
  and creates no journal — the cost is already in the document being linked.
- One document number belongs to one movement, enforced by a unique index on
  (document type, document number).
- The reason typed into the box is kept with the link and in the audit log. A
  document that names no contact — which is what PEAK's own transfers look like —
  can still be linked, but only when the accounts and the amount match exactly.
- Only ticket costs clear this way. A meal tagged "from company advance" is refused.

**Reconciliation mode.** Matching the old records is itself a write, so it needs the
freeze lifted for exactly one path and nothing else:

```ini
ADVANCE_WRITES_FROZEN=1                 # recording advances and returns stays refused
ADVANCE_EXISTING_PEAK_LINKS_ENABLED=1   # an admin may record an EXISTING document
PEAK_ADVANCE_AUTO_SYNC=0                # the sender stays off
```

While this is set, Payments → Advances shows a banner saying so, and the buttons that
would write anything else are not offered — the server refuses them regardless. The
link path refuses too if the sender is on (**409**), or if FolkOPS already has this
movement in flight or posted, unless the same document is being recorded again. Turn
`ADVANCE_EXISTING_PEAK_LINKS_ENABLED` back to `0` when the reconciliation is done; the
sender will not run while it is `1`.
