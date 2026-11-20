-- Slip-only hand-in (owner, 20 Nov 2026: "ให้อัพโหลดสลิปอย่างเดียวก็พอแล้ว"). Additive: nothing that
-- exists changes meaning, and every transfer, submission and remittance already recorded stays valid.
--
--   1. CashSettlementSlip — a bank slip the guide uploaded for the job's hand-in. It is UNVERIFIED
--      proof: no amount, time or bank reference is ever taken from the guide, the upload time, the
--      owed amount, the memo or the file. An Admin reads the slip (and the statement) and records
--      the ACTUAL amount, time and bank reference (reviewedBy/At); only Confirm turns a reviewed slip
--      into a registered CashSettlementTransfer (the bank registry, the clearing), in the confirm
--      transaction. Never deleted: taken out with a reason while the hand-in is with the guide.
--   2. CashSettlementSubmission.kind = SLIPS — a send of slips: what is owed (expectedSatang, the
--      ledger as sent) and which slips; nothing transferred is claimed (totalSatang 0) until Admin
--      confirms. TRANSFERS submissions (the earlier flow) are unchanged.
--      The receiving account the guide was shown when the slip was uploaded is frozen on the slip
--      (shownAccount*: a known version, as it was). The Admin's review records the ACTUAL recipient —
--      a known company account version (retired ones included), explicitly verified against the slip —
--      and that is what the transfer and the clearing use, even if the default account changes later.
--      Every review bumps reviewVersion; an Admin screen saves and confirms only the version it saw.
--   3. CashSettlementTransfer.slipId — a transfer born from a reviewed slip at Confirm, by an Admin,
--      with exactly the slip's reviewed facts.

CREATE TABLE "CashSettlementSlip" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shownAccountId" TEXT NOT NULL,
    "shownAccountVersion" INTEGER NOT NULL,
    "shownAccountKey" TEXT NOT NULL,
    "shownAccountDisplay" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "removedReason" TEXT,
    "removedById" TEXT,
    "removedAt" TIMESTAMP(3),
    "amountSatang" INTEGER,
    "transferredAt" TIMESTAMP(3),
    "transferDate" TEXT,
    "bankRef" TEXT,
    "receivingAccountId" TEXT,
    "receivingAccountKey" TEXT,
    "receivingAccountDisplay" TEXT,
    "receivingAccountVersion" INTEGER,
    "recipientVerified" BOOLEAN NOT NULL DEFAULT false,
    "reviewVersion" INTEGER NOT NULL DEFAULT 0,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "transferId" TEXT,
    CONSTRAINT "CashSettlementSlip_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CashSettlementSlip_settlementId_seq_key" ON "CashSettlementSlip"("settlementId", "seq");
-- One slip file is one piece of proof, for one hand-in, ever.
CREATE UNIQUE INDEX "CashSettlementSlip_evidenceId_key" ON "CashSettlementSlip"("evidenceId");
CREATE UNIQUE INDEX "CashSettlementSlip_transferId_key" ON "CashSettlementSlip"("transferId");
CREATE INDEX "CashSettlementSlip_settlementId_idx" ON "CashSettlementSlip"("settlementId");
ALTER TABLE "CashSettlementSlip"
  ADD CONSTRAINT "CashSettlementSlip_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "CashSettlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CashSettlementSlip_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "PaymentEvidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CashSettlementSlip_receivingAccountId_fkey" FOREIGN KEY ("receivingAccountId") REFERENCES "UpsellReceivingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CashSettlementSlip_shownAccountId_fkey" FOREIGN KEY ("shownAccountId") REFERENCES "UpsellReceivingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CashSettlementSlip_reviewVersion_check" CHECK ("reviewVersion" >= 0),
  ADD CONSTRAINT "CashSettlementSlip_status_check" CHECK ("status" IN ('ACTIVE', 'REMOVED')),
  ADD CONSTRAINT "CashSettlementSlip_removed_check" CHECK (("status" = 'REMOVED') = ("removedAt" IS NOT NULL)
      AND ("status" <> 'REMOVED' OR (length(btrim(coalesce("removedReason", ''))) >= 5 AND "removedById" IS NOT NULL))),
  -- The reviewed facts come together, from an Admin, or not at all.
  ADD CONSTRAINT "CashSettlementSlip_reviewed_check" CHECK (
      ("reviewedAt" IS NULL AND "reviewedById" IS NULL AND "amountSatang" IS NULL AND "transferredAt" IS NULL AND "transferDate" IS NULL AND "bankRef" IS NULL AND "receivingAccountId" IS NULL
       AND "receivingAccountVersion" IS NULL AND NOT "recipientVerified" AND "reviewVersion" = 0)
   OR ("reviewedAt" IS NOT NULL AND "reviewedById" IS NOT NULL AND "amountSatang" > 0 AND "transferredAt" IS NOT NULL AND "transferDate" ~ '^\d{4}-\d{2}-\d{2}$'
       AND folk_tx_ref_key("bankRef") IS NOT NULL AND "receivingAccountId" IS NOT NULL AND "receivingAccountKey" IS NOT NULL AND "receivingAccountDisplay" IS NOT NULL
       AND "receivingAccountVersion" IS NOT NULL AND "recipientVerified" AND "reviewVersion" > 0)),
  ADD CONSTRAINT "CashSettlementSlip_transfer_check" CHECK ("transferId" IS NULL OR "reviewedAt" IS NOT NULL);

