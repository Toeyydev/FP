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

🟨 On **guide.folkpaths.com → Payments**, the operator settles a **transfer** to a
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
