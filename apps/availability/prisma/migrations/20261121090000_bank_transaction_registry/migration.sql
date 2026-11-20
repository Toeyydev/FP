-- Bank transactions (PR4-0, owner 19 Nov 2026; plan v15 §00-C "T"; Codex review 20 Nov 2026).
--
-- One real bank transfer = one "BankTransaction". Every table that records a transfer is linked
-- to it by triggers, as a USE (money applied) or a DOC (a document describing the same transfer —
-- counts nothing):
--
--   OUT  GuideAdvance (USE) · GuideAdvanceRefund (USE) · GuidePayment (USE)
--        GuidePaymentTransfer (USE) · GuidePaymentDocument (DOC)
--   IN   GuideAdvanceReceipt (USE) · GuideAdvanceReturn (USE) · UpsellPayment, bank transfer (USE)
--
-- The rules:
--   • Key: direction + Folkpaths' account + folk_tx_ref_key(reference) (P0). A reference with no
--     account matches one with an account (same direction); two accounts and none given = refused
--     (BANK_TX_AMBIGUOUS), never guessed.
--   • The AMOUNT is fixed once, from evidence, with its provenance (amountSource):
--       FIRST_USE   the first verified USE (a payment, an advance, a verified receipt …)
--       CLAIM       the first USE was only claimed (an unverified receipt / upsell transfer)
--       GROUP_TOTAL GuidePayment.transferTotal — what ONE transfer for jobs + reviews moved in
--                   all (lib/payments-v2 splitTransfer). Never the sum of the parts.
--       HISTORICAL_GROUP_SUM  only in this migration's backfill, for groups recorded before
--                   transferTotal existed (flagged for review unless exactly jobs + reviews)
--       CORRECTED   an Admin correction, with its AuditLog row in the same transaction
--       TRANSFER_ROW  "Add the missing transfer…" (#323): a payment recorded as one transfer
--                   turned out to be several; the amount narrows to its transfer row's slip
--                   amount (never grows), and the payment's own share counts nothing
--     Adding allocations never raises it.
--   • History is never repaired automatically: the backfill stops on any double use and names it.
--   • What a transfer pays never exceeds it (BANK_TX_OVERUSED). Counted: every LIVE use, and every
--     DEAD VERIFIED use — reversing or voiding a record does not undo the bank movement. A dead use
--     counts nothing only if the money was never seen (a rejected claim). A dead verified use's
--     share can be handed on ONLY to the one record a BankTransactionRelease names, and only up to
--     what that record applies: an unrelated payment can never re-spend it.
--   • A link never moves. A record that comes to name another reference leaves its old link dead
--     (and, if verified, still counted); one live link per record.
--   • A reference with no digit at all is kept exactly as typed, PENDING_VERIFICATION and
--     NEEDS_REVIEW, and never matched (owner Q-T2: no made-up numbers, no digit-count rule).
--
-- Guards. Every INSERT/UPDATE of the registry tables is checked against the SOURCE rows by
-- BEFORE triggers — no session flag is trusted: a link must say exactly what its source row says,
-- an amount must match its evidence, a correction or reallocation must have an AuditLog row
-- written in the same transaction by an ACTIVE ADMIN user. Nothing is ever deleted.
-- LIMIT: this guards the application role against accidental or direct SQL writes to the
-- registry and its sources. It is NOT a defence against a role that can ALTER/DROP these
-- triggers or functions, disable triggers (session_replication_role), or forge an AuditLog row
-- for an active Admin; the Admin service path (lib/bank-transactions) is what checks who acts.
--
-- No existing row is changed. GuidePayment gains a nullable column; the backfill only adds
-- registry rows, and STOPS the whole migration on a real double use.

ALTER TABLE "GuidePayment" ADD COLUMN "transferTotal" DECIMAL(12,2);
-- Who rejected an ADV return claim, and when (the reason was already kept): a rejection releases
-- the claim's hold on its bank reference, so it is an attributed, audited act.
ALTER TABLE "GuideAdvanceReceipt" ADD COLUMN "rejectedById" TEXT, ADD COLUMN "rejectedAt" TIMESTAMP(3);
-- The company account a return reached, in the registry's identity, when it is known (set by the
-- application from configuration — never derived from a label). Null = unknown, as before.
ALTER TABLE "GuideAdvanceReceipt" ADD COLUMN "bankAccountKey" TEXT;
ALTER TABLE "GuideAdvance" ADD COLUMN "bankAccountKey" TEXT;
ALTER TABLE "GuidePayment" ADD CONSTRAINT "GuidePayment_transfer_total_check"
  CHECK ("transferTotal" IS NULL OR ("transferGroup" IS NOT NULL AND "transferTotal" > 0 AND "amountTransferred" <= "transferTotal"));

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
    "amountSource" TEXT,
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
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankTransactionUse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankTransactionRelease" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "fromUseId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetTable" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "auditLogId" TEXT,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankTransactionRelease_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_internalCode_key" ON "BankTransaction"("internalCode");
CREATE INDEX "BankTransaction_direction_refKey_idx" ON "BankTransaction"("direction", "refKey");
CREATE INDEX "BankTransaction_reviewStatus_idx" ON "BankTransaction"("reviewStatus");
CREATE INDEX "BankTransactionUse_transactionId_idx" ON "BankTransactionUse"("transactionId");
CREATE UNIQUE INDEX "BankTransactionUse_sourceTable_sourceId_transactionId_key" ON "BankTransactionUse"("sourceTable", "sourceId", "transactionId");
-- One live link per record: a record names one transfer at a time.
CREATE UNIQUE INDEX "BankTransactionUse_live_source_key" ON "BankTransactionUse"("sourceTable", "sourceId") WHERE "live";
CREATE UNIQUE INDEX "BankTransactionRelease_fromUseId_key" ON "BankTransactionRelease"("fromUseId");
CREATE INDEX "BankTransactionRelease_transactionId_idx" ON "BankTransactionRelease"("transactionId");

-- AddForeignKey
ALTER TABLE "BankTransactionUse" ADD CONSTRAINT "BankTransactionUse_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "BankTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BankTransactionRelease" ADD CONSTRAINT "BankTransactionRelease_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "BankTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BankTransactionRelease" ADD CONSTRAINT "BankTransactionRelease_fromUseId_fkey" FOREIGN KEY ("fromUseId") REFERENCES "BankTransactionUse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Checks ────────────────────────────────────────────────────────────────────────────────

ALTER TABLE "BankTransaction"
  ADD CONSTRAINT "BankTransaction_direction_check" CHECK ("direction" IN ('IN', 'OUT')),
  ADD CONSTRAINT "BankTransaction_ref_status_check" CHECK ("refStatus" IN ('BANK_REF', 'PENDING_VERIFICATION', 'INTERNAL')),
  ADD CONSTRAINT "BankTransaction_ref_shape_check" CHECK (
       ("refStatus" = 'BANK_REF' AND "refKey" IS NOT NULL AND "refRaw" IS NOT NULL)
    OR ("refStatus" = 'PENDING_VERIFICATION' AND "refKey" IS NULL AND "refRaw" IS NOT NULL)
    OR ("refStatus" = 'INTERNAL' AND "refKey" IS NULL AND "internalCode" IS NOT NULL)),
  ADD CONSTRAINT "BankTransaction_amount_check" CHECK ("amountSatang" IS NULL OR "amountSatang" > 0),
  ADD CONSTRAINT "BankTransaction_amount_source_check" CHECK (
    ("amountSatang" IS NULL) = ("amountSource" IS NULL)
    AND ("amountSource" IS NULL OR "amountSource" IN ('FIRST_USE', 'CLAIM', 'GROUP_TOTAL', 'HISTORICAL_GROUP_SUM', 'CORRECTED', 'TRANSFER_ROW'))
    AND (("amountSource" IN ('GROUP_TOTAL', 'HISTORICAL_GROUP_SUM')) = ("amountGroup" IS NOT NULL) OR "amountSource" = 'CORRECTED')),
  ADD CONSTRAINT "BankTransaction_review_check" CHECK ("reviewStatus" IN ('OK', 'NEEDS_REVIEW'));