CREATE FUNCTION cash_settlement_slip_guard() RETURNS trigger AS $$
DECLARE st record; sub record; acct record;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'UPSELL_SLIP_KEPT: a slip is never deleted — take it out with a reason'; END IF;
  SELECT * INTO st FROM "CashSettlement" WHERE "id" = NEW."settlementId";
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' OR NEW."reviewedAt" IS NOT NULL OR NEW."transferId" IS NOT NULL THEN
      RAISE EXCEPTION 'UPSELL_SLIP_TRANSITION: a slip starts ACTIVE and unreviewed';
    END IF;
    IF st."guideId" <> NEW."guideId" OR st."status" NOT IN ('DRAFT', 'RETURNED') THEN
      RAISE EXCEPTION 'UPSELL_SLIP_SETTLEMENT: slips are added by the guide while the hand-in is not sent or was returned';
    END IF;
    -- The account shown to the guide: the one in use at upload, exactly as it is.
    SELECT * INTO acct FROM "UpsellReceivingAccount" WHERE "id" = NEW."shownAccountId";
    IF acct."id" IS NULL OR acct."retiredAt" IS NOT NULL OR acct."version" <> NEW."shownAccountVersion"
       OR acct."bankAccountKey" <> NEW."shownAccountKey" OR acct."accountDisplay" <> NEW."shownAccountDisplay" THEN
      RAISE EXCEPTION 'UPSELL_SLIP_ACCOUNT: a slip records the receiving account in use when it was uploaded, as it is';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."settlementId" IS DISTINCT FROM OLD."settlementId" OR NEW."guideId" IS DISTINCT FROM OLD."guideId"
     OR NEW."seq" IS DISTINCT FROM OLD."seq" OR NEW."evidenceId" IS DISTINCT FROM OLD."evidenceId" OR NEW."uploadedById" IS DISTINCT FROM OLD."uploadedById"
     OR NEW."uploadedAt" IS DISTINCT FROM OLD."uploadedAt" OR OLD."transferId" IS NOT NULL OR OLD."status" = 'REMOVED'
     OR NEW."shownAccountId" IS DISTINCT FROM OLD."shownAccountId" OR NEW."shownAccountVersion" IS DISTINCT FROM OLD."shownAccountVersion"
     OR NEW."shownAccountKey" IS DISTINCT FROM OLD."shownAccountKey" OR NEW."shownAccountDisplay" IS DISTINCT FROM OLD."shownAccountDisplay" THEN
    RAISE EXCEPTION 'UPSELL_SLIP_KEPT: slip % is fixed', OLD."seq";
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    -- Taken out (REMOVED) only while the hand-in is with the guide, and never once reviewed facts were turned into a transfer.
    IF NEW."status" <> 'REMOVED' OR st."status" NOT IN ('DRAFT', 'RETURNED') THEN
      RAISE EXCEPTION 'UPSELL_SLIP_TRANSITION: a slip is taken out only while the hand-in is not sent or was returned';
    END IF;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'removedReason', 'removedById', 'removedAt', 'transferId']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'removedReason', 'removedById', 'removedAt', 'transferId']) THEN
    -- A review (or a re-review) is one step of the version, to a known company account as it is.
    IF NEW."reviewVersion" <> OLD."reviewVersion" + 1 OR NEW."reviewedAt" IS NULL THEN
      RAISE EXCEPTION 'UPSELL_SLIP_REVIEW: a review records every fact, one version at a time';
    END IF;
    SELECT * INTO acct FROM "UpsellReceivingAccount" WHERE "id" = NEW."receivingAccountId";
    IF acct."id" IS NULL OR acct."version" <> NEW."receivingAccountVersion" OR acct."bankAccountKey" <> NEW."receivingAccountKey" OR acct."accountDisplay" <> NEW."receivingAccountDisplay" THEN
      RAISE EXCEPTION 'UPSELL_SLIP_ACCOUNT: the recipient is a known company account, as it was recorded';
    END IF;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'removedReason', 'removedById', 'removedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'removedReason', 'removedById', 'removedAt']) THEN
    -- Facts are recorded (and the transfer linked) only while the slip is in the current SLIPS submission with Admin.
    SELECT * INTO sub FROM "CashSettlementSubmission" WHERE "settlementId" = NEW."settlementId" AND "submissionNo" = st."submissionNo";
    IF st."status" <> 'SUBMITTED' OR sub."id" IS NULL OR sub."kind" <> 'SLIPS' OR sub."status" <> 'SUBMITTED' OR NOT (NEW."id" = ANY (sub."slipIds")) OR NEW."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'UPSELL_SLIP_REVIEW: a slip is reviewed only while it is in the hand-in with Admin';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER cash_settlement_slip_guard BEFORE INSERT OR UPDATE OR DELETE ON "CashSettlementSlip" FOR EACH ROW EXECUTE FUNCTION cash_settlement_slip_guard();

