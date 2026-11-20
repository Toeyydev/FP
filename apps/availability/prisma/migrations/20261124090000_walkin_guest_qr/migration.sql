-- Guest QR for a walk-in seat (owner, 20 Nov 2026: "แขกสแกน ลงทะเบียน/ซื้อทัวร์ walk-in").
-- A guide (own job) or an Admin opens a QR for one job + product version; a guest scans it and
-- registers (PENDING). A registration is never money: only the guide's "cash received" makes the
-- sale (lib/upsell/sales recordWalkInSale), and that links it here (CONFIRMED). Nothing here
-- reserves a seat. Every token is stored as a SHA-256 hash for lookup and encrypted to show again.

CREATE TABLE "WalkInQr" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenEnc" TEXT NOT NULL,
    "jobSheetId" TEXT NOT NULL,
    "productVersionId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "revokeReason" TEXT,
    CONSTRAINT "WalkInQr_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WalkInQr_tokenHash_key" ON "WalkInQr"("tokenHash");
CREATE INDEX "WalkInQr_jobSheetId_idx" ON "WalkInQr"("jobSheetId");
-- One live QR per job and product version: a new one revokes the old first.
CREATE UNIQUE INDEX "WalkInQr_one_live" ON "WalkInQr"("jobSheetId", "productVersionId") WHERE "revokedAt" IS NULL;
ALTER TABLE "WalkInQr" ADD CONSTRAINT "WalkInQr_jobSheetId_fkey" FOREIGN KEY ("jobSheetId") REFERENCES "JobSheet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalkInQr" ADD CONSTRAINT "WalkInQr_productVersionId_fkey" FOREIGN KEY ("productVersionId") REFERENCES "UpsellProductVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalkInQr" ADD CONSTRAINT "WalkInQr_hash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "WalkInQr" ADD CONSTRAINT "WalkInQr_revoked_check" CHECK (("revokedAt" IS NULL) = ("revokedById" IS NULL));

CREATE TABLE "WalkInRegistration" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "viewTokenHash" TEXT NOT NULL,
    "viewTokenEnc" TEXT NOT NULL,
    "qrId" TEXT NOT NULL,
    "jobSheetId" TEXT NOT NULL,
    "productVersionId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "guests" INTEGER NOT NULL,
    "unitPriceSatang" INTEGER NOT NULL,
    "totalSatang" INTEGER NOT NULL,
    "leadName" TEXT,
    "contactEnc" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "saleId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "endReason" TEXT,
    CONSTRAINT "WalkInRegistration_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WalkInRegistration_reference_key" ON "WalkInRegistration"("reference");
