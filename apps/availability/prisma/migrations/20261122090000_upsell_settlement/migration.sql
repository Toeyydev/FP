-- Tour Upsell PR4: the guide hands in the Extras cash; an Admin confirms or returns it; a sale can
-- be reversed; the PEAK events are queued (sending is PR4-P, off). Owner + Codex, 19–20 Nov 2026;
-- mockups/pr4-upsell-settlement-v9a.html.
--
--   UpsellReceivingAccount   the company account Extras cash goes to — versions, chosen and
--                            confirmed by an Admin; none = hand-in blocked ("Contact Admin")
--   CashSettlementTransfer   one real transfer the guide made: amount, actual date/time, reference,
--                            slip, and the receiving account AS IT WAS when reported. Never edited;
--                            taken out of a hand-in only with a reason (history kept). A bank-
--                            registry source (IN): one transfer cannot be used twice anywhere.
--   CashSettlementSubmission each send of the hand-in: which transfers, what was owed then; the
--                            Admin confirms or returns that exact submission
--   UpsellSaleReversal       a sale undone: recorded in error (the guide's own affirmation, then an
--                            Admin) or refunded in full (proof + who paid it back)
--   UpsellPeakEvent          what PEAK must receive, frozen when the business event happens
--
-- Additive only: no existing row is changed.

-- ─── Receiving account ─────────────────────────────────────────────────────────────────────
CREATE TABLE "UpsellReceivingAccount" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "peakPaymentMethodId" TEXT NOT NULL,
    "peakPaymentMethodName" TEXT,
    "bankAccountKey" TEXT NOT NULL,
    "accountDisplay" TEXT NOT NULL,
    "confirmedById" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL,
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UpsellReceivingAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UpsellReceivingAccount_version_key" ON "UpsellReceivingAccount"("version");
-- At most one account in use.
CREATE UNIQUE INDEX "UpsellReceivingAccount_current_key" ON "UpsellReceivingAccount"((true)) WHERE "retiredAt" IS NULL;
ALTER TABLE "UpsellReceivingAccount"
  ADD CONSTRAINT "UpsellReceivingAccount_key_check" CHECK ("bankAccountKey" ~ '^ACC:[0-9]+$' OR "bankAccountKey" ~ '^PM:.+$'),
  ADD CONSTRAINT "UpsellReceivingAccount_version_check" CHECK ("version" > 0);

CREATE FUNCTION upsell_receiving_account_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'UPSELL_RECEIVING_ACCOUNT_KEPT: a receiving account is retired, never deleted'; END IF;
  IF (to_jsonb(NEW) - 'retiredAt') IS DISTINCT FROM (to_jsonb(OLD) - 'retiredAt') OR (OLD."retiredAt" IS NOT NULL AND NEW."retiredAt" IS DISTINCT FROM OLD."retiredAt") THEN
    RAISE EXCEPTION 'UPSELL_RECEIVING_ACCOUNT_KEPT: version % is fixed — a change is a new version', OLD."version";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER upsell_receiving_account_guard BEFORE UPDATE OR DELETE ON "UpsellReceivingAccount" FOR EACH ROW EXECUTE FUNCTION upsell_receiving_account_guard();

-- ─── Transfers ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "CashSettlementTransfer" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "amountSatang" INTEGER NOT NULL,
    "transferredAt" TIMESTAMP(3) NOT NULL,
    "transferDate" TEXT NOT NULL,
    "bankRef" TEXT NOT NULL,
    "slipUrl" TEXT,
    "evidenceId" TEXT,
    "receivingAccountId" TEXT NOT NULL,
    "receivingAccountKey" TEXT NOT NULL,
    "receivingAccountDisplay" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REPORTED',
    "reportedById" TEXT NOT NULL,
    "withdrawnReason" TEXT,
    "withdrawnById" TEXT,
    "withdrawnAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "requestKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CashSettlementTransfer_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CashSettlementTransfer_settlementId_seq_key" ON "CashSettlementTransfer"("settlementId", "seq");