ALTER TABLE "BankTransactionUse"
  ADD CONSTRAINT "BankTransactionUse_role_check" CHECK ("role" IN ('USE', 'DOC')),
  ADD CONSTRAINT "BankTransactionUse_amount_check" CHECK (("role" = 'USE') = ("amountSatang" IS NOT NULL) AND ("amountSatang" IS NULL OR "amountSatang" > 0));

ALTER TABLE "BankTransactionRelease"
  ADD CONSTRAINT "BankTransactionRelease_kind_check" CHECK ("kind" IN ('MOVED_TO_TRANSFERS', 'REALLOCATION')),
  ADD CONSTRAINT "BankTransactionRelease_reason_check" CHECK (length(btrim("reason")) >= 5),
  ADD CONSTRAINT "BankTransactionRelease_audit_check" CHECK (("kind" = 'REALLOCATION') = ("auditLogId" IS NOT NULL));

-- The registry is never pruned, and a release is never changed.
CREATE FUNCTION bank_tx_never_deleted() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'BANK_TX_KEPT: % rows are never deleted — a bank movement happened; mark a use not live instead', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER bank_tx_never_deleted BEFORE DELETE ON "BankTransaction" FOR EACH ROW EXECUTE FUNCTION bank_tx_never_deleted();
CREATE TRIGGER bank_tx_use_never_deleted BEFORE DELETE ON "BankTransactionUse" FOR EACH ROW EXECUTE FUNCTION bank_tx_never_deleted();
CREATE TRIGGER bank_tx_release_never_deleted BEFORE DELETE ON "BankTransactionRelease" FOR EACH ROW EXECUTE FUNCTION bank_tx_never_deleted();

CREATE FUNCTION bank_tx_release_frozen() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'BANK_TX_GUARD: a release is never changed — it is the lineage of the money';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER bank_tx_release_frozen BEFORE UPDATE ON "BankTransactionRelease" FOR EACH ROW EXECUTE FUNCTION bank_tx_release_frozen();

-- ─── What each source row says ─────────────────────────────────────────────────────────────

-- NULL while this migration's backfill runs; the moment it finished afterwards (replaced at the
-- end of this file). HISTORICAL_* provenance is accepted only while it is NULL.
CREATE FUNCTION bank_tx_installed_at() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT NULL::timestamptz $$;

-- The one place that says what a source row records. verified = the money was seen, not only
-- claimed; it never goes back to false for a row (verifiedAt / paidAt / confirmedAt are kept).
CREATE FUNCTION bank_tx_expected(p_table text, p_id text)
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
  ELSE
    RAISE EXCEPTION 'BANK_TX_GUARD: % is not a table that records bank transfers', p_table;
  END CASE;
END $$ LANGUAGE plpgsql STABLE;

-- Does the source row, as it stands, name this transaction?
CREATE FUNCTION bank_tx_names(p_tx text, p_table text, p_id text) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM bank_tx_expected(p_table, p_id) e JOIN "BankTransaction" t ON t."id" = p_tx
     WHERE folk_tx_ref_key(e.ref) IS NOT NULL AND t."direction" = e.dir
       AND (   (t."refStatus" = 'BANK_REF' AND folk_tx_ref_key(e.ref) ~ '[0-9]' AND t."refKey" = folk_tx_ref_key(e.ref)
                AND (e.account IS NULL OR t."accountKey" IS NULL OR t."accountKey" = e.account))
            OR (t."refStatus" = 'PENDING_VERIFICATION' AND folk_tx_ref_key(e.ref) !~ '[0-9]' AND t."refRaw" = e.ref)))
$$ LANGUAGE sql STABLE;

-- What a transaction pays: live uses in full; dead verified uses in full, less what the ONE record
-- their release names applies; dead unverified uses (rejected claims) nothing.
CREATE FUNCTION bank_tx_applied(p_tx text) RETURNS bigint AS $$
  SELECT COALESCE(sum(CASE
      WHEN u."live" THEN u."amountSatang"
      WHEN u."verified" AND EXISTS (
        SELECT 1 FROM "BankTransactionRelease" r
          JOIN "BankTransactionUse" t ON t."transactionId" = u."transactionId" AND t."sourceTable" = r."targetTable"
                                     AND t."sourceId" = r."targetId" AND t."role" = 'USE' AND (t."live" OR t."verified")
         WHERE r."fromUseId" = u."id" AND r."kind" = 'MOVED_TO_TRANSFERS') THEN 0
      WHEN u."verified" THEN u."amountSatang" - LEAST(u."amountSatang", COALESCE((
        SELECT t."amountSatang" FROM "BankTransactionRelease" r
          JOIN "BankTransactionUse" t ON t."transactionId" = u."transactionId" AND t."sourceTable" = r."targetTable"
                                     AND t."sourceId" = r."targetId" AND t."role" = 'USE' AND (t."live" OR t."verified")
         WHERE r."fromUseId" = u."id"), 0))
      ELSE 0 END), 0)
    FROM "BankTransactionUse" u WHERE u."transactionId" = p_tx AND u."role" = 'USE'
$$ LANGUAGE sql STABLE;

CREATE FUNCTION bank_tx_check(p_tx text) RETURNS void AS $$
DECLARE t record; applied bigint;
BEGIN
  SELECT * INTO t FROM "BankTransaction" WHERE "id" = p_tx;
  IF t."amountSatang" IS NULL THEN RETURN; END IF;
  applied := bank_tx_applied(p_tx);
  IF applied > t."amountSatang" THEN
    RAISE EXCEPTION 'BANK_TX_OVERUSED: transfer …% (% satang) would pay % satang — one transfer cannot pay twice',
      right(coalesce(t."refKey", t."refRaw", ''), 4), t."amountSatang", applied;
  END IF;
END $$ LANGUAGE plpgsql;

-- An AuditLog row written IN THIS TRANSACTION by an ACTIVE ADMIN for this action and transaction.
CREATE FUNCTION bank_tx_admin_audit(p_audit text, p_action text, p_tx text) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM "AuditLog" a JOIN "User" u ON u."id" = a."actorId"
     WHERE (p_audit IS NULL OR a."id" = p_audit) AND a."action" = p_action
       AND a."entityType" = 'BankTransaction' AND a."entityId" = p_tx
       AND a."actorRole" = 'ADMIN' AND u."role"::text = 'ADMIN' AND u."state"::text = 'ACTIVE'
       AND a.xmin::text::bigint = txid_current() % 4294967296)
$$ LANGUAGE sql STABLE;