CREATE UNIQUE INDEX "WalkInRegistration_viewTokenHash_key" ON "WalkInRegistration"("viewTokenHash");
CREATE UNIQUE INDEX "WalkInRegistration_saleId_key" ON "WalkInRegistration"("saleId");
CREATE UNIQUE INDEX "WalkInRegistration_qrId_requestKey_key" ON "WalkInRegistration"("qrId", "requestKey");
CREATE INDEX "WalkInRegistration_jobSheetId_status_idx" ON "WalkInRegistration"("jobSheetId", "status");
CREATE INDEX "WalkInRegistration_qrId_createdAt_idx" ON "WalkInRegistration"("qrId", "createdAt");
ALTER TABLE "WalkInRegistration" ADD CONSTRAINT "WalkInRegistration_qrId_fkey" FOREIGN KEY ("qrId") REFERENCES "WalkInQr"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalkInRegistration" ADD CONSTRAINT "WalkInRegistration_jobSheetId_fkey" FOREIGN KEY ("jobSheetId") REFERENCES "JobSheet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalkInRegistration" ADD CONSTRAINT "WalkInRegistration_productVersionId_fkey" FOREIGN KEY ("productVersionId") REFERENCES "UpsellProductVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalkInRegistration" ADD CONSTRAINT "WalkInRegistration_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "UpsellSale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalkInRegistration" ADD CONSTRAINT "WalkInRegistration_status_check" CHECK ("status" IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED'));
ALTER TABLE "WalkInRegistration" ADD CONSTRAINT "WalkInRegistration_guests_check" CHECK ("guests" BETWEEN 1 AND 50);
ALTER TABLE "WalkInRegistration" ADD CONSTRAINT "WalkInRegistration_total_check" CHECK ("unitPriceSatang" > 0 AND "totalSatang" = "guests" * "unitPriceSatang");
-- A sale belongs to a CONFIRMED registration, and a CONFIRMED one always has its sale.
ALTER TABLE "WalkInRegistration" ADD CONSTRAINT "WalkInRegistration_sale_check" CHECK (("status" = 'CONFIRMED') = ("saleId" IS NOT NULL));
ALTER TABLE "WalkInRegistration" ADD CONSTRAINT "WalkInRegistration_reference_check" CHECK ("reference" ~ '^W-[0-9A-Z]{4}-[0-9A-Z]{4}$');

-- What a registration is never changes; it only moves PENDING → CONFIRMED | CANCELLED | EXPIRED,
-- once. After it ends the guest's name and contact may be cleared (minimal personal data), never
-- rewritten. Nothing is ever deleted.
CREATE FUNCTION walk_in_registration_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'WALKIN_REGISTRATION_KEPT: a registration is never deleted'; END IF;
  IF NEW."reference" IS DISTINCT FROM OLD."reference" OR NEW."viewTokenHash" IS DISTINCT FROM OLD."viewTokenHash" OR NEW."viewTokenEnc" IS DISTINCT FROM OLD."viewTokenEnc"
     OR NEW."qrId" IS DISTINCT FROM OLD."qrId" OR NEW."jobSheetId" IS DISTINCT FROM OLD."jobSheetId" OR NEW."productVersionId" IS DISTINCT FROM OLD."productVersionId"
     OR NEW."requestKey" IS DISTINCT FROM OLD."requestKey" OR NEW."guests" IS DISTINCT FROM OLD."guests" OR NEW."unitPriceSatang" IS DISTINCT FROM OLD."unitPriceSatang"
     OR NEW."totalSatang" IS DISTINCT FROM OLD."totalSatang" OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'WALKIN_REGISTRATION_KEPT: what a registration is never changes';
  END IF;
  IF OLD."status" <> 'PENDING' THEN
    IF NEW."status" IS DISTINCT FROM OLD."status" OR NEW."saleId" IS DISTINCT FROM OLD."saleId" OR NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt"
       OR NEW."decidedById" IS DISTINCT FROM OLD."decidedById" OR NEW."endReason" IS DISTINCT FROM OLD."endReason"
       OR (NEW."leadName" IS NOT NULL AND NEW."leadName" IS DISTINCT FROM OLD."leadName") OR (NEW."contactEnc" IS NOT NULL AND NEW."contactEnc" IS DISTINCT FROM OLD."contactEnc") THEN
      RAISE EXCEPTION 'WALKIN_REGISTRATION_TRANSITION: an ended registration only has its personal data cleared';
    END IF;
  ELSIF NEW."status" <> 'PENDING' THEN
    IF NEW."decidedAt" IS NULL THEN RAISE EXCEPTION 'WALKIN_REGISTRATION_TRANSITION: an ending says when'; END IF;
  ELSIF NEW."leadName" IS DISTINCT FROM OLD."leadName" OR NEW."contactEnc" IS DISTINCT FROM OLD."contactEnc" OR NEW."saleId" IS NOT NULL THEN
    RAISE EXCEPTION 'WALKIN_REGISTRATION_KEPT: a waiting registration is not edited';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER walk_in_registration_guard BEFORE UPDATE OR DELETE ON "WalkInRegistration"
  FOR EACH ROW EXECUTE FUNCTION walk_in_registration_guard();

-- A registration starts PENDING, for the QR's own job and version, at that version's price.
CREATE FUNCTION walk_in_registration_born() RETURNS trigger AS $$
DECLARE q RECORD; price int;
BEGIN
  IF NEW."status" <> 'PENDING' OR NEW."saleId" IS NOT NULL OR NEW."decidedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'WALKIN_REGISTRATION_TRANSITION: a registration starts PENDING';
  END IF;
  SELECT * INTO q FROM "WalkInQr" WHERE "id" = NEW."qrId";
  IF q."jobSheetId" <> NEW."jobSheetId" OR q."productVersionId" <> NEW."productVersionId" THEN
    RAISE EXCEPTION 'WALKIN_REGISTRATION_BOUND: a registration is for its QR''s job and product';
  END IF;
  SELECT "unitPriceSatang" INTO price FROM "UpsellProductVersion" WHERE "id" = NEW."productVersionId";
  IF price IS DISTINCT FROM NEW."unitPriceSatang" THEN RAISE EXCEPTION 'WALKIN_REGISTRATION_BOUND: the price is the version''s'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER walk_in_registration_born BEFORE INSERT ON "WalkInRegistration"
  FOR EACH ROW EXECUTE FUNCTION walk_in_registration_born();

-- A QR is never deleted, never re-pointed, and once revoked stays revoked.
CREATE FUNCTION walk_in_qr_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'WALKIN_QR_KEPT: a QR is never deleted'; END IF;
  IF NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash" OR NEW."tokenEnc" IS DISTINCT FROM OLD."tokenEnc" OR NEW."jobSheetId" IS DISTINCT FROM OLD."jobSheetId"
     OR NEW."productVersionId" IS DISTINCT FROM OLD."productVersionId" OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR (OLD."revokedAt" IS NOT NULL AND (NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt" OR NEW."revokedById" IS DISTINCT FROM OLD."revokedById" OR NEW."revokeReason" IS DISTINCT FROM OLD."revokeReason")) THEN
    RAISE EXCEPTION 'WALKIN_QR_KEPT: a QR is only revoked, once';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER walk_in_qr_guard BEFORE UPDATE OR DELETE ON "WalkInQr"
  FOR EACH ROW EXECUTE FUNCTION walk_in_qr_guard();