CREATE UNIQUE INDEX "CashSettlementTransfer_requestKey_key" ON "CashSettlementTransfer"("requestKey");
CREATE INDEX "CashSettlementTransfer_settlementId_idx" ON "CashSettlementTransfer"("settlementId");
ALTER TABLE "CashSettlementTransfer"
  ADD CONSTRAINT "CashSettlementTransfer_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "CashSettlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CashSettlementTransfer_receivingAccountId_fkey" FOREIGN KEY ("receivingAccountId") REFERENCES "UpsellReceivingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CashSettlementTransfer_amount_check" CHECK ("amountSatang" > 0),
  ADD CONSTRAINT "CashSettlementTransfer_date_check" CHECK ("transferDate" ~ '^\d{4}-\d{2}-\d{2}$'),
  ADD CONSTRAINT "CashSettlementTransfer_ref_check" CHECK (folk_tx_ref_key("bankRef") IS NOT NULL),
  ADD CONSTRAINT "CashSettlementTransfer_slip_check" CHECK (coalesce(btrim("slipUrl"), '') <> '' OR coalesce(btrim("evidenceId"), '') <> ''),
  ADD CONSTRAINT "CashSettlementTransfer_status_check" CHECK ("status" IN ('REPORTED', 'CONFIRMED', 'WITHDRAWN')),
  ADD CONSTRAINT "CashSettlementTransfer_withdrawn_check" CHECK (("status" = 'WITHDRAWN') = ("withdrawnAt" IS NOT NULL)
      AND ("status" <> 'WITHDRAWN' OR (length(btrim(coalesce("withdrawnReason", ''))) >= 5 AND "withdrawnById" IS NOT NULL))),
  ADD CONSTRAINT "CashSettlementTransfer_confirmed_check" CHECK (("status" = 'CONFIRMED') = ("confirmedAt" IS NOT NULL AND "confirmedById" IS NOT NULL));