-- An AuditLog row written IN THIS TRANSACTION, by an ACTIVE user of one of p_roles, as p_actor.
CREATE FUNCTION bank_tx_actor_audit(p_actions text[], p_entity_type text, p_entity text, p_actor text, p_roles text[]) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM "AuditLog" a JOIN "User" u ON u."id" = a."actorId"
     WHERE a."action" = ANY (p_actions) AND a."entityType" = p_entity_type AND a."entityId" = p_entity
       AND a."actorId" = p_actor AND u."role"::text = ANY (p_roles) AND a."actorRole" = u."role"::text AND u."state"::text = 'ACTIVE'
       AND a.xmin::text::bigint = txid_current() % 4294967296)
$$ LANGUAGE sql STABLE;

-- "Add the missing transfer…" (#323), as the Admin action wrote it IN THIS TRANSACTION: the parts
-- add up to the payment, this transfer row is one of them (amount, date, reference), and its
-- reference is the payment's own earlier one — only that reference is narrowed.
CREATE FUNCTION bank_tx_transfers_audit(p_transfer text) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM "GuidePaymentTransfer" t JOIN "GuidePayment" p ON p."id" = t."paymentId"
      JOIN "AuditLog" a ON a."action" = 'payment.transfers_added' AND a."entityType" = 'GuidePayment' AND a."entityId" = p."id"
      JOIN "User" u ON u."id" = a."actorId"
     WHERE t."id" = p_transfer
       AND a."actorRole" = 'ADMIN' AND u."role"::text = 'ADMIN' AND u."state"::text = 'ACTIVE'
       AND a.xmin::text::bigint = txid_current() % 4294967296
       AND folk_tx_ref_key(a."detail"->'before'->>'bankRef') = folk_tx_ref_key(t."bankRef")
       AND (SELECT sum(round((x->>'amount')::numeric * 100)) FROM jsonb_array_elements(a."detail"->'after'->'transfers') x) = round(p."amountTransferred" * 100)
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(a."detail"->'after'->'transfers') x
                    WHERE (x->>'seq')::int = t."seq" AND round((x->>'amount')::numeric * 100) = round(t."amount" * 100)
                      AND x->>'date' = t."transferDate" AND folk_tx_ref_key(x->>'bankRef') IS NOT DISTINCT FROM folk_tx_ref_key(t."bankRef")))
$$ LANGUAGE sql STABLE;

-- ─── Guards: every write must match the sources ────────────────────────────────────────────

CREATE FUNCTION bank_tx_guard_tx() RETURNS trigger AS $$
DECLARE ok boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Born empty: the amount is set afterwards, only from evidence.
    IF NEW."amountSatang" IS NOT NULL OR NEW."amountSource" IS NOT NULL OR NEW."amountGroup" IS NOT NULL THEN
      RAISE EXCEPTION 'BANK_TX_GUARD: a transaction is created without an amount; its first use sets it';
    END IF;
    IF NEW."refStatus" = 'INTERNAL' THEN
      RAISE EXCEPTION 'BANK_TX_GUARD: internal transfers are not recorded yet (PR4-0b Admin path)';
    END IF;
    IF NEW."refStatus" = 'BANK_REF' AND (NEW."refKey" IS DISTINCT FROM folk_tx_ref_key(NEW."refRaw") OR NEW."refKey" !~ '[0-9]') THEN
      RAISE EXCEPTION 'BANK_TX_GUARD: refKey must be folk_tx_ref_key(refRaw) and hold a digit';
    END IF;
    -- Only when no transfer with this reference could be meant already (as bank_tx_sync decides):
    -- a pre-made row cannot claim a reference or an account ahead of the real record.
    IF NEW."refStatus" = 'BANK_REF' AND EXISTS (
         SELECT 1 FROM "BankTransaction" b WHERE b."direction" = NEW."direction" AND b."refStatus" = 'BANK_REF' AND b."refKey" = NEW."refKey"
            AND (NEW."accountKey" IS NULL OR b."accountKey" IS NULL OR b."accountKey" = NEW."accountKey")) THEN
      RAISE EXCEPTION 'BANK_TX_GUARD: a transfer with this reference is already recorded — records link to it, never a second one';
    END IF;
    IF NEW."refStatus" = 'PENDING_VERIFICATION' AND (folk_tx_ref_key(NEW."refRaw") IS NULL OR folk_tx_ref_key(NEW."refRaw") ~ '[0-9]' OR NEW."reviewStatus" <> 'NEEDS_REVIEW') THEN
      RAISE EXCEPTION 'BANK_TX_GUARD: only a reference with no digit waits for verification, and it needs review';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" <> OLD."id" OR NEW."direction" <> OLD."direction" OR NEW."refRaw" IS DISTINCT FROM OLD."refRaw"
     OR NEW."refKey" IS DISTINCT FROM OLD."refKey" OR NEW."refStatus" <> OLD."refStatus"
     OR NEW."internalCode" IS DISTINCT FROM OLD."internalCode" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'BANK_TX_GUARD: a transaction''s identity never changes';
  END IF;
  IF OLD."accountKey" IS NOT NULL AND NEW."accountKey" IS DISTINCT FROM OLD."accountKey" THEN
    RAISE EXCEPTION 'BANK_TX_GUARD: a recorded account never changes';
  END IF;
  IF OLD."transferDate" IS NOT NULL AND NEW."transferDate" IS DISTINCT FROM OLD."transferDate" THEN
    RAISE EXCEPTION 'BANK_TX_GUARD: a recorded transfer date never changes';
  END IF;

  IF NEW."amountSatang" IS DISTINCT FROM OLD."amountSatang" OR NEW."amountSource" IS DISTINCT FROM OLD."amountSource"
     OR NEW."amountGroup" IS DISTINCT FROM OLD."amountGroup" THEN
    IF NEW."amountSatang" IS NULL THEN
      -- Only an amount that came from a claim, with no verified money on the transfer, may be
      -- cleared — to be set again from the next record (the same claim verified, or a new one).
      ok := OLD."amountSource" = 'CLAIM' AND NEW."amountGroup" IS NULL
            AND NOT EXISTS (SELECT 1 FROM "BankTransactionUse" u WHERE u."transactionId" = OLD."id" AND u."role" = 'USE' AND u."verified");
    ELSIF NEW."amountSource" = 'CORRECTED' THEN
      ok := bank_tx_admin_audit(NULL, 'bank_tx.amount_corrected', NEW."id");
    ELSIF NEW."amountSource" = 'TRANSFER_ROW' THEN
      ok := OLD."amountSource" = 'FIRST_USE' AND NEW."amountGroup" IS NULL AND NEW."amountSatang" < OLD."amountSatang" AND EXISTS (
        SELECT 1 FROM "BankTransactionRelease" r
          JOIN "BankTransactionUse" f ON f."id" = r."fromUseId"
          JOIN "BankTransactionUse" t ON t."transactionId" = r."transactionId" AND t."sourceTable" = 'GuidePaymentTransfer' AND t."sourceId" = r."targetId" AND t."live"
         WHERE r."transactionId" = NEW."id" AND r."kind" = 'MOVED_TO_TRANSFERS'
           AND f."amountSatang" = OLD."amountSatang" AND t."amountSatang" = NEW."amountSatang"
           AND bank_tx_transfers_audit(t."sourceId")
           AND EXISTS (SELECT 1 FROM "AuditLog" a WHERE a."action" = 'payment.transfers_added' AND a."entityId" = f."sourceId"
                          AND a.xmin::text::bigint = txid_current() % 4294967296
                          AND a."detail"->'registry'->>'transactionId' = NEW."id"
                          AND (a."detail"->'registry'->>'amountSatang')::int = OLD."amountSatang"
                          AND a."detail"->'registry'->>'amountSource' = OLD."amountSource"));
    ELSIF OLD."amountSatang" IS NOT NULL THEN
      ok := false; -- fixed once: never re-derived, never grown by allocations
    ELSIF NEW."amountSource" IN ('FIRST_USE', 'CLAIM') THEN
      ok := NEW."amountGroup" IS NULL AND EXISTS (
        SELECT 1 FROM "BankTransactionUse" u WHERE u."transactionId" = NEW."id" AND u."role" = 'USE'
           AND (u."live" OR (u."verified" AND NEW."amountSource" = 'FIRST_USE'))
           AND u."groupKey" IS NULL AND u."amountSatang" = NEW."amountSatang" AND u."verified" = (NEW."amountSource" = 'FIRST_USE'));
    ELSIF NEW."amountSource" = 'GROUP_TOTAL' THEN
      ok := EXISTS (
        SELECT 1 FROM "BankTransactionUse" u JOIN "GuidePayment" p ON p."id" = u."sourceId"
         WHERE u."transactionId" = NEW."id" AND u."sourceTable" = 'GuidePayment' AND (u."live" OR u."verified")
           AND u."groupKey" = NEW."amountGroup" AND p."transferGroup" = NEW."amountGroup"
           AND round(p."transferTotal" * 100)::int = NEW."amountSatang");
    ELSIF NEW."amountSource" = 'HISTORICAL_GROUP_SUM' THEN
      ok := bank_tx_installed_at() IS NULL AND NEW."amountSatang" = (
        SELECT sum(round(p."amountTransferred" * 100))::int FROM "GuidePayment" p
         WHERE p."transferGroup" = NEW."amountGroup" AND p."transferTotal" IS NULL AND folk_tx_ref_key(p."bankRef") = NEW."refKey");
    ELSE
      ok := false;
    END IF;
    IF NOT coalesce(ok, false) THEN
      RAISE EXCEPTION 'BANK_TX_GUARD: transfer …% amount % (%) has no evidence — amounts change only from their source or by an audited Admin correction',
        right(coalesce(NEW."refKey", NEW."refRaw", ''), 4), NEW."amountSatang", NEW."amountSource";
    END IF;
  END IF;

  IF OLD."reviewStatus" = 'NEEDS_REVIEW' AND NEW."reviewStatus" = 'OK' AND NOT bank_tx_admin_audit(NULL, 'bank_tx.reviewed', NEW."id") THEN
    RAISE EXCEPTION 'BANK_TX_GUARD: only an Admin''s audited review clears NEEDS_REVIEW';
  END IF;
  IF NEW."reviewNote" IS DISTINCT FROM OLD."reviewNote" AND NEW."reviewStatus" <> 'NEEDS_REVIEW'
     AND NOT bank_tx_admin_audit(NULL, 'bank_tx.reviewed', NEW."id") THEN
    RAISE EXCEPTION 'BANK_TX_GUARD: the review note changes with a review';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER bank_tx_guard_tx BEFORE INSERT OR UPDATE ON "BankTransaction" FOR EACH ROW EXECUTE FUNCTION bank_tx_guard_tx();

