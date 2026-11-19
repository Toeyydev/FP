-- Bank transactions (PR4-0, owner 19 Nov 2026; plan v15 §00-C "T").
--
-- One real bank transfer = one "BankTransaction". Every table that records a transfer is linked
-- to it by a trigger, as a USE (money applied — counts toward the transfer's amount) or a DOC
-- (a document describing the same transfer — counts nothing):
--
--   OUT  GuideAdvance (USE) · GuideAdvanceRefund (USE) · GuidePayment (USE)
--        GuidePaymentTransfer (USE) · GuidePaymentDocument (DOC)
--   IN   GuideAdvanceReceipt (USE) · GuideAdvanceReturn (USE) · UpsellPayment, bank transfer (USE)
--
-- The rules:
--   • The key of a transfer is its direction + Folkpaths' account + the bank reference reduced by
--     folk_tx_ref_key() (the P0 normalisation). Many tables record no account: a reference with
--     no account matches one with an account (same direction) — it may be the same transfer, so
--     it is treated as the same one, never as a new one.
--   • A transfer's amount comes from its first USE — the transfer-level record — never from a
--     document's total (a PEAK payment document can cover several transfers). Rows recorded
--     together as parts of ONE transfer (guide payments sharing a transferGroup: one transfer
--     for jobs and reviews, lib/payments-v2) make up its amount together.
--   • The live USEs of a transfer never add up to more than its amount: one transfer cannot pay
--     twice (BANK_TX_OVERUSED).
--   • Nothing is released. Reversing or voiding a record does not undo the bank movement: its
--     use stops counting (live = false) and the transaction stays; the same transfer can be
--     applied again only within its amount. A transaction is never deleted.
--   • A reference with no digit in it (e.g. a bank's name typed in its place) is kept exactly as
--     typed, marked PENDING_VERIFICATION and NEEDS_REVIEW, and never matched against other
--     references — it cannot be checked as a bank reference until an Admin fixes it from the slip
--     (owner, Q-T2: no made-up numbers, no digit-count rule).
--
-- No existing row is changed. The backfill only adds BankTransaction / BankTransactionUse rows;
-- if the existing data breaks a rule it STOPS before anything is written and names the rows.

-- CreateTable
CREATE TABLE "BankTransaction" (
    "id" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "accountKey" TEXT,
    "refRaw" TEXT,
    "refKey" TEXT,
    "refStatus" TEXT NOT NULL,
    "internalCode" TEXT,
    "amountSatang" INTEGER,
    "amountGroup" TEXT,
    "transferDate" TEXT,
    "reviewStatus" TEXT NOT NULL DEFAULT 'OK',
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankTransactionUse" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "sourceTable" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "amountSatang" INTEGER,
    "groupKey" TEXT,
    "live" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankTransactionUse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_internalCode_key" ON "BankTransaction"("internalCode");

-- CreateIndex
CREATE INDEX "BankTransaction_direction_refKey_idx" ON "BankTransaction"("direction", "refKey");

-- CreateIndex
CREATE INDEX "BankTransaction_reviewStatus_idx" ON "BankTransaction"("reviewStatus");

-- CreateIndex
CREATE INDEX "BankTransactionUse_transactionId_idx" ON "BankTransactionUse"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "BankTransactionUse_sourceTable_sourceId_key" ON "BankTransactionUse"("sourceTable", "sourceId");

-- AddForeignKey
ALTER TABLE "BankTransactionUse" ADD CONSTRAINT "BankTransactionUse_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "BankTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Checks ────────────────────────────────────────────────────────────────────────────────

ALTER TABLE "BankTransaction"
  ADD CONSTRAINT "BankTransaction_direction_check" CHECK ("direction" IN ('IN', 'OUT')),
  ADD CONSTRAINT "BankTransaction_ref_status_check" CHECK ("refStatus" IN ('BANK_REF', 'PENDING_VERIFICATION', 'INTERNAL')),
  -- A bank reference has its key; one waiting for verification keeps only what was typed; an
  -- internal transfer has an internal code and claims no bank reference at all.
  ADD CONSTRAINT "BankTransaction_ref_shape_check" CHECK (
       ("refStatus" = 'BANK_REF' AND "refKey" IS NOT NULL AND "refRaw" IS NOT NULL)
    OR ("refStatus" = 'PENDING_VERIFICATION' AND "refKey" IS NULL AND "refRaw" IS NOT NULL)
    OR ("refStatus" = 'INTERNAL' AND "refKey" IS NULL AND "internalCode" IS NOT NULL)),
  ADD CONSTRAINT "BankTransaction_amount_check" CHECK ("amountSatang" IS NULL OR "amountSatang" > 0),
  ADD CONSTRAINT "BankTransaction_review_check" CHECK ("reviewStatus" IN ('OK', 'NEEDS_REVIEW'));

ALTER TABLE "BankTransactionUse"
  ADD CONSTRAINT "BankTransactionUse_role_check" CHECK ("role" IN ('USE', 'DOC')),
  ADD CONSTRAINT "BankTransactionUse_amount_check" CHECK (("role" = 'USE') = ("amountSatang" IS NOT NULL) AND ("amountSatang" IS NULL OR "amountSatang" > 0));

-- The registry is never pruned.
CREATE FUNCTION bank_tx_never_deleted() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'BANK_TX_KEPT: % rows are never deleted — a bank movement happened; mark a use not live instead', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER bank_tx_never_deleted BEFORE DELETE ON "BankTransaction" FOR EACH ROW EXECUTE FUNCTION bank_tx_never_deleted();
CREATE TRIGGER bank_tx_use_never_deleted BEFORE DELETE ON "BankTransactionUse" FOR EACH ROW EXECUTE FUNCTION bank_tx_never_deleted();

-- ─── The link ──────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION bank_tx_new_id(prefix text) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT prefix || substr(md5(random()::text || clock_timestamp()::text || txid_current()::text), 1, 22)
$$;

-- Link one source row to its transfer (or record that it no longer names one).
CREATE FUNCTION bank_tx_attach(p_table text, p_id text, p_dir text, p_role text, p_amount int, p_ref text,
                               p_account text, p_live boolean, p_date text, p_group text DEFAULT NULL) RETURNS void AS $$
DECLARE
  k text := folk_tx_ref_key(p_ref);
  status text;
  use_id text;
  use_tx text;
  tx_id text;
  tx_amount int;
  tx_account text;
  tx_group text;
  n int;
  applied bigint;
BEGIN
  SELECT "id", "transactionId" INTO use_id, use_tx FROM "BankTransactionUse" WHERE "sourceTable" = p_table AND "sourceId" = p_id FOR UPDATE;

  IF k IS NULL THEN
    -- The row names no transfer now. Its old link, if any, stops counting; the transfer stays.
    IF use_id IS NOT NULL THEN
      UPDATE "BankTransactionUse" SET "live" = false, "updatedAt" = now() WHERE "id" = use_id AND "live";
    END IF;
    RETURN;
  END IF;

  status := CASE WHEN k ~ '[0-9]' THEN 'BANK_REF' ELSE 'PENDING_VERIFICATION' END;

  IF status = 'BANK_REF' THEN
    -- One writer per reference: two records of the same transfer arriving together queue here.
    PERFORM pg_advisory_xact_lock(hashtextextended('bank-tx:' || p_dir || ':' || k, 0));
    SELECT count(*) INTO n FROM "BankTransaction"
     WHERE "direction" = p_dir AND "refKey" = k AND "refStatus" = 'BANK_REF'
       AND (p_account IS NULL OR "accountKey" IS NULL OR "accountKey" = p_account);
    IF n = 1 THEN
      SELECT "id" INTO tx_id FROM "BankTransaction"
       WHERE "direction" = p_dir AND "refKey" = k AND "refStatus" = 'BANK_REF'
         AND (p_account IS NULL OR "accountKey" IS NULL OR "accountKey" = p_account) FOR UPDATE;
    ELSIF n > 1 THEN
      -- A reference with no account could be any of several transfers: refuse rather than guess.
      SELECT "id" INTO tx_id FROM "BankTransaction"
       WHERE "direction" = p_dir AND "refKey" = k AND "refStatus" = 'BANK_REF' AND "accountKey" = p_account FOR UPDATE;
      IF tx_id IS NULL THEN
        RAISE EXCEPTION 'BANK_TX_AMBIGUOUS: % % reference …% matches % transfers on different accounts; record the account', p_table, p_id, right(k, 4), n;
      END IF;
    END IF;
  ELSE
    -- Not checkable as a bank reference: never matched to others. The same row keeps its own.
    IF use_tx IS NOT NULL THEN
      SELECT "id" INTO tx_id FROM "BankTransaction" WHERE "id" = use_tx AND "refStatus" = 'PENDING_VERIFICATION' AND "refRaw" = p_ref FOR UPDATE;
    END IF;
  END IF;

  IF tx_id IS NULL THEN
    tx_id := bank_tx_new_id('btx');
    INSERT INTO "BankTransaction" ("id", "direction", "accountKey", "refRaw", "refKey", "refStatus", "amountSatang", "amountGroup", "transferDate", "reviewStatus", "reviewNote")
    VALUES (tx_id, p_dir, p_account, p_ref, CASE WHEN status = 'BANK_REF' THEN k END, status,
            CASE WHEN p_role = 'USE' THEN p_amount END, CASE WHEN p_role = 'USE' THEN p_group END, p_date,
            CASE WHEN status = 'BANK_REF' THEN 'OK' ELSE 'NEEDS_REVIEW' END,
            CASE WHEN status = 'BANK_REF' THEN NULL ELSE 'The reference has no digits — check the slip; it cannot be matched as a bank reference until corrected.' END);
  ELSE
    SELECT "amountSatang", "accountKey" INTO tx_amount, tx_account FROM "BankTransaction" WHERE "id" = tx_id;
    UPDATE "BankTransaction" SET
        "accountKey"   = COALESCE("accountKey", p_account),
        "amountSatang" = COALESCE("amountSatang", CASE WHEN p_role = 'USE' THEN p_amount END),
        "amountGroup"  = CASE WHEN "amountSatang" IS NULL AND p_role = 'USE' THEN p_group ELSE "amountGroup" END,
        "transferDate" = COALESCE("transferDate", p_date),
        "updatedAt"    = now()
      WHERE "id" = tx_id
        AND ((tx_account IS NULL AND p_account IS NOT NULL) OR (tx_amount IS NULL AND p_role = 'USE'));
  END IF;

  IF use_id IS NULL THEN
    INSERT INTO "BankTransactionUse" ("id", "transactionId", "sourceTable", "sourceId", "role", "amountSatang", "groupKey", "live")
    VALUES (bank_tx_new_id('btu'), tx_id, p_table, p_id, p_role, CASE WHEN p_role = 'USE' THEN p_amount END, p_group, p_live);
  ELSE
    UPDATE "BankTransactionUse" SET "transactionId" = tx_id, "role" = p_role,
           "amountSatang" = CASE WHEN p_role = 'USE' THEN p_amount END, "groupKey" = p_group, "live" = p_live, "updatedAt" = now()
     WHERE "id" = use_id;
  END IF;

  -- Parts of one transfer recorded together (the group of the transfer's first USE) make up
  -- its amount together — live or not: reversing a record does not undo the bank movement.
  SELECT "amountGroup" INTO tx_group FROM "BankTransaction" WHERE "id" = tx_id;
  IF tx_group IS NOT NULL THEN
    UPDATE "BankTransaction" SET "amountSatang" = (
        SELECT sum("amountSatang") FROM "BankTransactionUse" WHERE "transactionId" = tx_id AND "role" = 'USE' AND "groupKey" = tx_group),
      "updatedAt" = now()
     WHERE "id" = tx_id;
  END IF;

  -- One transfer cannot pay twice.
  SELECT "amountSatang" INTO tx_amount FROM "BankTransaction" WHERE "id" = tx_id;
  SELECT COALESCE(sum("amountSatang"), 0) INTO applied FROM "BankTransactionUse" WHERE "transactionId" = tx_id AND "role" = 'USE' AND "live";
  IF tx_amount IS NOT NULL AND applied > tx_amount THEN
    RAISE EXCEPTION 'BANK_TX_OVERUSED: % % would apply transfer …% (% satang) % satang in all — one transfer cannot pay twice',
      p_table, p_id, right(coalesce(k, ''), 4), tx_amount, applied;
  END IF;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION bank_tx_detach(p_table text, p_id text) RETURNS void AS $$
BEGIN
  UPDATE "BankTransactionUse" SET "live" = false, "updatedAt" = now() WHERE "sourceTable" = p_table AND "sourceId" = p_id AND "live";
END $$ LANGUAGE plpgsql;

-- ─── One trigger per source table ──────────────────────────────────────────────────────────

CREATE FUNCTION bank_tx_guide_advance() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN PERFORM bank_tx_detach('GuideAdvance', OLD."id"); RETURN OLD; END IF;
  PERFORM bank_tx_attach('GuideAdvance', NEW."id", 'OUT', 'USE', NEW."amountSatang", NEW."txRef", NULL, NEW."reversedAt" IS NULL, NEW."advanceDate");
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER bank_tx_guide_advance AFTER INSERT OR UPDATE OF "txRef", "amountSatang", "reversedAt" OR DELETE ON "GuideAdvance"
  FOR EACH ROW EXECUTE FUNCTION bank_tx_guide_advance();

CREATE FUNCTION bank_tx_guide_advance_receipt() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN PERFORM bank_tx_detach('GuideAdvanceReceipt', OLD."id"); RETURN OLD; END IF;
  -- A rejected claim means the money was never seen: it applies nothing (the transfer, if any, stays).
  PERFORM bank_tx_attach('GuideAdvanceReceipt', NEW."id", 'IN', 'USE', NEW."amountSatang", NEW."bankRef", NULL,
                         NEW."status" IN ('CLAIMED', 'VERIFIED') AND NEW."voidedAt" IS NULL, NEW."receivedDate");
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER bank_tx_guide_advance_receipt AFTER INSERT OR UPDATE OF "bankRef", "amountSatang", "status", "voidedAt" OR DELETE ON "GuideAdvanceReceipt"
  FOR EACH ROW EXECUTE FUNCTION bank_tx_guide_advance_receipt();

CREATE FUNCTION bank_tx_guide_advance_return() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN PERFORM bank_tx_detach('GuideAdvanceReturn', OLD."id"); RETURN OLD; END IF;
  PERFORM bank_tx_attach('GuideAdvanceReturn', NEW."id", 'IN', 'USE', round(NEW."amount" * 100)::int, NEW."txRef", NULL, true, NEW."date");
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER bank_tx_guide_advance_return AFTER INSERT OR UPDATE OF "txRef", "amount" OR DELETE ON "GuideAdvanceReturn"
  FOR EACH ROW EXECUTE FUNCTION bank_tx_guide_advance_return();

CREATE FUNCTION bank_tx_guide_advance_refund() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN PERFORM bank_tx_detach('GuideAdvanceRefund', OLD."id"); RETURN OLD; END IF;
  PERFORM bank_tx_attach('GuideAdvanceRefund', NEW."id", 'OUT', 'USE', NEW."amountSatang", NEW."bankRef", NULL,
                         NEW."status" <> 'VOIDED' AND NEW."voidedAt" IS NULL, to_char(NEW."paidAt", 'YYYY-MM-DD'));
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER bank_tx_guide_advance_refund AFTER INSERT OR UPDATE OF "bankRef", "amountSatang", "status", "voidedAt" OR DELETE ON "GuideAdvanceRefund"
  FOR EACH ROW EXECUTE FUNCTION bank_tx_guide_advance_refund();

-- A guide payment made in one transfer carries its reference itself; one made in several keeps
-- the references on its GuidePaymentTransfer rows (lib/payments-v2), and its own is empty.
CREATE FUNCTION bank_tx_guide_payment() RETURNS trigger AS $$
DECLARE t record;
BEGIN
  IF TG_OP = 'DELETE' THEN PERFORM bank_tx_detach('GuidePayment', OLD."id"); RETURN OLD; END IF;
  PERFORM bank_tx_attach('GuidePayment', NEW."id", 'OUT', 'USE', round(NEW."amountTransferred" * 100)::int, NEW."bankRef", NULL,
                         NEW."reversedAt" IS NULL, NEW."paymentDate", NEW."transferGroup");
  -- A reversed payment's transfers stop counting with it (and count again if it ever is not).
  IF TG_OP = 'UPDATE' AND NEW."reversedAt" IS DISTINCT FROM OLD."reversedAt" THEN
    FOR t IN SELECT * FROM "GuidePaymentTransfer" WHERE "paymentId" = NEW."id" ORDER BY "seq" LOOP
      PERFORM bank_tx_attach('GuidePaymentTransfer', t."id", 'OUT', 'USE', round(t."amount" * 100)::int, t."bankRef", NULL,
                             NEW."reversedAt" IS NULL, t."transferDate");
    END LOOP;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER bank_tx_guide_payment AFTER INSERT OR UPDATE OF "bankRef", "amountTransferred", "reversedAt", "transferGroup" OR DELETE ON "GuidePayment"
  FOR EACH ROW EXECUTE FUNCTION bank_tx_guide_payment();

CREATE FUNCTION bank_tx_guide_payment_transfer() RETURNS trigger AS $$
DECLARE reversed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN PERFORM bank_tx_detach('GuidePaymentTransfer', OLD."id"); RETURN OLD; END IF;
  SELECT "reversedAt" IS NOT NULL INTO reversed FROM "GuidePayment" WHERE "id" = NEW."paymentId";
  PERFORM bank_tx_attach('GuidePaymentTransfer', NEW."id", 'OUT', 'USE', round(NEW."amount" * 100)::int, NEW."bankRef", NULL,
                         NOT coalesce(reversed, false), NEW."transferDate");
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER bank_tx_guide_payment_transfer AFTER INSERT OR UPDATE OF "bankRef", "amount" OR DELETE ON "GuidePaymentTransfer"
  FOR EACH ROW EXECUTE FUNCTION bank_tx_guide_payment_transfer();

-- The PEAK payment document describes the payment's transfer; it applies no money itself.
CREATE FUNCTION bank_tx_guide_payment_document() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN PERFORM bank_tx_detach('GuidePaymentDocument', OLD."id"); RETURN OLD; END IF;
  PERFORM bank_tx_attach('GuidePaymentDocument', NEW."id", 'OUT', 'DOC', NULL, NEW."bankRef", NEW."bankAccountKey",
                         NEW."status" <> 'VOIDED', NEW."paymentDate");
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER bank_tx_guide_payment_document AFTER INSERT OR UPDATE OF "bankRef", "bankAccountKey", "status" OR DELETE ON "GuidePaymentDocument"
  FOR EACH ROW EXECUTE FUNCTION bank_tx_guide_payment_document();

-- A guest's bank transfer for an upsell (cash never reaches here).
CREATE FUNCTION bank_tx_upsell_payment() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN PERFORM bank_tx_detach('UpsellPayment', OLD."id"); RETURN OLD; END IF;
  IF NEW."method" <> 'BANK_TRANSFER' THEN RETURN NEW; END IF;
  PERFORM bank_tx_attach('UpsellPayment', NEW."id", 'IN', 'USE', NEW."amountSatang", NEW."bankRef", NEW."bankAccountKey",
                         NEW."status" IN ('PENDING', 'CONFIRMED'), to_char(NEW."createdAt", 'YYYY-MM-DD'));
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER bank_tx_upsell_payment AFTER INSERT OR UPDATE OF "bankRef", "bankAccountKey", "amountSatang", "status" OR DELETE ON "UpsellPayment"
  FOR EACH ROW EXECUTE FUNCTION bank_tx_upsell_payment();

-- ─── Backfill: the transfers already recorded, oldest first ────────────────────────────────
-- The first USE of a transfer sets its amount, so history decides, not the order of tables.
-- Any row that breaks a rule raises here: the whole migration stops and nothing is written.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT * FROM (
      SELECT 'GuideAdvance' tbl, "id", 'OUT' dir, 'USE' role, "amountSatang" amt, "txRef" ref, NULL::text acct, "reversedAt" IS NULL live, "advanceDate" d, "createdAt" at, NULL::text grp FROM "GuideAdvance"
      UNION ALL SELECT 'GuideAdvanceReceipt', "id", 'IN', 'USE', "amountSatang", "bankRef", NULL, "status" IN ('CLAIMED', 'VERIFIED') AND "voidedAt" IS NULL, "receivedDate", "createdAt", NULL FROM "GuideAdvanceReceipt"
      UNION ALL SELECT 'GuideAdvanceReturn', "id", 'IN', 'USE', round("amount" * 100)::int, "txRef", NULL, true, "date", "createdAt", NULL FROM "GuideAdvanceReturn"
      UNION ALL SELECT 'GuideAdvanceRefund', "id", 'OUT', 'USE', "amountSatang", "bankRef", NULL, "status" <> 'VOIDED' AND "voidedAt" IS NULL, to_char("paidAt", 'YYYY-MM-DD'), "createdAt", NULL FROM "GuideAdvanceRefund"
      UNION ALL SELECT 'GuidePayment', "id", 'OUT', 'USE', round("amountTransferred" * 100)::int, "bankRef", NULL, "reversedAt" IS NULL, "paymentDate", "createdAt", "transferGroup" FROM "GuidePayment"
      UNION ALL SELECT 'GuidePaymentTransfer', t."id", 'OUT', 'USE', round(t."amount" * 100)::int, t."bankRef", NULL, p."reversedAt" IS NULL, t."transferDate", t."createdAt", NULL
                  FROM "GuidePaymentTransfer" t JOIN "GuidePayment" p ON p."id" = t."paymentId"
      UNION ALL SELECT 'GuidePaymentDocument', "id", 'OUT', 'DOC', NULL, "bankRef", "bankAccountKey", "status" <> 'VOIDED', "paymentDate", "createdAt", NULL FROM "GuidePaymentDocument"
      UNION ALL SELECT 'UpsellPayment', "id", 'IN', 'USE', "amountSatang", "bankRef", "bankAccountKey", "status" IN ('PENDING', 'CONFIRMED'), to_char("createdAt", 'YYYY-MM-DD'), "createdAt", NULL
                  FROM "UpsellPayment" WHERE "method" = 'BANK_TRANSFER'
    ) x
    WHERE folk_tx_ref_key(ref) IS NOT NULL
    ORDER BY at, tbl, id
  LOOP
    PERFORM bank_tx_attach(r.tbl, r.id, r.dir, r.role, r.amt, r.ref, r.acct, r.live, r.d, r.grp);
  END LOOP;
END $$;