-- A reported transfer is never edited: REPORTED → CONFIRMED (an Admin's confirmation of its
-- submission) or REPORTED → WITHDRAWN (taken out of the hand-in, with who and why). Its
-- receiving account is the one in use when it was reported — later settings never relabel it.
CREATE FUNCTION cash_settlement_transfer_guard() RETURNS trigger AS $$
DECLARE acct record; st record;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'UPSELL_TRANSFER_KEPT: a reported transfer is never deleted — take it out with a reason'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'REPORTED' THEN RAISE EXCEPTION 'UPSELL_TRANSFER_TRANSITION: a transfer starts REPORTED'; END IF;
    SELECT * INTO acct FROM "UpsellReceivingAccount" WHERE "id" = NEW."receivingAccountId";
    IF acct."retiredAt" IS NOT NULL OR acct."bankAccountKey" <> NEW."receivingAccountKey" OR acct."accountDisplay" <> NEW."receivingAccountDisplay" THEN
      RAISE EXCEPTION 'UPSELL_TRANSFER_ACCOUNT: a transfer is reported to the receiving account in use, as it is';
    END IF;
    SELECT * INTO st FROM "CashSettlement" WHERE "id" = NEW."settlementId";
    IF st."guideId" <> NEW."guideId" OR st."status" NOT IN ('DRAFT', 'RETURNED') THEN
      RAISE EXCEPTION 'UPSELL_TRANSFER_SETTLEMENT: transfers are added by the guide while the hand-in is not sent or was returned';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'withdrawnReason', 'withdrawnById', 'withdrawnAt', 'confirmedById', 'confirmedAt'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'withdrawnReason', 'withdrawnById', 'withdrawnAt', 'confirmedById', 'confirmedAt']) THEN
    RAISE EXCEPTION 'UPSELL_TRANSFER_KEPT: transfer % of a hand-in is never edited', OLD."seq";
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NOT (OLD."status" = 'REPORTED' AND NEW."status" IN ('CONFIRMED', 'WITHDRAWN')) THEN
      RAISE EXCEPTION 'UPSELL_TRANSFER_TRANSITION: a transfer cannot go from % to %', OLD."status", NEW."status";
    END IF;
    SELECT * INTO st FROM "CashSettlement" WHERE "id" = NEW."settlementId";
    IF NEW."status" = 'WITHDRAWN' AND st."status" NOT IN ('DRAFT', 'RETURNED') THEN
      RAISE EXCEPTION 'UPSELL_TRANSFER_TRANSITION: a transfer is taken out only while the hand-in is not sent or was returned';
    END IF;
    IF NEW."status" = 'CONFIRMED' AND st."status" <> 'SUBMITTED' THEN
      RAISE EXCEPTION 'UPSELL_TRANSFER_TRANSITION: a transfer is confirmed with its submission';
    END IF;
  ELSIF (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
    RAISE EXCEPTION 'UPSELL_TRANSFER_KEPT: transfer % of a hand-in is never edited', OLD."seq";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER cash_settlement_transfer_guard BEFORE INSERT OR UPDATE OR DELETE ON "CashSettlementTransfer" FOR EACH ROW EXECUTE FUNCTION cash_settlement_transfer_guard();

-- ─── Submissions ───────────────────────────────────────────────────────────────────────────
CREATE TABLE "CashSettlementSubmission" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "submissionNo" INTEGER NOT NULL,
    "expectedSatang" INTEGER NOT NULL,
    "totalSatang" INTEGER NOT NULL,
    "transferIds" TEXT[] NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "submittedById" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "returnedReason" TEXT,
    "returnedById" TEXT,
    "returnedAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    CONSTRAINT "CashSettlementSubmission_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CashSettlementSubmission_settlementId_submissionNo_key" ON "CashSettlementSubmission"("settlementId", "submissionNo");
ALTER TABLE "CashSettlementSubmission"
  ADD CONSTRAINT "CashSettlementSubmission_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "CashSettlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CashSettlementSubmission_status_check" CHECK ("status" IN ('SUBMITTED', 'RETURNED', 'CONFIRMED')),
  -- Exactly the amount owed: no partial hand-in, no SHORT (later PR).
  ADD CONSTRAINT "CashSettlementSubmission_exact_check" CHECK ("totalSatang" = "expectedSatang" AND "totalSatang" > 0 AND cardinality("transferIds") > 0),
  ADD CONSTRAINT "CashSettlementSubmission_returned_check" CHECK (("status" = 'RETURNED') = ("returnedAt" IS NOT NULL)
      AND ("status" <> 'RETURNED' OR (length(btrim(coalesce("returnedReason", ''))) >= 5 AND "returnedById" IS NOT NULL))),
  ADD CONSTRAINT "CashSettlementSubmission_confirmed_check" CHECK (("status" = 'CONFIRMED') = ("confirmedAt" IS NOT NULL AND "confirmedById" IS NOT NULL));

CREATE FUNCTION cash_settlement_submission_guard() RETURNS trigger AS $$
DECLARE st record; n int; total bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'UPSELL_SUBMISSION_KEPT: a submission is history, never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    -- The submission is the settlement's current one, its transfers are this hand-in's, still
    -- reported, distinct, and add up to the total (which the CHECK ties to what is owed).
    SELECT * INTO st FROM "CashSettlement" WHERE "id" = NEW."settlementId";
    IF st."status" <> 'SUBMITTED' OR st."submissionNo" <> NEW."submissionNo" OR st."remittedSatang" <> NEW."totalSatang" OR st."expectedSatang" <> NEW."expectedSatang" THEN
      RAISE EXCEPTION 'UPSELL_SUBMISSION_MISMATCH: a submission records the settlement exactly as it is sent';
    END IF;
    SELECT count(*), COALESCE(sum("amountSatang"), 0) INTO n, total FROM "CashSettlementTransfer"
     WHERE "id" = ANY (NEW."transferIds") AND "settlementId" = NEW."settlementId" AND "status" = 'REPORTED';
    IF n <> cardinality(NEW."transferIds") OR n <> (SELECT count(DISTINCT x) FROM unnest(NEW."transferIds") x) OR total <> NEW."totalSatang" THEN
      RAISE EXCEPTION 'UPSELL_SUBMISSION_MISMATCH: the transfers must be this hand-in''s reported ones and add up to %', NEW."totalSatang";
    END IF;
    IF NEW."status" <> 'SUBMITTED' THEN RAISE EXCEPTION 'UPSELL_SUBMISSION_TRANSITION: a submission starts SUBMITTED'; END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'returnedReason', 'returnedById', 'returnedAt', 'confirmedById', 'confirmedAt'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'returnedReason', 'returnedById', 'returnedAt', 'confirmedById', 'confirmedAt'])
     OR OLD."status" <> 'SUBMITTED' OR NEW."status" NOT IN ('RETURNED', 'CONFIRMED') THEN
    RAISE EXCEPTION 'UPSELL_SUBMISSION_KEPT: submission % is fixed once returned or confirmed', OLD."submissionNo";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER cash_settlement_submission_guard BEFORE INSERT OR UPDATE OR DELETE ON "CashSettlementSubmission" FOR EACH ROW EXECUTE FUNCTION cash_settlement_submission_guard();

-- The remittance entry: one per confirmed submission, exactly its total, and only while the
-- settlement is being confirmed (still SUBMITTED, as the same transaction confirms it next).
CREATE FUNCTION cash_custody_remitted_guard() RETURNS trigger AS $$
DECLARE sub record; st record;
BEGIN
  IF NEW."kind" <> 'REMITTED' THEN RETURN NEW; END IF;
  SELECT * INTO st FROM "CashSettlement" WHERE "id" = NEW."settlementId";
  SELECT * INTO sub FROM "CashSettlementSubmission" WHERE "settlementId" = NEW."settlementId" AND "submissionNo" = st."submissionNo";
  IF st."id" IS NULL OR st."status" <> 'SUBMITTED' OR sub."id" IS NULL OR sub."status" <> 'SUBMITTED'
     OR NEW."amountSatang" <> -sub."totalSatang" OR NEW."custodianId" <> st."guideId" OR NEW."sourceJobSheetId" <> st."sourceJobSheetId"
     OR EXISTS (SELECT 1 FROM "CashCustodyEntry" e WHERE e."settlementId" = NEW."settlementId" AND e."kind" = 'REMITTED'
                  AND NOT EXISTS (SELECT 1 FROM "CashCustodyEntry" r WHERE r."reversesId" = e."id")) THEN
    RAISE EXCEPTION 'UPSELL_CUSTODY_REMITTED: a remittance is the confirmed submission''s total, once';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER cash_custody_remitted_guard BEFORE INSERT ON "CashCustodyEntry" FOR EACH ROW EXECUTE FUNCTION cash_custody_remitted_guard();