-- At commit: a transaction exists only because a record names it — its reference as that record
-- typed it, and its account (if any) that of a linked record.
CREATE FUNCTION bank_tx_born_linked() RETURNS trigger AS $$
DECLARE b record;
BEGIN
  SELECT * INTO b FROM "BankTransaction" WHERE "id" = NEW."id";
  IF NOT EXISTS (SELECT 1 FROM "BankTransactionUse" u, LATERAL bank_tx_expected(u."sourceTable", u."sourceId") e
                  WHERE u."transactionId" = b."id" AND e.ref = b."refRaw") THEN
    RAISE EXCEPTION 'BANK_TX_GUARD: transfer …% has no record that names it — transfers are created only from their records', right(coalesce(b."refKey", b."refRaw", ''), 4);
  END IF;
  IF b."accountKey" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "BankTransactionUse" u, LATERAL bank_tx_expected(u."sourceTable", u."sourceId") e
                  WHERE u."transactionId" = b."id" AND e.account = b."accountKey") THEN
    RAISE EXCEPTION 'BANK_TX_GUARD: transfer …% names an account no record of it names', right(coalesce(b."refKey", b."refRaw", ''), 4);
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER bank_tx_born_linked AFTER INSERT ON "BankTransaction" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION bank_tx_born_linked();

CREATE FUNCTION bank_tx_after_tx() RETURNS trigger AS $$
BEGIN
  PERFORM bank_tx_check(NEW."id");
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER bank_tx_after_tx AFTER UPDATE OF "amountSatang" ON "BankTransaction" FOR EACH ROW EXECUTE FUNCTION bank_tx_after_tx();

CREATE FUNCTION bank_tx_guard_use() RETURNS trigger AS $$
DECLARE e record; names boolean;
BEGIN
  SELECT * INTO e FROM bank_tx_expected(NEW."sourceTable", NEW."sourceId");
  names := e.dir IS NOT NULL AND bank_tx_names(NEW."transactionId", NEW."sourceTable", NEW."sourceId");
  IF TG_OP = 'INSERT' THEN
    IF NOT names OR NEW."role" <> e.role OR NEW."live" <> e.live OR NEW."verified" <> e.verified
       OR NEW."amountSatang" IS DISTINCT FROM e.amount OR NEW."groupKey" IS DISTINCT FROM e.grp THEN
      RAISE EXCEPTION 'BANK_TX_GUARD: a link must say what % % says', NEW."sourceTable", NEW."sourceId";
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."transactionId" <> OLD."transactionId" OR NEW."sourceTable" <> OLD."sourceTable"
     OR NEW."sourceId" <> OLD."sourceId" OR NEW."role" <> OLD."role" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'BANK_TX_GUARD: a link never moves — a record naming another transfer gets a new link';
  END IF;
  IF OLD."verified" AND NOT NEW."verified" THEN
    RAISE EXCEPTION 'BANK_TX_GUARD: money that was seen stays seen';
  END IF;
  IF names THEN
    IF NEW."live" <> e.live OR NEW."verified" <> (OLD."verified" OR e.verified)
       OR (NEW."live" AND (NEW."amountSatang" IS DISTINCT FROM e.amount OR NEW."groupKey" IS DISTINCT FROM e.grp))
       OR (NOT NEW."live" AND (NEW."amountSatang" IS DISTINCT FROM OLD."amountSatang" OR NEW."groupKey" IS DISTINCT FROM OLD."groupKey")) THEN
      RAISE EXCEPTION 'BANK_TX_GUARD: a link must say what % % says', NEW."sourceTable", NEW."sourceId";
    END IF;
  ELSIF NEW."live" OR NEW."verified" <> OLD."verified" OR NEW."amountSatang" IS DISTINCT FROM OLD."amountSatang"
        OR NEW."groupKey" IS DISTINCT FROM OLD."groupKey" THEN
    RAISE EXCEPTION 'BANK_TX_GUARD: % % no longer names this transfer; its link can only be dead', NEW."sourceTable", NEW."sourceId";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER bank_tx_guard_use BEFORE INSERT OR UPDATE ON "BankTransactionUse" FOR EACH ROW EXECUTE FUNCTION bank_tx_guard_use();