-- ─── Submissions: TRANSFERS (as before) or SLIPS ────────────────────────────────────────────
ALTER TABLE "CashSettlementSubmission" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'TRANSFERS';
ALTER TABLE "CashSettlementSubmission" ADD COLUMN "slipIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "CashSettlementSubmission" ADD CONSTRAINT "CashSettlementSubmission_kind_check" CHECK ("kind" IN ('TRANSFERS', 'SLIPS'));
ALTER TABLE "CashSettlementSubmission" DROP CONSTRAINT "CashSettlementSubmission_exact_check";
ALTER TABLE "CashSettlementSubmission" ADD CONSTRAINT "CashSettlementSubmission_exact_check" CHECK (
     ("kind" = 'TRANSFERS' AND "totalSatang" = "expectedSatang" AND "totalSatang" > 0 AND cardinality("transferIds") > 0 AND cardinality("slipIds") = 0)
  -- A send of slips claims nothing transferred: only what is owed, and the slips.
  OR ("kind" = 'SLIPS' AND "totalSatang" = 0 AND "expectedSatang" > 0 AND cardinality("transferIds") = 0 AND cardinality("slipIds") > 0));

CREATE OR REPLACE FUNCTION cash_settlement_submission_guard() RETURNS trigger AS $$
DECLARE st record; n int; total bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'UPSELL_SUBMISSION_KEPT: a submission is history, never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO st FROM "CashSettlement" WHERE "id" = NEW."settlementId";
    IF NEW."kind" = 'SLIPS' THEN
      -- The current send, of this hand-in's ACTIVE slips (distinct), what is owed as sent, nothing claimed remitted.
      IF st."status" <> 'SUBMITTED' OR st."submissionNo" <> NEW."submissionNo" OR st."remittedSatang" <> 0 OR st."expectedSatang" <> NEW."expectedSatang" THEN
        RAISE EXCEPTION 'UPSELL_SUBMISSION_MISMATCH: a submission records the settlement exactly as it is sent';
      END IF;
      SELECT count(*) INTO n FROM "CashSettlementSlip" WHERE "id" = ANY (NEW."slipIds") AND "settlementId" = NEW."settlementId" AND "status" = 'ACTIVE';
      IF n <> cardinality(NEW."slipIds") OR n <> (SELECT count(DISTINCT x) FROM unnest(NEW."slipIds") x) THEN
        RAISE EXCEPTION 'UPSELL_SUBMISSION_MISMATCH: the slips must be this hand-in''s, not taken out';
      END IF;
    ELSE
      IF st."status" <> 'SUBMITTED' OR st."submissionNo" <> NEW."submissionNo" OR st."remittedSatang" <> NEW."totalSatang" OR st."expectedSatang" <> NEW."expectedSatang" THEN
        RAISE EXCEPTION 'UPSELL_SUBMISSION_MISMATCH: a submission records the settlement exactly as it is sent';
      END IF;
      SELECT count(*), COALESCE(sum("amountSatang"), 0) INTO n, total FROM "CashSettlementTransfer"
       WHERE "id" = ANY (NEW."transferIds") AND "settlementId" = NEW."settlementId" AND "status" = 'REPORTED';
      IF n <> cardinality(NEW."transferIds") OR n <> (SELECT count(DISTINCT x) FROM unnest(NEW."transferIds") x) OR total <> NEW."totalSatang" THEN
        RAISE EXCEPTION 'UPSELL_SUBMISSION_MISMATCH: the transfers must be this hand-in''s reported ones and add up to %', NEW."totalSatang";
      END IF;
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