-- ─── Sale reversals ────────────────────────────────────────────────────────────────────────
CREATE TABLE "UpsellSaleReversal" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "guideAffirmationText" TEXT,
    "guideAffirmedById" TEXT,
    "guideAffirmedAt" TIMESTAMP(3),
    "refundAmountSatang" INTEGER,
    "refundPaidBy" TEXT,
    "refundEvidenceUrl" TEXT,
    "refundEvidenceId" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UpsellSaleReversal_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "UpsellSaleReversal_saleId_idx" ON "UpsellSaleReversal"("saleId");
CREATE UNIQUE INDEX "UpsellSaleReversal_open_key" ON "UpsellSaleReversal"("saleId") WHERE "status" IN ('AWAITING_ADMIN');
CREATE UNIQUE INDEX "UpsellSaleReversal_approved_key" ON "UpsellSaleReversal"("saleId") WHERE "status" = 'APPROVED';
ALTER TABLE "UpsellSaleReversal"
  ADD CONSTRAINT "UpsellSaleReversal_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "UpsellSale"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "UpsellSaleReversal_kind_check" CHECK ("kind" IN ('RECORDED_IN_ERROR', 'REFUNDED')),
  ADD CONSTRAINT "UpsellSaleReversal_status_check" CHECK ("status" IN ('AWAITING_ADMIN', 'APPROVED', 'REJECTED')),
  ADD CONSTRAINT "UpsellSaleReversal_reason_check" CHECK (length(btrim("reason")) >= 5),
  -- Recorded in error: the guide's own affirmation, word for word, with who and when.
  ADD CONSTRAINT "UpsellSaleReversal_error_check" CHECK ("kind" <> 'RECORDED_IN_ERROR' OR (
      length(btrim(coalesce("guideAffirmationText", ''))) >= 20 AND "guideAffirmedById" IS NOT NULL AND "guideAffirmedAt" IS NOT NULL
      AND "refundAmountSatang" IS NULL AND "refundPaidBy" IS NULL)),
  -- Refunded: the full amount, the proof, and who paid it back.
  ADD CONSTRAINT "UpsellSaleReversal_refund_check" CHECK ("kind" <> 'REFUNDED' OR (
      "refundAmountSatang" > 0 AND "refundPaidBy" IN ('GUIDE_CASH', 'COMPANY')
      AND (coalesce(btrim("refundEvidenceUrl"), '') <> '' OR coalesce(btrim("refundEvidenceId"), '') <> ''))),
  ADD CONSTRAINT "UpsellSaleReversal_decided_check" CHECK (("status" = 'AWAITING_ADMIN') = ("decidedAt" IS NULL) AND (("decidedAt" IS NULL) = ("decidedById" IS NULL)));

CREATE FUNCTION upsell_sale_reversal_guard() RETURNS trigger AS $$
DECLARE s record;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'UPSELL_REVERSAL_KEPT: a reversal request is never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'AWAITING_ADMIN' THEN RAISE EXCEPTION 'UPSELL_REVERSAL_TRANSITION: a reversal starts awaiting an Admin'; END IF;
    SELECT * INTO s FROM "UpsellSale" WHERE "id" = NEW."saleId";
    IF NEW."kind" = 'REFUNDED' AND NEW."refundAmountSatang" <> s."grossSatang" THEN
      RAISE EXCEPTION 'UPSELL_REVERSAL_FULL_ONLY: a refund is the full sale (%), for now', s."grossSatang";
    END IF;
    IF NEW."kind" = 'RECORDED_IN_ERROR' AND NEW."guideAffirmedById" IS DISTINCT FROM s."sellingGuideId" THEN
      RAISE EXCEPTION 'UPSELL_REVERSAL_AFFIRMATION: only the guide who recorded the sale can affirm it was recorded in error';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'decidedById', 'decidedAt', 'decisionNote']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'decidedById', 'decidedAt', 'decisionNote'])
     OR OLD."status" <> 'AWAITING_ADMIN' OR NEW."status" NOT IN ('APPROVED', 'REJECTED') THEN
    RAISE EXCEPTION 'UPSELL_REVERSAL_KEPT: a decided reversal is fixed';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER upsell_sale_reversal_guard BEFORE INSERT OR UPDATE OR DELETE ON "UpsellSaleReversal" FOR EACH ROW EXECUTE FUNCTION upsell_sale_reversal_guard();