CREATE FUNCTION bank_tx_after_use() RETURNS trigger AS $$
BEGIN
  PERFORM bank_tx_check(NEW."transactionId");
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER bank_tx_after_use AFTER INSERT OR UPDATE ON "BankTransactionUse" FOR EACH ROW EXECUTE FUNCTION bank_tx_after_use();

CREATE FUNCTION bank_tx_guard_release() RETURNS trigger AS $$
DECLARE u record; p record; ok boolean; target_exists boolean;
BEGIN
  SELECT * INTO u FROM "BankTransactionUse" WHERE "id" = NEW."fromUseId";
  IF u."id" IS NULL OR u."transactionId" <> NEW."transactionId" OR u."role" <> 'USE' OR u."live" OR NOT u."verified" THEN
    RAISE EXCEPTION 'BANK_TX_GUARD: only a dead, verified use of this transfer can hand its share on';
  END IF;
  IF NEW."targetTable" = u."sourceTable" AND NEW."targetId" = u."sourceId" THEN
    RAISE EXCEPTION 'BANK_TX_GUARD: a record cannot release its share to itself';
  END IF;
  SELECT count(*) > 0 INTO target_exists FROM bank_tx_expected(NEW."targetTable", NEW."targetId");
  IF target_exists AND NOT bank_tx_names(NEW."transactionId", NEW."targetTable", NEW."targetId") THEN
    RAISE EXCEPTION 'BANK_TX_GUARD: the release target does not record this transfer';
  END IF;
  CASE NEW."kind"
  WHEN 'MOVED_TO_TRANSFERS' THEN
    -- "Add the missing transfer…" (#323): a payment's reference moved onto its own transfer rows.
    SELECT g.* INTO p FROM "GuidePaymentTransfer" t JOIN "GuidePayment" g ON g."id" = t."paymentId" WHERE t."id" = NEW."targetId";
    ok := u."sourceTable" = 'GuidePayment' AND NEW."targetTable" = 'GuidePaymentTransfer' AND target_exists
          AND p."id" = u."sourceId" AND p."status" = 'RECORDED' AND p."reversedAt" IS NULL AND p."bankRef" IS NULL
          AND bank_tx_transfers_audit(NEW."targetId");
  WHEN 'REALLOCATION' THEN
    ok := EXISTS (SELECT 1 FROM "AuditLog" a WHERE a."id" = NEW."auditLogId"
                     AND a."detail"->>'fromUseId' = NEW."fromUseId" AND a."detail"->>'targetTable' = NEW."targetTable"
                     AND a."detail"->>'targetId' = NEW."targetId")
          AND bank_tx_admin_audit(NEW."auditLogId", 'bank_tx.reallocated', NEW."transactionId");
  ELSE ok := false;
  END CASE;
  IF NOT coalesce(ok, false) THEN
    RAISE EXCEPTION 'BANK_TX_GUARD: a % release is not allowed here — money that moved once is re-applied only to the record an Admin names', NEW."kind";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER bank_tx_guard_release BEFORE INSERT ON "BankTransactionRelease" FOR EACH ROW EXECUTE FUNCTION bank_tx_guard_release();

-- ─── The link, kept by the source triggers ─────────────────────────────────────────────────

CREATE FUNCTION bank_tx_new_id(prefix text) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT prefix || substr(md5(random()::text || clock_timestamp()::text || txid_current()::text), 1, 22)
$$;

-- Bring the registry in line with one source row as it now stands.
CREATE FUNCTION bank_tx_sync(p_table text, p_id text) RETURNS void AS $$
DECLARE
  e record; k text; status text; tx_id text; n int; u record; t record; pu_id text; pu_amount int;
  use_id text;
BEGIN
  SELECT * INTO e FROM bank_tx_expected(p_table, p_id);
  k := folk_tx_ref_key(e.ref);

  -- A link the row no longer names stays, dead (and, if the money was seen, still counted).
  FOR u IN SELECT * FROM "BankTransactionUse" WHERE "sourceTable" = p_table AND "sourceId" = p_id AND "live" LOOP
    IF e.dir IS NULL OR k IS NULL OR NOT bank_tx_names(u."transactionId", p_table, p_id) THEN
      UPDATE "BankTransactionUse" SET "live" = false, "updatedAt" = now() WHERE "id" = u."id";
    END IF;
  END LOOP;
  IF e.dir IS NULL OR k IS NULL THEN RETURN; END IF;

  status := CASE WHEN k ~ '[0-9]' THEN 'BANK_REF' ELSE 'PENDING_VERIFICATION' END;
  IF status = 'BANK_REF' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('bank-tx:' || e.dir || ':' || k, 0));
    SELECT count(*) INTO n FROM "BankTransaction"
     WHERE "direction" = e.dir AND "refKey" = k AND "refStatus" = 'BANK_REF'
       AND (e.account IS NULL OR "accountKey" IS NULL OR "accountKey" = e.account);
    IF n = 1 THEN
      SELECT "id" INTO tx_id FROM "BankTransaction"
       WHERE "direction" = e.dir AND "refKey" = k AND "refStatus" = 'BANK_REF'
         AND (e.account IS NULL OR "accountKey" IS NULL OR "accountKey" = e.account) FOR UPDATE;
    ELSIF n > 1 THEN
      SELECT "id" INTO tx_id FROM "BankTransaction"
       WHERE "direction" = e.dir AND "refKey" = k AND "refStatus" = 'BANK_REF' AND "accountKey" = e.account FOR UPDATE;
      IF tx_id IS NULL THEN
        RAISE EXCEPTION 'BANK_TX_AMBIGUOUS: % % reference …% matches % transfers on different accounts; record the account', p_table, p_id, right(k, 4), n;
      END IF;
    END IF;
  ELSE
    -- Not checkable as a bank reference: never matched to others; the same row keeps its own.
    SELECT x."transactionId" INTO tx_id FROM "BankTransactionUse" x JOIN "BankTransaction" b ON b."id" = x."transactionId"
     WHERE x."sourceTable" = p_table AND x."sourceId" = p_id AND b."refStatus" = 'PENDING_VERIFICATION' AND b."refRaw" = e.ref LIMIT 1;
  END IF;

  IF tx_id IS NULL THEN
    tx_id := bank_tx_new_id('btx');
    INSERT INTO "BankTransaction" ("id", "direction", "accountKey", "refRaw", "refKey", "refStatus", "transferDate", "reviewStatus", "reviewNote")
    VALUES (tx_id, e.dir, e.account, e.ref, CASE WHEN status = 'BANK_REF' THEN k END, status, e.d,
            CASE WHEN status = 'BANK_REF' THEN 'OK' ELSE 'NEEDS_REVIEW' END,
            CASE WHEN status = 'BANK_REF' THEN NULL ELSE 'The reference has no digits — check the slip; it cannot be matched as a bank reference until corrected.' END);
  ELSE
    UPDATE "BankTransaction" SET "accountKey" = COALESCE("accountKey", e.account), "transferDate" = COALESCE("transferDate", e.d), "updatedAt" = now()
     WHERE "id" = tx_id AND (("accountKey" IS NULL AND e.account IS NOT NULL) OR ("transferDate" IS NULL AND e.d IS NOT NULL));
  END IF;
  SELECT * INTO t FROM "BankTransaction" WHERE "id" = tx_id;

  IF e.role = 'USE' AND e.live THEN
    -- A grouped payment made after this registry carries the one transfer's total.
    -- (A record already linked by the backfill is history, re-synced; anything else is new.)
    IF e.grp IS NOT NULL AND e.grp_total IS NULL AND bank_tx_installed_at() IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "BankTransactionUse" x WHERE x."sourceTable" = p_table AND x."sourceId" = p_id AND x."transactionId" = tx_id) THEN
      RAISE EXCEPTION 'BANK_TX_GROUP_TOTAL_MISSING: % % is part of transfer group % but does not say what the transfer moved in all', p_table, p_id, e.grp;
    END IF;
    IF e.grp IS NOT NULL AND e.grp_total IS NOT NULL AND t."amountGroup" = e.grp AND t."amountSatang" <> e.grp_total THEN
      RAISE EXCEPTION 'BANK_TX_GROUP_TOTAL_MISMATCH: % % says its transfer moved % satang; the transfer is % satang', p_table, p_id, e.grp_total, t."amountSatang";
    END IF;

    -- "Add the missing transfer…" (#323): the payment's own share goes to its transfer row.
    IF p_table = 'GuidePaymentTransfer' THEN
      SELECT x."id", x."amountSatang" INTO pu_id, pu_amount FROM "BankTransactionUse" x JOIN "GuidePayment" g ON g."id" = x."sourceId"
       WHERE x."transactionId" = tx_id AND x."sourceTable" = 'GuidePayment' AND x."sourceId" = e.parent_id
         AND NOT x."live" AND x."verified" AND g."status" = 'RECORDED' AND g."reversedAt" IS NULL AND g."bankRef" IS NULL
         AND NOT EXISTS (SELECT 1 FROM "BankTransactionRelease" r WHERE r."fromUseId" = x."id")
         AND bank_tx_transfers_audit(p_id);
      -- Without that audited action there is no release: the payment keeps its share, and the
      -- row is refused as a second use of the transfer.
      IF pu_id IS NOT NULL THEN
        INSERT INTO "BankTransactionRelease" ("id", "transactionId", "fromUseId", "kind", "targetTable", "targetId", "reason")
        VALUES (bank_tx_new_id('btr'), tx_id, pu_id, 'MOVED_TO_TRANSFERS', p_table, p_id,
                'The payment''s reference moved to its own transfer rows (Add the missing transfer…)');
      END IF;
    END IF;

  END IF;

  IF e.role = 'USE' AND e.live AND t."amountSource" = 'CLAIM'
     AND NOT EXISTS (SELECT 1 FROM "BankTransactionUse" x WHERE x."transactionId" = tx_id AND x."role" = 'USE' AND x."verified") THEN
    UPDATE "BankTransaction" SET "amountSatang" = NULL, "amountSource" = NULL, "updatedAt" = now() WHERE "id" = tx_id;
    t."amountSatang" := NULL;
  END IF;

  SELECT "id" INTO use_id FROM "BankTransactionUse" WHERE "sourceTable" = p_table AND "sourceId" = p_id AND "transactionId" = tx_id FOR UPDATE;
  IF use_id IS NULL THEN
    INSERT INTO "BankTransactionUse" ("id", "transactionId", "sourceTable", "sourceId", "role", "amountSatang", "groupKey", "live", "verified")
    VALUES (bank_tx_new_id('btu'), tx_id, p_table, p_id, e.role, e.amount, e.grp, e.live, e.verified);
  ELSIF e.live THEN
    UPDATE "BankTransactionUse" SET "live" = true, "amountSatang" = e.amount, "groupKey" = e.grp, "verified" = "verified" OR e.verified, "updatedAt" = now()
     WHERE "id" = use_id;
  ELSE
    UPDATE "BankTransactionUse" SET "live" = false, "verified" = "verified" OR e.verified, "updatedAt" = now() WHERE "id" = use_id;
  END IF;

  -- The amount, fixed once from evidence: the first record that applies money (or, in history,
  -- the first that did and was later reversed — the movement happened).
  IF e.role = 'USE' AND (e.live OR e.verified) THEN
    IF t."amountSatang" IS NULL THEN
      IF e.grp IS NOT NULL AND e.grp_total IS NOT NULL THEN
        UPDATE "BankTransaction" SET "amountSatang" = e.grp_total, "amountSource" = 'GROUP_TOTAL', "amountGroup" = e.grp, "updatedAt" = now() WHERE "id" = tx_id;
      ELSIF e.grp IS NOT NULL AND bank_tx_installed_at() IS NULL THEN
        UPDATE "BankTransaction" SET "amountSource" = 'HISTORICAL_GROUP_SUM', "amountGroup" = e.grp, "updatedAt" = now(),
               "amountSatang" = (SELECT sum(round(p."amountTransferred" * 100))::int FROM "GuidePayment" p
                                  WHERE p."transferGroup" = e.grp AND p."transferTotal" IS NULL AND folk_tx_ref_key(p."bankRef") = k)
         WHERE "id" = tx_id;
      ELSIF e.grp IS NOT NULL THEN
        RAISE EXCEPTION 'BANK_TX_GROUP_TOTAL_MISSING: % % is part of transfer group % but does not say what the transfer moved in all', p_table, p_id, e.grp;
      ELSE
        UPDATE "BankTransaction" SET "amountSatang" = e.amount, "amountSource" = CASE WHEN e.verified THEN 'FIRST_USE' ELSE 'CLAIM' END, "updatedAt" = now()
         WHERE "id" = tx_id;
      END IF;
    ELSIF pu_id IS NOT NULL AND e.live AND t."amountSource" = 'FIRST_USE' AND t."amountSatang" = pu_amount AND e.amount < t."amountSatang" THEN
      -- #323: the transfer this reference names is the one on transfer row 1, at its slip amount.
      UPDATE "BankTransaction" SET "amountSatang" = e.amount, "amountSource" = 'TRANSFER_ROW', "updatedAt" = now() WHERE "id" = tx_id;
    END IF;
  END IF;
END $$ LANGUAGE plpgsql;

-- ─── Claims: a reservation is released only by an audited rejection or void ────────────────
-- An unverified claim (a guide's ADV return, a guest's upsell transfer) holds its transfer while
-- live. Ending it unverified frees it — so that is allowed only through the application's
-- action: the actor and reason on the row, and that action's AuditLog row by the same active
-- staff member IN THIS TRANSACTION. A claimed row is never deleted.
CREATE FUNCTION bank_tx_claim_guard() RETURNS trigger AS $$
DECLARE actor text; act text; why text; open_claim boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "BankTransactionUse" u WHERE u."sourceTable" = TG_TABLE_NAME AND u."sourceId" = OLD."id" AND u."live" AND NOT u."verified") THEN
      RAISE EXCEPTION 'BANK_TX_GUARD: a claimed transfer is rejected or voided, never deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME = 'GuideAdvanceReceipt' THEN
    open_claim := OLD."status" = 'CLAIMED' AND OLD."voidedAt" IS NULL AND OLD."verifiedAt" IS NULL AND folk_tx_ref_key(OLD."bankRef") IS NOT NULL;
    IF NOT open_claim OR NEW."status" = 'VERIFIED' OR NEW."verifiedAt" IS NOT NULL THEN RETURN NEW; END IF;
    IF NEW."status" = 'REJECTED' THEN
      actor := NEW."rejectedById"; act := 'advance.return_rejected'; why := NEW."rejectedReason";
    ELSIF NEW."status" = 'VOIDED' OR NEW."voidedAt" IS NOT NULL THEN
      actor := NEW."voidedById"; act := 'advance.return_voided'; why := NEW."voidReason";
    ELSIF folk_tx_ref_key(NEW."bankRef") IS DISTINCT FROM folk_tx_ref_key(OLD."bankRef") THEN
      RAISE EXCEPTION 'BANK_TX_GUARD: a claimed return keeps its bank reference until it is verified, rejected or voided';
    ELSE
      RETURN NEW;
    END IF;
    IF length(btrim(coalesce(why, ''))) < 5 OR NOT bank_tx_actor_audit(ARRAY[act], 'GuideAdvanceReceipt', NEW."id", actor, ARRAY['ADMIN', 'OPERATOR']) THEN
      RAISE EXCEPTION 'BANK_TX_GUARD: releasing a claimed transfer needs who, why, and that action''s audit in the same transaction';
    END IF;
    RETURN NEW;
  END IF;
  -- UpsellPayment: a guest's bank transfer waiting to be matched. No application path ends one
  -- unconfirmed yet; any future one writes 'upsell.bank_payment_released' as an Admin.
  open_claim := OLD."method" = 'BANK_TRANSFER' AND OLD."status" = 'PENDING' AND OLD."confirmedAt" IS NULL AND folk_tx_ref_key(OLD."bankRef") IS NOT NULL;
  IF NOT open_claim OR NEW."confirmedAt" IS NOT NULL OR NEW."status" IN ('PENDING', 'CONFIRMED') AND folk_tx_ref_key(NEW."bankRef") IS NOT DISTINCT FROM folk_tx_ref_key(OLD."bankRef") THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "AuditLog" a JOIN "User" u ON u."id" = a."actorId"
                  WHERE a."action" = 'upsell.bank_payment_released' AND a."entityType" = 'UpsellPayment' AND a."entityId" = NEW."id"
                    AND a."actorRole" = 'ADMIN' AND u."role"::text = 'ADMIN' AND u."state"::text = 'ACTIVE'
                    AND a.xmin::text::bigint = txid_current() % 4294967296) THEN
    RAISE EXCEPTION 'BANK_TX_GUARD: releasing a claimed transfer needs an Admin''s audited action in the same transaction';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER bank_tx_claim_guard BEFORE UPDATE OR DELETE ON "GuideAdvanceReceipt" FOR EACH ROW EXECUTE FUNCTION bank_tx_claim_guard();
