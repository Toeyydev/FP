-- P0 PEAK safety: one bank transfer = one advance, the slip check record, and the
-- services' own status rows.
--
--   GuideAdvance.txRefKey          the transfer's identity, derived by the DATABASE from
--                                  txRef (folk_tx_ref_key below) on every insert and every
--                                  change of txRef, so no write path can skip it.
--   GuideAdvance_txRefKey_live_key unique over LIVE advances (not reversed): one transfer
--                                  can be one advance only, whatever job or session it is
--                                  typed in, and two requests arriving together cannot
--                                  both win.
--   GuideAdvance.slipCheck*        the result of the slip check when the advance was
--                                  recorded, and who confirmed a result short of MATCH.
--   ServiceStatus                  FP and payment-worker each report their PEAK switches,
--                                  build and last run here (lib/peak-switches).
--
-- Additive. The only UPDATE fills the new derived column on existing rows; no existing
-- value changes. If two LIVE advances already share a transfer reference, the migration
-- stops BEFORE changing anything and names them: nothing is merged or deleted
-- automatically — a person reverses the wrong one, then the deploy is retried.

-- The key: Thai digits to ASCII, Unicode compatibility forms folded (full-width letters
-- and digits), every character that is not a letter or digit dropped, upper case. The
-- same function lives in lib/advances/tx-ref.ts; a test keeps the two in step.
CREATE OR REPLACE FUNCTION folk_tx_ref_key(ref TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT NULLIF(upper(regexp_replace(normalize(translate(coalesce(ref, ''), '๐๑๒๓๔๕๖๗๘๙', '0123456789'), NFKC), '[^A-Za-z0-9]', '', 'g')), '')
$$;

DO $$
DECLARE dup TEXT;
BEGIN
  SELECT string_agg(k || ': ' || nos, '; ') INTO dup FROM (
    SELECT folk_tx_ref_key("txRef") AS k, string_agg("advanceNo", ', ' ORDER BY "advanceNo") AS nos
    FROM "GuideAdvance"
    WHERE "reversedAt" IS NULL AND folk_tx_ref_key("txRef") IS NOT NULL
    GROUP BY 1 HAVING count(*) > 1
  ) d;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION 'Live advances share a bank transfer reference — reverse the wrong one before deploying (nothing was changed): %', dup;
  END IF;
END $$;

-- AlterTable
ALTER TABLE "GuideAdvance" ADD COLUMN "txRefKey" TEXT,
ADD COLUMN "slipCheckResult" TEXT,
ADD COLUMN "slipCheck" JSONB,
ADD COLUMN "slipCheckConfirmedById" TEXT,
ADD COLUMN "slipCheckReason" TEXT,
ADD COLUMN "slipCheckAt" TIMESTAMP(3);

ALTER TABLE "GuideAdvance" ADD CONSTRAINT "GuideAdvance_slipCheckResult_check"
  CHECK ("slipCheckResult" IS NULL OR "slipCheckResult" IN ('MATCH', 'PARTIAL', 'MISMATCH', 'UNKNOWN'));

CREATE OR REPLACE FUNCTION guide_advance_tx_ref_key() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."txRefKey" := folk_tx_ref_key(NEW."txRef");
  RETURN NEW;
END $$;

CREATE TRIGGER guide_advance_tx_ref_key BEFORE INSERT OR UPDATE OF "txRef", "txRefKey" ON "GuideAdvance"
  FOR EACH ROW EXECUTE FUNCTION guide_advance_tx_ref_key();

-- Fill the new column on the rows that exist (fires the trigger above).
UPDATE "GuideAdvance" SET "txRefKey" = folk_tx_ref_key("txRef") WHERE "txRef" IS NOT NULL;

CREATE UNIQUE INDEX "GuideAdvance_txRefKey_live_key" ON "GuideAdvance"("txRefKey")
  WHERE "txRefKey" IS NOT NULL AND "reversedAt" IS NULL;

-- CreateTable
CREATE TABLE "ServiceStatus" (
    "id" TEXT NOT NULL,
    "version" TEXT,
    "deploymentId" TEXT,
    "autoSync" BOOLEAN NOT NULL DEFAULT false,
    "existingLinks" BOOLEAN NOT NULL DEFAULT false,
    "writesFrozen" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSuccessAt" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceStatus_pkey" PRIMARY KEY ("id")
);