-- ─── PEAK events (outbox) ──────────────────────────────────────────────────────────────────
CREATE TABLE "UpsellPeakEvent" (
    "id" TEXT NOT NULL,
    "eventKind" TEXT NOT NULL,
    "sourceTable" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "eventDate" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "mappingSnapshot" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "blockedReasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "peakId" TEXT,
    "peakCode" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UpsellPeakEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UpsellPeakEvent_eventKind_sourceTable_sourceId_key" ON "UpsellPeakEvent"("eventKind", "sourceTable", "sourceId");
CREATE INDEX "UpsellPeakEvent_status_idx" ON "UpsellPeakEvent"("status");
ALTER TABLE "UpsellPeakEvent"
  ADD CONSTRAINT "UpsellPeakEvent_kind_check" CHECK ("eventKind" IN ('RECEIPT', 'REVENUE_RECOGNITION', 'BANK_CLEARING', 'SALE_CANCELLED', 'SALE_REFUNDED')),
  ADD CONSTRAINT "UpsellPeakEvent_status_check" CHECK ("status" IN ('BLOCKED', 'PENDING', 'SENDING', 'POSTED', 'FAILED', 'UNCERTAIN')),
  ADD CONSTRAINT "UpsellPeakEvent_date_check" CHECK ("eventDate" ~ '^\d{4}-\d{2}-\d{2}$'),
  ADD CONSTRAINT "UpsellPeakEvent_blocked_check" CHECK (("status" = 'BLOCKED') = (cardinality("blockedReasons") > 0)),
  ADD CONSTRAINT "UpsellPeakEvent_posted_check" CHECK ("status" <> 'POSTED' OR ("peakId" IS NOT NULL AND "peakCode" IS NOT NULL));

-- One bank-clearing event per real transfer: a central transfer is cleared into PEAK once.
CREATE TABLE "UpsellPeakEventBankLink" (
    "eventId" TEXT NOT NULL,
    "bankTransactionId" TEXT NOT NULL,
    CONSTRAINT "UpsellPeakEventBankLink_pkey" PRIMARY KEY ("eventId", "bankTransactionId")
);
CREATE UNIQUE INDEX "UpsellPeakEventBankLink_bankTransactionId_key" ON "UpsellPeakEventBankLink"("bankTransactionId");
ALTER TABLE "UpsellPeakEventBankLink"
  ADD CONSTRAINT "UpsellPeakEventBankLink_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "UpsellPeakEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "UpsellPeakEventBankLink_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- What is sent is frozen when the event happens. Status moves only along the sender's path:
--   BLOCKED → PENDING (configured since) · PENDING → SENDING → POSTED | FAILED | UNCERTAIN
--   UNCERTAIN → POSTED (found on read-back) | PENDING (read-back proved it absent)
--   FAILED → PENDING (an explicit retry)          POSTED: final, with PEAK's id and code.
CREATE FUNCTION upsell_peak_event_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'UPSELL_PEAK_EVENT_KEPT: a PEAK event is never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('BLOCKED', 'PENDING') THEN RAISE EXCEPTION 'UPSELL_PEAK_EVENT_TRANSITION: an event starts BLOCKED or PENDING'; END IF;
    RETURN NEW;
  END IF;
  IF NEW."eventKind" <> OLD."eventKind" OR NEW."sourceTable" <> OLD."sourceTable" OR NEW."sourceId" <> OLD."sourceId"
     OR NEW."eventDate" <> OLD."eventDate" OR NEW."payload" IS DISTINCT FROM OLD."payload" OR NEW."createdAt" <> OLD."createdAt"
     OR (OLD."status" <> 'BLOCKED' AND NEW."mappingSnapshot" IS DISTINCT FROM OLD."mappingSnapshot") THEN
    RAISE EXCEPTION 'UPSELL_PEAK_EVENT_KEPT: what an event sends is fixed when it happens';
  END IF;
  IF OLD."status" = 'POSTED' AND (to_jsonb(NEW) - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'updatedAt') THEN
    RAISE EXCEPTION 'UPSELL_PEAK_EVENT_KEPT: a posted event is final';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'BLOCKED' AND NEW."status" = 'PENDING')
    OR (OLD."status" = 'PENDING' AND NEW."status" IN ('SENDING', 'BLOCKED'))
    OR (OLD."status" = 'SENDING' AND NEW."status" IN ('POSTED', 'FAILED', 'UNCERTAIN'))
    OR (OLD."status" = 'UNCERTAIN' AND NEW."status" IN ('POSTED', 'PENDING'))
    OR (OLD."status" = 'FAILED' AND NEW."status" = 'PENDING')) THEN
    RAISE EXCEPTION 'UPSELL_PEAK_EVENT_TRANSITION: % → % is not a step a sender takes (never resend blindly)', OLD."status", NEW."status";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER upsell_peak_event_guard BEFORE INSERT OR UPDATE OR DELETE ON "UpsellPeakEvent" FOR EACH ROW EXECUTE FUNCTION upsell_peak_event_guard();