CREATE TRIGGER bank_tx_claim_guard BEFORE UPDATE OR DELETE ON "UpsellPayment" FOR EACH ROW EXECUTE FUNCTION bank_tx_claim_guard();

-- ─── Room left on a transfer: what the application asks BEFORE writing ─────────────────────
-- Read-only. NEW (no transfer yet), PENDING (not a checkable reference), AMBIGUOUS, or OK with the
-- amount and what is applied — excluding the asking record's own share. The triggers stay the
-- authority (two writers at once); this lets a service refuse with a reason instead of an error.
CREATE FUNCTION bank_tx_room(p_dir text, p_ref text, p_account text, p_table text, p_id text)
RETURNS TABLE (state text, amount int, applied bigint) AS $$
DECLARE k text := folk_tx_ref_key(p_ref); n int; tx_id text; own bigint;
BEGIN
  IF k IS NULL THEN RETURN QUERY SELECT 'NONE'::text, NULL::int, NULL::bigint; RETURN; END IF;
  IF k !~ '[0-9]' THEN RETURN QUERY SELECT 'PENDING'::text, NULL::int, NULL::bigint; RETURN; END IF;
  SELECT count(*) INTO n FROM "BankTransaction" WHERE "direction" = p_dir AND "refStatus" = 'BANK_REF' AND "refKey" = k
     AND (p_account IS NULL OR "accountKey" IS NULL OR "accountKey" = p_account);
  IF n = 0 THEN RETURN QUERY SELECT 'NEW'::text, NULL::int, NULL::bigint; RETURN; END IF;
  SELECT "id" INTO tx_id FROM "BankTransaction" WHERE "direction" = p_dir AND "refStatus" = 'BANK_REF' AND "refKey" = k
     AND (CASE WHEN n = 1 THEN (p_account IS NULL OR "accountKey" IS NULL OR "accountKey" = p_account) ELSE "accountKey" = p_account END) LIMIT 1;
  IF tx_id IS NULL THEN RETURN QUERY SELECT 'AMBIGUOUS'::text, NULL::int, NULL::bigint; RETURN; END IF;
  SELECT COALESCE(sum(CASE WHEN u."live" OR u."verified" THEN u."amountSatang" ELSE 0 END), 0) INTO own
    FROM "BankTransactionUse" u WHERE u."transactionId" = tx_id AND u."role" = 'USE' AND u."sourceTable" = p_table AND u."sourceId" = p_id;
  RETURN QUERY SELECT 'OK'::text, b."amountSatang", bank_tx_applied(tx_id) - own FROM "BankTransaction" b WHERE b."id" = tx_id;