-- ─── Transfers born from a reviewed slip, at Confirm ────────────────────────────────────────
ALTER TABLE "CashSettlementTransfer" ADD COLUMN "slipId" TEXT;
CREATE UNIQUE INDEX "CashSettlementTransfer_slipId_key" ON "CashSettlementTransfer"("slipId");
ALTER TABLE "CashSettlementTransfer" ADD CONSTRAINT "CashSettlementTransfer_slipId_fkey" FOREIGN KEY ("slipId") REFERENCES "CashSettlementSlip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION cash_settlement_transfer_guard() RETURNS trigger AS $$
DECLARE acct record; st record; sl record; sub record;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'UPSELL_TRANSFER_KEPT: a reported transfer is never deleted — take it out with a reason'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'REPORTED' THEN RAISE EXCEPTION 'UPSELL_TRANSFER_TRANSITION: a transfer starts REPORTED'; END IF;
    SELECT * INTO st FROM "CashSettlement" WHERE "id" = NEW."settlementId";
    IF NEW."slipId" IS NOT NULL THEN
      -- From a slip: during its SLIPS submission, with exactly the facts the Admin recorded from it.
      SELECT * INTO sl FROM "CashSettlementSlip" WHERE "id" = NEW."slipId";
      SELECT * INTO sub FROM "CashSettlementSubmission" WHERE "settlementId" = NEW."settlementId" AND "submissionNo" = st."submissionNo";
      IF sl."id" IS NULL OR sl."settlementId" <> NEW."settlementId" OR sl."status" <> 'ACTIVE' OR sl."reviewedAt" IS NULL
         OR st."guideId" <> NEW."guideId" OR st."status" <> 'SUBMITTED' OR sub."kind" <> 'SLIPS' OR sub."status" <> 'SUBMITTED' OR NOT (sl."id" = ANY (sub."slipIds"))
         OR sl."amountSatang" <> NEW."amountSatang" OR sl."transferredAt" <> NEW."transferredAt" OR sl."transferDate" <> NEW."transferDate" OR sl."bankRef" <> NEW."bankRef"
         OR sl."evidenceId" IS DISTINCT FROM NEW."evidenceId" OR sl."receivingAccountId" <> NEW."receivingAccountId"
         OR sl."receivingAccountKey" <> NEW."receivingAccountKey" OR sl."receivingAccountDisplay" <> NEW."receivingAccountDisplay" THEN
        RAISE EXCEPTION 'UPSELL_TRANSFER_SLIP: a transfer from a slip is made at Confirm, with the slip''s reviewed facts';
      END IF;
      RETURN NEW;
    END IF;
    SELECT * INTO acct FROM "UpsellReceivingAccount" WHERE "id" = NEW."receivingAccountId";
    IF acct."retiredAt" IS NOT NULL OR acct."bankAccountKey" <> NEW."receivingAccountKey" OR acct."accountDisplay" <> NEW."receivingAccountDisplay" THEN
      RAISE EXCEPTION 'UPSELL_TRANSFER_ACCOUNT: a transfer is reported to the receiving account in use, as it is';
    END IF;
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
    IF NEW."status" = 'WITHDRAWN' AND (st."status" NOT IN ('DRAFT', 'RETURNED') OR OLD."slipId" IS NOT NULL) THEN
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