CREATE TRIGGER upsell_peak_event_link_kept BEFORE UPDATE OR DELETE ON "UpsellPeakEventBankLink" FOR EACH ROW EXECUTE FUNCTION bank_tx_never_deleted();

-- ─── The transfers in the bank registry (PR4-0) ────────────────────────────────────────────
-- A hand-in transfer is money IN on the receiving account it was reported to. Live unless taken
-- out; verified once an Admin confirmed it. Taking an unconfirmed one out releases its hold —
-- so, like a rejected ADV claim, only with who, why and that action's audit in this transaction.
CREATE OR REPLACE FUNCTION bank_tx_expected(p_table text, p_id text)
RETURNS TABLE (dir text, role text, amount int, ref text, account text, live boolean, verified boolean,
               d text, grp text, grp_total int, parent_id text, created timestamp) AS $$
BEGIN
  CASE p_table
  WHEN 'GuideAdvance' THEN RETURN QUERY
    SELECT 'OUT'::text, 'USE'::text, s."amountSatang", s."txRef", s."bankAccountKey", s."reversedAt" IS NULL, true, s."advanceDate", NULL::text, NULL::int, NULL::text, s."createdAt"
      FROM "GuideAdvance" s WHERE s."id" = p_id;
  WHEN 'GuideAdvanceReceipt' THEN RETURN QUERY
    SELECT 'IN'::text, 'USE'::text, s."amountSatang", s."bankRef", s."bankAccountKey", s."status" IN ('CLAIMED', 'VERIFIED') AND s."voidedAt" IS NULL,
           s."verifiedAt" IS NOT NULL OR s."status" = 'VERIFIED', s."receivedDate", NULL::text, NULL::int, NULL::text, s."createdAt"
      FROM "GuideAdvanceReceipt" s WHERE s."id" = p_id;
  WHEN 'GuideAdvanceReturn' THEN RETURN QUERY
    SELECT 'IN'::text, 'USE'::text, round(s."amount" * 100)::int, s."txRef", NULL::text, true, true, s."date", NULL::text, NULL::int, NULL::text, s."createdAt"
      FROM "GuideAdvanceReturn" s WHERE s."id" = p_id;
  WHEN 'GuideAdvanceRefund' THEN RETURN QUERY
    SELECT 'OUT'::text, 'USE'::text, s."amountSatang", s."bankRef", NULL::text, s."status" <> 'VOIDED' AND s."voidedAt" IS NULL,
           s."paidAt" IS NOT NULL, to_char(s."paidAt", 'YYYY-MM-DD'), NULL::text, NULL::int, NULL::text, s."createdAt"
      FROM "GuideAdvanceRefund" s WHERE s."id" = p_id;
  WHEN 'GuidePayment' THEN RETURN QUERY
    SELECT 'OUT'::text, 'USE'::text, round(s."amountTransferred" * 100)::int, s."bankRef", NULL::text, s."reversedAt" IS NULL, true, s."paymentDate",
           s."transferGroup", round(s."transferTotal" * 100)::int, NULL::text, s."createdAt"
      FROM "GuidePayment" s WHERE s."id" = p_id;
  WHEN 'GuidePaymentTransfer' THEN RETURN QUERY
    SELECT 'OUT'::text, 'USE'::text, round(s."amount" * 100)::int, s."bankRef", NULL::text, p."reversedAt" IS NULL, true, s."transferDate",
           NULL::text, NULL::int, s."paymentId", s."createdAt"
      FROM "GuidePaymentTransfer" s JOIN "GuidePayment" p ON p."id" = s."paymentId" WHERE s."id" = p_id;
  WHEN 'GuidePaymentDocument' THEN RETURN QUERY
    SELECT 'OUT'::text, 'DOC'::text, NULL::int, s."bankRef", s."bankAccountKey", s."status" <> 'VOIDED', true, s."paymentDate", NULL::text, NULL::int, NULL::text, s."createdAt"
      FROM "GuidePaymentDocument" s WHERE s."id" = p_id;
  WHEN 'UpsellPayment' THEN RETURN QUERY
    SELECT 'IN'::text, 'USE'::text, s."amountSatang", s."bankRef", s."bankAccountKey", s."status" IN ('PENDING', 'CONFIRMED'),
           s."confirmedAt" IS NOT NULL, to_char(s."createdAt", 'YYYY-MM-DD'), NULL::text, NULL::int, NULL::text, s."createdAt"
      FROM "UpsellPayment" s WHERE s."id" = p_id AND s."method" = 'BANK_TRANSFER';
  WHEN 'CashSettlementTransfer' THEN RETURN QUERY
    SELECT 'IN'::text, 'USE'::text, s."amountSatang", s."bankRef", s."receivingAccountKey", s."status" <> 'WITHDRAWN',
           s."confirmedAt" IS NOT NULL, s."transferDate", NULL::text, NULL::int, s."settlementId", s."createdAt"
      FROM "CashSettlementTransfer" s WHERE s."id" = p_id;
  ELSE
    RAISE EXCEPTION 'BANK_TX_GUARD: % is not a table that records bank transfers', p_table;
  END CASE;