END $$ LANGUAGE plpgsql STABLE;

-- ─── One trigger per source table ──────────────────────────────────────────────────────────

CREATE FUNCTION bank_tx_source() RETURNS trigger AS $$
DECLARE x record;
BEGIN
  PERFORM bank_tx_sync(TG_TABLE_NAME, CASE WHEN TG_OP = 'DELETE' THEN OLD."id" ELSE NEW."id" END);
  -- A payment's transfers live and die with it.
  IF TG_TABLE_NAME = 'GuidePayment' AND TG_OP = 'UPDATE' THEN
    IF NEW."reversedAt" IS DISTINCT FROM OLD."reversedAt" THEN
      FOR x IN SELECT "id" FROM "GuidePaymentTransfer" WHERE "paymentId" = NEW."id" ORDER BY "seq" LOOP
        PERFORM bank_tx_sync('GuidePaymentTransfer', x."id");
      END LOOP;
    END IF;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER bank_tx_guide_advance AFTER INSERT OR UPDATE OF "txRef", "bankAccountKey", "amountSatang", "reversedAt" OR DELETE ON "GuideAdvance"
  FOR EACH ROW EXECUTE FUNCTION bank_tx_source();
CREATE TRIGGER bank_tx_guide_advance_receipt AFTER INSERT OR UPDATE OF "bankRef", "bankAccountKey", "amountSatang", "status", "voidedAt", "verifiedAt" OR DELETE ON "GuideAdvanceReceipt"
  FOR EACH ROW EXECUTE FUNCTION bank_tx_source();
CREATE TRIGGER bank_tx_guide_advance_return AFTER INSERT OR UPDATE OF "txRef", "amount" OR DELETE ON "GuideAdvanceReturn"
  FOR EACH ROW EXECUTE FUNCTION bank_tx_source();