-- ─── The remittance of a SLIPS submission: what was owed as sent (the confirm checked the slips add up to it) ─
CREATE OR REPLACE FUNCTION cash_custody_remitted_guard() RETURNS trigger AS $$
DECLARE sub record; st record; amount int;
BEGIN
  IF NEW."kind" <> 'REMITTED' THEN RETURN NEW; END IF;
  SELECT * INTO st FROM "CashSettlement" WHERE "id" = NEW."settlementId";
  SELECT * INTO sub FROM "CashSettlementSubmission" WHERE "settlementId" = NEW."settlementId" AND "submissionNo" = st."submissionNo";
  amount := CASE WHEN sub."kind" = 'SLIPS' THEN
    -- Exactly the reviewed slips turned into transfers in this confirmation.
    (SELECT COALESCE(sum(t."amountSatang"), 0) FROM "CashSettlementTransfer" t JOIN "CashSettlementSlip" s ON s."transferId" = t."id" WHERE s."id" = ANY (sub."slipIds"))
    ELSE sub."totalSatang" END;
  IF st."id" IS NULL OR st."status" <> 'SUBMITTED' OR sub."id" IS NULL OR sub."status" <> 'SUBMITTED'
     OR NEW."amountSatang" <> -amount OR (sub."kind" = 'SLIPS' AND amount <> sub."expectedSatang")
     OR NEW."custodianId" <> st."guideId" OR NEW."sourceJobSheetId" <> st."sourceJobSheetId"
     OR EXISTS (SELECT 1 FROM "CashCustodyEntry" e WHERE e."settlementId" = NEW."settlementId" AND e."kind" = 'REMITTED'
                  AND NOT EXISTS (SELECT 1 FROM "CashCustodyEntry" r WHERE r."reversesId" = e."id")) THEN
    RAISE EXCEPTION 'UPSELL_CUSTODY_REMITTED: a remittance is the confirmed submission''s total, once';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ─── The settlement of a SLIPS submission records what was remitted only at Confirm ─────────