END $$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION bank_tx_doc_no(p_table text, p_id text) RETURNS text AS $$
  SELECT CASE p_table
    WHEN 'GuideAdvance' THEN (SELECT "advanceNo" FROM "GuideAdvance" WHERE "id" = p_id)
    WHEN 'GuideAdvanceReceipt' THEN (SELECT "receiptNo" FROM "GuideAdvanceReceipt" WHERE "id" = p_id)
    WHEN 'GuideAdvanceRefund' THEN (SELECT "refundNo" FROM "GuideAdvanceRefund" WHERE "id" = p_id)
    WHEN 'GuidePayment' THEN (SELECT "paymentNo" FROM "GuidePayment" WHERE "id" = p_id)
    WHEN 'GuidePaymentTransfer' THEN (SELECT p."paymentNo" || ' transfer ' || t."seq" FROM "GuidePaymentTransfer" t JOIN "GuidePayment" p ON p."id" = t."paymentId" WHERE t."id" = p_id)
    WHEN 'GuidePaymentDocument' THEN (SELECT "paymentRef" FROM "GuidePaymentDocument" WHERE "id" = p_id)
    WHEN 'CashSettlementTransfer' THEN (SELECT s."settlementNo" || ' transfer ' || t."seq" FROM "CashSettlementTransfer" t JOIN "CashSettlement" s ON s."id" = t."settlementId" WHERE t."id" = p_id)
    ELSE p_table || ' ' || p_id END
$$ LANGUAGE sql STABLE;

CREATE FUNCTION bank_tx_transfer_withdraw_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."status" = 'REPORTED' AND NEW."status" = 'WITHDRAWN'
     AND NOT bank_tx_actor_audit(ARRAY['upsell.transfer_withdrawn'], 'CashSettlementTransfer', NEW."id", NEW."withdrawnById", ARRAY['GUIDE', 'ADMIN']) THEN
    RAISE EXCEPTION 'BANK_TX_GUARD: taking a transfer out needs who, why, and that action''s audit in the same transaction';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER bank_tx_transfer_withdraw_guard BEFORE UPDATE ON "CashSettlementTransfer" FOR EACH ROW EXECUTE FUNCTION bank_tx_transfer_withdraw_guard();

CREATE TRIGGER bank_tx_cash_settlement_transfer AFTER INSERT OR UPDATE OF "bankRef", "amountSatang", "status", "confirmedAt", "receivingAccountKey" OR DELETE ON "CashSettlementTransfer"
  FOR EACH ROW EXECUTE FUNCTION bank_tx_source();

-- ─── VAT registration (owner, 20 Nov 2026: "ยังไม่ได้จด VAT" — not VAT-registered) ───────────
-- Whether the COMPANY is VAT-registered, with where the answer came from. Not registered means no
-- VAT is charged and no tax invoice is issued — it says nothing about whether the service itself
-- would be exempt. Recorded by an Admin (lib/upsell/tax-profile), never assumed.
ALTER TABLE "TaxProfile" ADD COLUMN "vatRegistration" TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "vatRegistrationSource" TEXT, ADD COLUMN "vatRegistrationById" TEXT, ADD COLUMN "vatRegistrationAt" TIMESTAMP(3);
ALTER TABLE "TaxProfile"
  ADD CONSTRAINT "TaxProfile_vat_registration_check" CHECK ("vatRegistration" IN ('UNKNOWN', 'NOT_REGISTERED', 'REGISTERED')),
  ADD CONSTRAINT "TaxProfile_vat_registration_source_check" CHECK ("vatRegistration" = 'UNKNOWN' OR length(btrim(coalesce("vatRegistrationSource", ''))) >= 5),
  -- Not registered: no VAT on the price and no tax invoice, whatever else is configured.
  ADD CONSTRAINT "TaxProfile_not_registered_check" CHECK ("vatRegistration" <> 'NOT_REGISTERED' OR (
      "vatMode" NOT IN ('INCLUSIVE', 'EXCLUSIVE') AND coalesce("peakDocumentKind", '') <> 'TAX_INVOICE_RECEIPT'));