CREATE TRIGGER bank_tx_guide_advance_refund AFTER INSERT OR UPDATE OF "bankRef", "amountSatang", "status", "voidedAt", "paidAt" OR DELETE ON "GuideAdvanceRefund"
  FOR EACH ROW EXECUTE FUNCTION bank_tx_source();
CREATE TRIGGER bank_tx_guide_payment AFTER INSERT OR UPDATE OF "bankRef", "amountTransferred", "reversedAt", "transferGroup", "transferTotal" OR DELETE ON "GuidePayment"
  FOR EACH ROW EXECUTE FUNCTION bank_tx_source();
CREATE TRIGGER bank_tx_guide_payment_transfer AFTER INSERT OR UPDATE OF "bankRef", "amount", "paymentId" OR DELETE ON "GuidePaymentTransfer"
  FOR EACH ROW EXECUTE FUNCTION bank_tx_source();
CREATE TRIGGER bank_tx_guide_payment_document AFTER INSERT OR UPDATE OF "bankRef", "bankAccountKey", "status" OR DELETE ON "GuidePaymentDocument"
  FOR EACH ROW EXECUTE FUNCTION bank_tx_source();
CREATE TRIGGER bank_tx_upsell_payment AFTER INSERT OR UPDATE OF "bankRef", "bankAccountKey", "amountSatang", "status", "confirmedAt", "method" OR DELETE ON "UpsellPayment"
  FOR EACH ROW EXECUTE FUNCTION bank_tx_source();

-- The document number a person knows a source row by (for refusals that must name it).
CREATE FUNCTION bank_tx_doc_no(p_table text, p_id text) RETURNS text AS $$
  SELECT CASE p_table
    WHEN 'GuideAdvance' THEN (SELECT "advanceNo" FROM "GuideAdvance" WHERE "id" = p_id)
    WHEN 'GuideAdvanceReceipt' THEN (SELECT "receiptNo" FROM "GuideAdvanceReceipt" WHERE "id" = p_id)
    WHEN 'GuideAdvanceRefund' THEN (SELECT "refundNo" FROM "GuideAdvanceRefund" WHERE "id" = p_id)
    WHEN 'GuidePayment' THEN (SELECT "paymentNo" FROM "GuidePayment" WHERE "id" = p_id)
    WHEN 'GuidePaymentTransfer' THEN (SELECT p."paymentNo" || ' transfer ' || t."seq" FROM "GuidePaymentTransfer" t JOIN "GuidePayment" p ON p."id" = t."paymentId" WHERE t."id" = p_id)
    WHEN 'GuidePaymentDocument' THEN (SELECT "paymentRef" FROM "GuidePaymentDocument" WHERE "id" = p_id)
    ELSE p_table || ' ' || p_id END
$$ LANGUAGE sql STABLE;

-- ─── Backfill: the transfers already recorded, oldest first ────────────────────────────────
-- History decides (the first USE sets the amount). History is never repaired here: if records
-- already pay one transfer more than once — live, or a reversed record and a later one on the
-- same reference — the migration STOPS, names the documents, and writes nothing (owner rule:
-- an Admin resolves each case from the slip first).
DO $$
DECLARE r record; k text; docs text;
BEGIN
  FOR r IN
    SELECT * FROM (
      SELECT 'GuideAdvance' tbl, "id", "createdAt" at FROM "GuideAdvance" WHERE folk_tx_ref_key("txRef") IS NOT NULL
      UNION ALL SELECT 'GuideAdvanceReceipt', "id", "createdAt" FROM "GuideAdvanceReceipt" WHERE folk_tx_ref_key("bankRef") IS NOT NULL
      UNION ALL SELECT 'GuideAdvanceReturn', "id", "createdAt" FROM "GuideAdvanceReturn" WHERE folk_tx_ref_key("txRef") IS NOT NULL
      UNION ALL SELECT 'GuideAdvanceRefund', "id", "createdAt" FROM "GuideAdvanceRefund" WHERE folk_tx_ref_key("bankRef") IS NOT NULL
      UNION ALL SELECT 'GuidePayment', "id", "createdAt" FROM "GuidePayment" WHERE folk_tx_ref_key("bankRef") IS NOT NULL
      UNION ALL SELECT 'GuidePaymentTransfer', "id", "createdAt" FROM "GuidePaymentTransfer" WHERE folk_tx_ref_key("bankRef") IS NOT NULL
      UNION ALL SELECT 'GuidePaymentDocument', "id", "createdAt" FROM "GuidePaymentDocument" WHERE folk_tx_ref_key("bankRef") IS NOT NULL
      UNION ALL SELECT 'UpsellPayment', "id", "createdAt" FROM "UpsellPayment" WHERE "method" = 'BANK_TRANSFER' AND folk_tx_ref_key("bankRef") IS NOT NULL
    ) x
    ORDER BY at, tbl, id
  LOOP
    BEGIN
      PERFORM bank_tx_sync(r.tbl, r.id);
    EXCEPTION WHEN OTHERS THEN
      SELECT folk_tx_ref_key(e.ref) INTO k FROM bank_tx_expected(r.tbl, r.id) e;
      SELECT string_agg(DISTINCT bank_tx_doc_no(u."sourceTable", u."sourceId"), ', ') INTO docs
        FROM "BankTransactionUse" u JOIN "BankTransaction" b ON b."id" = u."transactionId" WHERE b."refKey" = k;
      RAISE EXCEPTION 'BANK_TX_BACKFILL_STOPPED: % (%) cannot be linked — %. Already on reference …%: %. Nothing was migrated; an Admin must resolve this from the slip first.',
        bank_tx_doc_no(r.tbl, r.id), r.tbl, SQLERRM, right(coalesce(k, ''), 4), coalesce(docs, 'none');
    END;
  END LOOP;

  -- History whose state cannot be told from the rows: flagged, never silently reused.
  UPDATE "BankTransaction" b SET "reviewStatus" = 'NEEDS_REVIEW', "updatedAt" = now(),
         "reviewNote" = concat_ws(' · ', b."reviewNote", 'A receipt was verified and later rejected; check whether the money arrived')
   WHERE EXISTS (SELECT 1 FROM "BankTransactionUse" u JOIN "GuideAdvanceReceipt" g ON g."id" = u."sourceId"
                  WHERE u."transactionId" = b."id" AND u."sourceTable" = 'GuideAdvanceReceipt' AND g."status" = 'REJECTED' AND u."verified");
  UPDATE "BankTransaction" b SET "reviewStatus" = 'NEEDS_REVIEW', "updatedAt" = now(),
         "reviewNote" = concat_ws(' · ', b."reviewNote", 'Amount summed from a transfer group recorded before transferTotal; confirm it against the slip')
   WHERE b."amountSource" = 'HISTORICAL_GROUP_SUM'
     AND (SELECT count(*) FROM "GuidePayment" p WHERE p."transferGroup" = b."amountGroup") <> 2;
END $$;

-- From here on, HISTORICAL_* provenance is refused.
DO $$
BEGIN
  EXECUTE format('CREATE OR REPLACE FUNCTION bank_tx_installed_at() RETURNS timestamptz LANGUAGE sql STABLE AS %L',
                 'SELECT ' || quote_literal(clock_timestamp()::timestamptz::text) || '::timestamptz');
END $$;