CREATE OR REPLACE FUNCTION cash_settlement_guard() RETURNS trigger AS $$
DECLARE slips_confirm boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'UPSELL_SETTLEMENT_IMMUTABLE: settlement % is %; it cannot be deleted', OLD."settlementNo", OLD."status";
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('DRAFT', 'SUBMITTED') THEN
      RAISE EXCEPTION 'UPSELL_SETTLEMENT_TRANSITION: a settlement starts DRAFT or SUBMITTED, not %', NEW."status";
    END IF;
    IF NEW."returnedReason" IS NOT NULL THEN
      RAISE EXCEPTION 'UPSELL_SETTLEMENT_RETURN_REASON: a new settlement has no return reason';
    END IF;
    NEW."submissionNo" := CASE WHEN NEW."status" = 'SUBMITTED' THEN 1 ELSE 0 END;
    NEW."submittedAt"  := CASE WHEN NEW."status" = 'SUBMITTED' THEN now() ELSE NULL END;
    RETURN NEW;
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'DRAFT'     AND NEW."status" = 'SUBMITTED')
    OR (OLD."status" = 'SUBMITTED' AND NEW."status" IN ('RETURNED', 'CONFIRMED'))
    OR (OLD."status" = 'RETURNED'  AND NEW."status" = 'SUBMITTED')
    OR (OLD."status" = 'CONFIRMED' AND NEW."status" = 'REVERSED')) THEN
    RAISE EXCEPTION 'UPSELL_SETTLEMENT_TRANSITION: settlement % cannot go from % to %', OLD."settlementNo", OLD."status", NEW."status";
  END IF;

  IF OLD."status" <> 'DRAFT' AND (
        NEW."guideId" IS DISTINCT FROM OLD."guideId" OR NEW."sourceJobSheetId" IS DISTINCT FROM OLD."sourceJobSheetId"
     OR NEW."settlementNo" IS DISTINCT FROM OLD."settlementNo" OR NEW."requestKey" IS DISTINCT FROM OLD."requestKey") THEN
    RAISE EXCEPTION 'UPSELL_SETTLEMENT_IMMUTABLE: the guide and job of settlement % are fixed', OLD."settlementNo";
  END IF;

  -- A SLIPS submission is sent with nothing claimed remitted (0); its Confirm records what the
  -- reviewed slips add up to — exactly what was owed as sent — and nothing else.
  slips_confirm := OLD."status" = 'SUBMITTED' AND NEW."status" = 'CONFIRMED' AND OLD."remittedSatang" = 0
    AND NEW."remittedSatang" = OLD."expectedSatang" AND NEW."expectedSatang" = OLD."expectedSatang"
    AND EXISTS (SELECT 1 FROM "CashSettlementSubmission" s WHERE s."settlementId" = OLD."id" AND s."submissionNo" = OLD."submissionNo" AND s."kind" = 'SLIPS');

  IF OLD."status" NOT IN ('DRAFT', 'RETURNED') AND NOT slips_confirm AND (
        NEW."expectedSatang" IS DISTINCT FROM OLD."expectedSatang" OR NEW."remittedSatang" IS DISTINCT FROM OLD."remittedSatang"
     OR NEW."method" IS DISTINCT FROM OLD."method" OR NEW."evidenceId" IS DISTINCT FROM OLD."evidenceId"
     OR NEW."bankRef" IS DISTINCT FROM OLD."bankRef" OR NEW."bankRefNormalized" IS DISTINCT FROM OLD."bankRefNormalized"
     OR NEW."bankAccountKey" IS DISTINCT FROM OLD."bankAccountKey") THEN
    RAISE EXCEPTION 'UPSELL_SETTLEMENT_IMMUTABLE: settlement % is %; return it to correct the money', OLD."settlementNo", OLD."status";
  END IF;
  IF slips_confirm AND (NEW."method" IS DISTINCT FROM OLD."method" OR NEW."evidenceId" IS DISTINCT FROM OLD."evidenceId"
     OR NEW."bankRef" IS DISTINCT FROM OLD."bankRef" OR NEW."bankRefNormalized" IS DISTINCT FROM OLD."bankRefNormalized" OR NEW."bankAccountKey" IS DISTINCT FROM OLD."bankAccountKey") THEN
    RAISE EXCEPTION 'UPSELL_SETTLEMENT_IMMUTABLE: settlement % is %; return it to correct the money', OLD."settlementNo", OLD."status";
  END IF;

  IF OLD."status" = 'SUBMITTED' AND NEW."status" = 'RETURNED' THEN
    IF NEW."returnedReason" IS NULL OR btrim(NEW."returnedReason") = '' THEN
      RAISE EXCEPTION 'UPSELL_SETTLEMENT_RETURN_REASON: returning settlement % needs a reason', OLD."settlementNo";
    END IF;
  ELSIF OLD."status" = 'RETURNED' AND NEW."status" = 'SUBMITTED' THEN
    IF NEW."returnedReason" IS DISTINCT FROM OLD."returnedReason" AND NEW."returnedReason" IS NOT NULL THEN
      RAISE EXCEPTION 'UPSELL_SETTLEMENT_IMMUTABLE: the return reason of settlement % cannot be rewritten', OLD."settlementNo";
    END IF;
    NEW."returnedReason" := NULL;
  ELSIF NEW."returnedReason" IS DISTINCT FROM OLD."returnedReason" THEN
    RAISE EXCEPTION 'UPSELL_SETTLEMENT_IMMUTABLE: a return reason is given only when returning settlement %', OLD."settlementNo";
  END IF;

  IF (NEW."confirmedAt" IS DISTINCT FROM OLD."confirmedAt" OR NEW."confirmedById" IS DISTINCT FROM OLD."confirmedById")
     AND NOT (OLD."status" = 'SUBMITTED' AND NEW."status" = 'CONFIRMED') THEN
    RAISE EXCEPTION 'UPSELL_SETTLEMENT_IMMUTABLE: settlement % is confirmed only by confirming a submission', OLD."settlementNo";
  END IF;

  IF NEW."status" = 'SUBMITTED' AND OLD."status" <> 'SUBMITTED' THEN
    NEW."submissionNo" := OLD."submissionNo" + 1;
    NEW."submittedAt"  := now();
  ELSIF NEW."submissionNo" IS DISTINCT FROM OLD."submissionNo" OR NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt" THEN
    RAISE EXCEPTION 'UPSELL_SETTLEMENT_IMMUTABLE: the submission count of settlement % is the database''s', OLD."settlementNo";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