-- ─── Outbox: cancel before send, versions, send lease (Codex review of d246cae) ────────────
-- CANCELLED: an event that must never be sent (a sale recorded in error, before its receipt
-- reached PEAK); only from BLOCKED / PENDING / FAILED, never once it may be in PEAK.
-- version: +1 on every change (the database's), so a decision taken on a stale read cannot win.
-- leaseUntil: a sender's claim expires; an expired SENDING becomes UNCERTAIN (read back, no resend).
ALTER TABLE "UpsellPeakEvent" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "leaseUntil" TIMESTAMP(3), ADD COLUMN "cancelledReason" TEXT;
ALTER TABLE "UpsellPeakEvent" DROP CONSTRAINT "UpsellPeakEvent_status_check";
ALTER TABLE "UpsellPeakEvent"
  ADD CONSTRAINT "UpsellPeakEvent_status_check" CHECK ("status" IN ('BLOCKED', 'PENDING', 'SENDING', 'POSTED', 'FAILED', 'UNCERTAIN', 'CANCELLED')),
  ADD CONSTRAINT "UpsellPeakEvent_cancelled_check" CHECK (("status" = 'CANCELLED') = (length(btrim(coalesce("cancelledReason", ''))) >= 5)),
  ADD CONSTRAINT "UpsellPeakEvent_lease_check" CHECK (("status" = 'SENDING') = ("leaseUntil" IS NOT NULL));
ALTER TABLE "UpsellPeakEvent" DROP CONSTRAINT "UpsellPeakEvent_kind_check";
ALTER TABLE "UpsellPeakEvent" ADD CONSTRAINT "UpsellPeakEvent_kind_check" CHECK ("eventKind" IN ('RECEIPT', 'REVENUE_RECOGNITION', 'BANK_CLEARING', 'SALE_CANCELLED', 'SALE_REFUNDED'));

CREATE OR REPLACE FUNCTION upsell_peak_event_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'UPSELL_PEAK_EVENT_KEPT: a PEAK event is never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('BLOCKED', 'PENDING') THEN RAISE EXCEPTION 'UPSELL_PEAK_EVENT_TRANSITION: an event starts BLOCKED or PENDING'; END IF;
    NEW."version" := 0;
    RETURN NEW;
  END IF;
  IF NEW."eventKind" <> OLD."eventKind" OR NEW."sourceTable" <> OLD."sourceTable" OR NEW."sourceId" <> OLD."sourceId"
     OR NEW."eventDate" <> OLD."eventDate" OR NEW."payload" IS DISTINCT FROM OLD."payload" OR NEW."createdAt" <> OLD."createdAt"
     OR (OLD."status" <> 'BLOCKED' AND NEW."mappingSnapshot" IS DISTINCT FROM OLD."mappingSnapshot") THEN
    RAISE EXCEPTION 'UPSELL_PEAK_EVENT_KEPT: what an event sends is fixed when it happens';
  END IF;
  IF OLD."status" IN ('POSTED', 'CANCELLED') THEN
    RAISE EXCEPTION 'UPSELL_PEAK_EVENT_KEPT: a % event is final', lower(OLD."status");
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'BLOCKED' AND NEW."status" IN ('PENDING', 'CANCELLED'))
    OR (OLD."status" = 'PENDING' AND NEW."status" IN ('SENDING', 'BLOCKED', 'CANCELLED'))
    OR (OLD."status" = 'SENDING' AND NEW."status" IN ('POSTED', 'FAILED', 'UNCERTAIN'))
    OR (OLD."status" = 'UNCERTAIN' AND NEW."status" IN ('POSTED', 'PENDING'))
    OR (OLD."status" = 'FAILED' AND NEW."status" IN ('PENDING', 'CANCELLED'))) THEN
    RAISE EXCEPTION 'UPSELL_PEAK_EVENT_TRANSITION: % → % is not a step a sender takes (never resend blindly)', OLD."status", NEW."status";
  END IF;
  NEW."version" := OLD."version" + 1;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
