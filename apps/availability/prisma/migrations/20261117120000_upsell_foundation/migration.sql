-- Tour Upsell Engine — foundation (PR1).
--
-- Tables only; no route or page reads them yet and every feature switch is off. The rules
-- that must hold whatever the application does are enforced here: money is a positive
-- integer number of satang, card payments are not accepted yet, the guide holding company
-- cash is always the guide who collected it, a guide's custody balance never goes below
-- zero, and a confirmed payment / settlement or a custody entry is never edited or deleted
-- (a reversal is a new row). There is no gateway-fee rate anywhere: fees will come from the
-- gateway's settlement. Per-guide capacity is not configured here — it is PAX_PER_GUIDE.
--
-- Trigger errors carry the prefix UPSELL_ so callers can tell them apart.

-- CreateTable
CREATE TABLE "UpsellProduct" (
    "id" TEXT NOT NULL,
    "productCode" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "productType" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UpsellProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpsellProductVersion" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "unitPriceSatang" INTEGER NOT NULL,
    "pricingBasis" TEXT NOT NULL DEFAULT 'PER_GUEST',
    "allowedPaymentMethods" TEXT[],
    "createsNewBooking" BOOLEAN NOT NULL DEFAULT false,
    "createsNewJob" BOOLEAN NOT NULL DEFAULT false,
    "serviceTourId" TEXT,
    "capacityGroupKey" TEXT,
    "fixedCostPerGuestSatang" INTEGER NOT NULL DEFAULT 0,
    "fixedCostBasis" TEXT,
    "fixedCostCategory" TEXT,
    "incentivePerGuestSatang" INTEGER NOT NULL DEFAULT 0,
    "incentiveTrigger" TEXT NOT NULL DEFAULT 'NONE',
    "incentiveBasis" TEXT NOT NULL DEFAULT 'PAID_GUESTS',
    "serviceValidityDays" INTEGER,
    "checkoutLinkExpiryMinutes" INTEGER,
    "remittanceTrigger" TEXT NOT NULL DEFAULT 'SOURCE_JOB_END',
    "serviceScope" TEXT NOT NULL DEFAULT 'EXISTING_GUIDE',
    "revenueCategory" TEXT NOT NULL,
    "taxProfileId" TEXT NOT NULL,
    "priceOverridePermission" TEXT NOT NULL DEFAULT 'NONE',
    "refundPolicy" TEXT NOT NULL DEFAULT 'NON_REFUNDABLE',
    "activeFrom" TEXT NOT NULL,
    "activeTo" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UpsellProductVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxProfile" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "vatMode" TEXT NOT NULL DEFAULT 'UNCONFIRMED',
    "vatRateBp" INTEGER,
    "revenueRecognition" TEXT,
    "breakageOnExpiry" BOOLEAN,
    "peakDocumentKind" TEXT,
    "incentiveWhtSource" TEXT,
    "incentiveWhtPct" DECIMAL(5,2),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpsellDocCounter" (
    "key" TEXT NOT NULL,
    "lastSeq" INTEGER NOT NULL,

    CONSTRAINT "UpsellDocCounter_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "UpsellSale" (
    "id" TEXT NOT NULL,
    "saleNo" TEXT NOT NULL,
    "productVersionId" TEXT NOT NULL,
    "ruleSnapshot" JSONB NOT NULL,
    "sourceJobSheetId" TEXT NOT NULL,
    "sourceBookingId" TEXT,
    "sellingGuideId" TEXT NOT NULL,
    "serviceGuideId" TEXT,
    "fixedCostRecipientId" TEXT,
    "pricingBasis" TEXT NOT NULL DEFAULT 'PER_GUEST',
    "guests" INTEGER NOT NULL,
    "unitPriceSatang" INTEGER NOT NULL,
    "grossSatang" INTEGER NOT NULL,
    "priceOverrideReason" TEXT,
    "priceOverrideApprovedById" TEXT,
    "customerName" TEXT,
    "customerContact" TEXT,
    "serviceBookingId" TEXT,
    "serviceValidUntil" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "requestKey" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UpsellSale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpsellPayment" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "amountSatang" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "statusSource" TEXT,
    "cashCollectorId" TEXT,
    "evidenceId" TEXT,
    "bankRef" TEXT,
    "bankRefNormalized" TEXT,
    "bankAccountKey" TEXT,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "requestKey" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UpsellPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashCustodyEntry" (
    "id" TEXT NOT NULL,
    "custodianId" TEXT NOT NULL,
    "sourceJobSheetId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amountSatang" INTEGER NOT NULL,
    "paymentId" TEXT,
    "saleId" TEXT,
    "settlementId" TEXT,
    "sourceRefId" TEXT,
    "reversesId" TEXT,
    "idempotencyKey" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashCustodyEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashSettlement" (
    "id" TEXT NOT NULL,
    "settlementNo" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "sourceJobSheetId" TEXT NOT NULL,
    "expectedSatang" INTEGER NOT NULL,
    "remittedSatang" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "evidenceId" TEXT,
    "bankRef" TEXT,
    "bankRefNormalized" TEXT,
    "bankAccountKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "returnedReason" TEXT,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "requestKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UpsellProduct_productCode_key" ON "UpsellProduct"("productCode");

-- CreateIndex
CREATE UNIQUE INDEX "UpsellProductVersion_productId_version_key" ON "UpsellProductVersion"("productId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "TaxProfile_code_key" ON "TaxProfile"("code");

-- CreateIndex
CREATE UNIQUE INDEX "UpsellSale_saleNo_key" ON "UpsellSale"("saleNo");

-- CreateIndex
CREATE UNIQUE INDEX "UpsellSale_serviceBookingId_key" ON "UpsellSale"("serviceBookingId");

-- CreateIndex
CREATE UNIQUE INDEX "UpsellSale_requestKey_key" ON "UpsellSale"("requestKey");

-- CreateIndex
CREATE INDEX "UpsellSale_sourceJobSheetId_idx" ON "UpsellSale"("sourceJobSheetId");

-- CreateIndex
CREATE INDEX "UpsellSale_sellingGuideId_createdAt_idx" ON "UpsellSale"("sellingGuideId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UpsellPayment_requestKey_key" ON "UpsellPayment"("requestKey");

-- CreateIndex
CREATE INDEX "UpsellPayment_saleId_idx" ON "UpsellPayment"("saleId");

-- CreateIndex
CREATE UNIQUE INDEX "UpsellPayment_bankAccountKey_bankRefNormalized_key" ON "UpsellPayment"("bankAccountKey", "bankRefNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "CashCustodyEntry_reversesId_key" ON "CashCustodyEntry"("reversesId");

-- CreateIndex
CREATE UNIQUE INDEX "CashCustodyEntry_idempotencyKey_key" ON "CashCustodyEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CashCustodyEntry_custodianId_sourceJobSheetId_idx" ON "CashCustodyEntry"("custodianId", "sourceJobSheetId");

-- CreateIndex
CREATE UNIQUE INDEX "CashSettlement_settlementNo_key" ON "CashSettlement"("settlementNo");

-- CreateIndex
CREATE UNIQUE INDEX "CashSettlement_requestKey_key" ON "CashSettlement"("requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "CashSettlement_guideId_sourceJobSheetId_key" ON "CashSettlement"("guideId", "sourceJobSheetId");

-- CreateIndex
CREATE UNIQUE INDEX "CashSettlement_bankAccountKey_bankRefNormalized_key" ON "CashSettlement"("bankAccountKey", "bankRefNormalized");

-- AddForeignKey
ALTER TABLE "UpsellProductVersion" ADD CONSTRAINT "UpsellProductVersion_productId_fkey" FOREIGN KEY ("productId") REFERENCES "UpsellProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpsellProductVersion" ADD CONSTRAINT "UpsellProductVersion_taxProfileId_fkey" FOREIGN KEY ("taxProfileId") REFERENCES "TaxProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpsellSale" ADD CONSTRAINT "UpsellSale_productVersionId_fkey" FOREIGN KEY ("productVersionId") REFERENCES "UpsellProductVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpsellSale" ADD CONSTRAINT "UpsellSale_sourceJobSheetId_fkey" FOREIGN KEY ("sourceJobSheetId") REFERENCES "JobSheet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpsellPayment" ADD CONSTRAINT "UpsellPayment_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "UpsellSale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashCustodyEntry" ADD CONSTRAINT "CashCustodyEntry_sourceJobSheetId_fkey" FOREIGN KEY ("sourceJobSheetId") REFERENCES "JobSheet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashCustodyEntry" ADD CONSTRAINT "CashCustodyEntry_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "UpsellPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashCustodyEntry" ADD CONSTRAINT "CashCustodyEntry_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "UpsellSale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashCustodyEntry" ADD CONSTRAINT "CashCustodyEntry_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "CashSettlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashCustodyEntry" ADD CONSTRAINT "CashCustodyEntry_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "CashCustodyEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashSettlement" ADD CONSTRAINT "CashSettlement_sourceJobSheetId_fkey" FOREIGN KEY ("sourceJobSheetId") REFERENCES "JobSheet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── CHECK constraints ────────────────────────────────────────────────────────────────────

ALTER TABLE "UpsellProduct" ADD CONSTRAINT "UpsellProduct_type_check"
  CHECK ("productType" IN ('ROUTE_EXTENSION', 'NEW_TOUR'));

ALTER TABLE "UpsellProductVersion"
  ADD CONSTRAINT "UpsellProductVersion_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "UpsellProductVersion_price_check" CHECK ("unitPriceSatang" > 0),
  ADD CONSTRAINT "UpsellProductVersion_pricing_basis_check" CHECK ("pricingBasis" IN ('PER_GUEST', 'PER_GROUP')),
  -- Card payments (PAYMENT_LINK) open together with the gateway work and its constraints.
  ADD CONSTRAINT "UpsellProductVersion_methods_check"
    CHECK (cardinality("allowedPaymentMethods") > 0 AND "allowedPaymentMethods" <@ ARRAY['CASH', 'BANK_TRANSFER']::text[]),
  ADD CONSTRAINT "UpsellProductVersion_job_needs_booking_check" CHECK (NOT "createsNewJob" OR "createsNewBooking"),
  ADD CONSTRAINT "UpsellProductVersion_booking_needs_tour_check" CHECK (NOT "createsNewBooking" OR "serviceTourId" IS NOT NULL),
  ADD CONSTRAINT "UpsellProductVersion_amounts_check" CHECK ("fixedCostPerGuestSatang" >= 0 AND "incentivePerGuestSatang" >= 0),
  ADD CONSTRAINT "UpsellProductVersion_fixed_basis_check"
    CHECK ("fixedCostBasis" IS NULL OR "fixedCostBasis" IN ('PAID', 'ATTENDED')),
  ADD CONSTRAINT "UpsellProductVersion_fixed_basis_required_check"
    CHECK ("fixedCostPerGuestSatang" = 0 OR ("fixedCostBasis" IS NOT NULL AND "fixedCostCategory" IS NOT NULL)),
  -- Owner decision D2: a Food Tour (a new tour with a fixed food cost) pays per PAID guest.
  ADD CONSTRAINT "UpsellProductVersion_new_tour_paid_basis_check"
    CHECK (NOT ("createsNewBooking" AND "fixedCostPerGuestSatang" > 0) OR "fixedCostBasis" = 'PAID'),
  ADD CONSTRAINT "UpsellProductVersion_incentive_trigger_check"
    CHECK ("incentiveTrigger" IN ('NONE', 'SERVICE_APPROVED') AND ("incentivePerGuestSatang" = 0 OR "incentiveTrigger" <> 'NONE')),
  ADD CONSTRAINT "UpsellProductVersion_incentive_basis_check" CHECK ("incentiveBasis" = 'PAID_GUESTS'),
  ADD CONSTRAINT "UpsellProductVersion_validity_check"
    CHECK (("serviceValidityDays" IS NULL OR "serviceValidityDays" > 0) AND ("checkoutLinkExpiryMinutes" IS NULL OR "checkoutLinkExpiryMinutes" > 0)),
  ADD CONSTRAINT "UpsellProductVersion_remittance_check" CHECK ("remittanceTrigger" = 'SOURCE_JOB_END'),
  ADD CONSTRAINT "UpsellProductVersion_enums_check"
    CHECK ("serviceScope" IN ('EXISTING_GUIDE', 'ASSIGNED_SEPARATELY')
       AND "priceOverridePermission" IN ('NONE', 'ADMIN_APPROVAL')
       AND "refundPolicy" IN ('NON_REFUNDABLE', 'ADMIN_ONLY')),
  ADD CONSTRAINT "UpsellProductVersion_active_dates_check"
    CHECK ("activeFrom" ~ '^\d{4}-\d{2}-\d{2}$' AND ("activeTo" IS NULL OR ("activeTo" ~ '^\d{4}-\d{2}-\d{2}$' AND "activeTo" >= "activeFrom")));

ALTER TABLE "TaxProfile"
  ADD CONSTRAINT "TaxProfile_vat_check"
    CHECK ("vatMode" IN ('UNCONFIRMED', 'NONE', 'INCLUSIVE', 'EXCLUSIVE') AND ("vatRateBp" IS NULL OR ("vatRateBp" >= 0 AND "vatRateBp" <= 10000))),
  ADD CONSTRAINT "TaxProfile_enums_check"
    CHECK (("revenueRecognition" IS NULL OR "revenueRecognition" IN ('AT_PAYMENT', 'AT_SERVICE'))
       AND ("peakDocumentKind" IS NULL OR "peakDocumentKind" IN ('JOURNAL', 'RECEIPT', 'TAX_INVOICE_RECEIPT'))
       AND ("incentiveWhtSource" IS NULL OR "incentiveWhtSource" IN ('CONFIGURED', 'ENTERED'))
       AND ("incentiveWhtPct" IS NULL OR ("incentiveWhtPct" >= 0 AND "incentiveWhtPct" <= 100))),
  ADD CONSTRAINT "TaxProfile_status_check" CHECK ("status" IN ('DRAFT', 'CONFIRMED')),
  -- Confirmed means the accountant answered every question; nothing is assumed.
  ADD CONSTRAINT "TaxProfile_confirmed_check"
    CHECK ("status" <> 'CONFIRMED' OR ("confirmedById" IS NOT NULL AND "confirmedAt" IS NOT NULL
       AND "vatMode" <> 'UNCONFIRMED' AND "revenueRecognition" IS NOT NULL AND "peakDocumentKind" IS NOT NULL));

ALTER TABLE "UpsellDocCounter" ADD CONSTRAINT "UpsellDocCounter_seq_check" CHECK ("lastSeq" > 0);

ALTER TABLE "UpsellSale"
  ADD CONSTRAINT "UpsellSale_no_check" CHECK ("saleNo" ~ '^FOLK-UPS-\d{6}-\d{3,}$'),
  ADD CONSTRAINT "UpsellSale_status_check"
    CHECK ("status" IN ('DRAFT', 'PENDING_PAYMENT', 'PAID', 'DELIVERED', 'AWAITING_DATE', 'SCHEDULED',
                        'SERVICE_REPORTED', 'SERVICE_APPROVED', 'SERVICE_APPROVED_NO_SHOW',
                        'EXPIRED_UNUSED', 'CLOSED', 'CANCELLED', 'REVERSED')),
  ADD CONSTRAINT "UpsellSale_money_check" CHECK ("guests" > 0 AND "unitPriceSatang" > 0 AND "grossSatang" > 0),
  ADD CONSTRAINT "UpsellSale_gross_check"
    CHECK (("pricingBasis" = 'PER_GUEST' AND "grossSatang" = "guests" * "unitPriceSatang")
        OR ("pricingBasis" = 'PER_GROUP' AND "grossSatang" = "unitPriceSatang")),
  -- A price override carries both its reason and the admin who approved it, or neither.
  ADD CONSTRAINT "UpsellSale_override_check" CHECK (("priceOverrideReason" IS NULL) = ("priceOverrideApprovedById" IS NULL));

ALTER TABLE "UpsellPayment"
  ADD CONSTRAINT "UpsellPayment_method_check" CHECK ("method" IN ('CASH', 'BANK_TRANSFER')),
  ADD CONSTRAINT "UpsellPayment_amount_check" CHECK ("amountSatang" > 0),
  ADD CONSTRAINT "UpsellPayment_status_check" CHECK ("status" IN ('PENDING', 'COLLECTED', 'CONFIRMED', 'FAILED', 'REVERSED')),
  ADD CONSTRAINT "UpsellPayment_source_check" CHECK ("statusSource" IS NULL OR "statusSource" IN ('GUIDE_CASH', 'ADMIN_BANK_MATCH')),
  -- Cash always names the guide who took it; nothing else does.
  ADD CONSTRAINT "UpsellPayment_collector_check" CHECK (("method" = 'CASH') = ("cashCollectorId" IS NOT NULL)),
  ADD CONSTRAINT "UpsellPayment_collected_is_cash_check" CHECK ("status" <> 'COLLECTED' OR "method" = 'CASH'),
  ADD CONSTRAINT "UpsellPayment_confirmed_check" CHECK ("status" <> 'CONFIRMED' OR "confirmedAt" IS NOT NULL),
  ADD CONSTRAINT "UpsellPayment_bank_ref_check" CHECK (("bankRefNormalized" IS NULL) = ("bankAccountKey" IS NULL));

ALTER TABLE "CashCustodyEntry"
  ADD CONSTRAINT "CashCustodyEntry_kind_check"
    CHECK ("kind" IN ('COLLECTED', 'DEDUCT_FIXED_COST', 'DEDUCT_INCENTIVE', 'DEDUCT_APPROVED', 'REMITTED', 'SHORTAGE', 'REVERSAL')),
  ADD CONSTRAINT "CashCustodyEntry_collected_check" CHECK ("kind" <> 'COLLECTED' OR ("amountSatang" > 0 AND "paymentId" IS NOT NULL)),
  ADD CONSTRAINT "CashCustodyEntry_outflow_check"
    CHECK ("kind" NOT IN ('DEDUCT_FIXED_COST', 'DEDUCT_INCENTIVE', 'DEDUCT_APPROVED', 'REMITTED', 'SHORTAGE') OR "amountSatang" < 0),
  ADD CONSTRAINT "CashCustodyEntry_deduction_source_check"
    CHECK ("kind" NOT IN ('DEDUCT_FIXED_COST', 'DEDUCT_INCENTIVE', 'DEDUCT_APPROVED') OR "sourceRefId" IS NOT NULL),
  ADD CONSTRAINT "CashCustodyEntry_remitted_check" CHECK ("kind" <> 'REMITTED' OR "settlementId" IS NOT NULL),
  ADD CONSTRAINT "CashCustodyEntry_reversal_check"
    CHECK ((("kind" = 'REVERSAL') = ("reversesId" IS NOT NULL)) AND ("kind" <> 'REVERSAL' OR "amountSatang" <> 0));

-- One COLLECTED entry per cash payment.
CREATE UNIQUE INDEX "CashCustodyEntry_one_collected_per_payment"
  ON "CashCustodyEntry"("paymentId") WHERE "kind" = 'COLLECTED';

ALTER TABLE "CashSettlement"
  ADD CONSTRAINT "CashSettlement_no_check" CHECK ("settlementNo" ~ '^FOLK-CSH-\d{6}-\d{3,}$'),
  ADD CONSTRAINT "CashSettlement_money_check" CHECK ("expectedSatang" >= 0 AND "remittedSatang" >= 0),
  ADD CONSTRAINT "CashSettlement_method_check" CHECK ("method" IN ('BANK_TRANSFER', 'CASH_AT_OFFICE')),
  ADD CONSTRAINT "CashSettlement_status_check" CHECK ("status" IN ('DRAFT', 'SUBMITTED', 'RETURNED', 'CONFIRMED', 'REVERSED')),
  ADD CONSTRAINT "CashSettlement_confirmed_check" CHECK ("status" <> 'CONFIRMED' OR ("confirmedById" IS NOT NULL AND "confirmedAt" IS NOT NULL)),
  ADD CONSTRAINT "CashSettlement_returned_check" CHECK ("status" <> 'RETURNED' OR "returnedReason" IS NOT NULL),
  ADD CONSTRAINT "CashSettlement_bank_ref_check" CHECK (("bankRefNormalized" IS NULL) = ("bankAccountKey" IS NULL));

-- ─── Triggers ─────────────────────────────────────────────────────────────────────────────

-- A version that has been sold under is frozen; only its end date may still be set.
CREATE FUNCTION upsell_product_version_frozen() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "UpsellSale" WHERE "productVersionId" = OLD."id") THEN
    IF (to_jsonb(NEW) - 'activeTo') IS DISTINCT FROM (to_jsonb(OLD) - 'activeTo') THEN
      RAISE EXCEPTION 'UPSELL_VERSION_FROZEN: version % has sales; create a new version instead', OLD."id";
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER upsell_product_version_frozen BEFORE UPDATE ON "UpsellProductVersion"
  FOR EACH ROW EXECUTE FUNCTION upsell_product_version_frozen();

-- A sale's terms are fixed once it leaves DRAFT; its rule snapshot is never rewritten.
CREATE FUNCTION upsell_sale_terms_frozen() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" NOT IN ('DRAFT', 'CANCELLED') THEN
      RAISE EXCEPTION 'UPSELL_SALE_IMMUTABLE: sale % is %; reverse it instead of deleting', OLD."saleNo", OLD."status";
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."ruleSnapshot" IS DISTINCT FROM OLD."ruleSnapshot"
     OR (OLD."status" <> 'DRAFT' AND (
          NEW."saleNo" IS DISTINCT FROM OLD."saleNo" OR NEW."productVersionId" IS DISTINCT FROM OLD."productVersionId"
       OR NEW."sourceJobSheetId" IS DISTINCT FROM OLD."sourceJobSheetId" OR NEW."sellingGuideId" IS DISTINCT FROM OLD."sellingGuideId"
       OR NEW."pricingBasis" IS DISTINCT FROM OLD."pricingBasis" OR NEW."guests" IS DISTINCT FROM OLD."guests"
       OR NEW."unitPriceSatang" IS DISTINCT FROM OLD."unitPriceSatang" OR NEW."grossSatang" IS DISTINCT FROM OLD."grossSatang"
       OR NEW."requestKey" IS DISTINCT FROM OLD."requestKey")) THEN
    RAISE EXCEPTION 'UPSELL_SALE_IMMUTABLE: the terms of sale % are fixed', OLD."saleNo";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER upsell_sale_terms_frozen BEFORE UPDATE OR DELETE ON "UpsellSale"
  FOR EACH ROW EXECUTE FUNCTION upsell_sale_terms_frozen();

-- Payments: a sale is never paid more than its gross, and money that has moved
-- (COLLECTED / CONFIRMED / REVERSED) is never edited or deleted.
CREATE FUNCTION upsell_payment_guard() RETURNS trigger AS $$
DECLARE
  gross int;
  live_total bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" IN ('COLLECTED', 'CONFIRMED', 'REVERSED') THEN
      RAISE EXCEPTION 'UPSELL_PAYMENT_IMMUTABLE: payment % is %; reverse it instead of deleting', OLD."id", OLD."status";
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."status" IN ('COLLECTED', 'CONFIRMED', 'REVERSED') THEN
    IF NEW."saleId" IS DISTINCT FROM OLD."saleId" OR NEW."method" IS DISTINCT FROM OLD."method"
       OR NEW."amountSatang" IS DISTINCT FROM OLD."amountSatang" OR NEW."cashCollectorId" IS DISTINCT FROM OLD."cashCollectorId"
       OR NEW."bankRefNormalized" IS DISTINCT FROM OLD."bankRefNormalized" OR NEW."bankAccountKey" IS DISTINCT FROM OLD."bankAccountKey"
       OR NEW."requestKey" IS DISTINCT FROM OLD."requestKey"
       OR (OLD."confirmedAt" IS NOT NULL AND (NEW."confirmedAt" IS DISTINCT FROM OLD."confirmedAt" OR NEW."confirmedById" IS DISTINCT FROM OLD."confirmedById")) THEN
      RAISE EXCEPTION 'UPSELL_PAYMENT_IMMUTABLE: payment % is %; its money cannot change', OLD."id", OLD."status";
    END IF;
    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
         (OLD."status" = 'COLLECTED' AND NEW."status" IN ('CONFIRMED', 'REVERSED'))
      OR (OLD."status" = 'CONFIRMED' AND NEW."status" = 'REVERSED')) THEN
      RAISE EXCEPTION 'UPSELL_PAYMENT_IMMUTABLE: payment % cannot go from % to %', OLD."id", OLD."status", NEW."status";
    END IF;
  END IF;

  -- Serialise payments of one sale, then check the total.
  SELECT "grossSatang" INTO gross FROM "UpsellSale" WHERE "id" = NEW."saleId" FOR UPDATE;
  SELECT COALESCE(SUM("amountSatang"), 0) INTO live_total FROM "UpsellPayment"
   WHERE "saleId" = NEW."saleId" AND "id" <> NEW."id" AND "status" IN ('PENDING', 'COLLECTED', 'CONFIRMED');
  IF NEW."status" IN ('PENDING', 'COLLECTED', 'CONFIRMED') THEN live_total := live_total + NEW."amountSatang"; END IF;
  IF live_total > gross THEN
    RAISE EXCEPTION 'UPSELL_PAYMENT_OVER_GROSS: payments for sale % would total % satang, more than its gross %', NEW."saleId", live_total, gross;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER upsell_payment_guard BEFORE INSERT OR UPDATE OR DELETE ON "UpsellPayment"
  FOR EACH ROW EXECUTE FUNCTION upsell_payment_guard();

-- Custody ledger: append-only.
CREATE FUNCTION cash_custody_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'UPSELL_CUSTODY_APPEND_ONLY: custody entries are never % — add a REVERSAL entry', lower(TG_OP) || 'd';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER cash_custody_append_only BEFORE UPDATE OR DELETE ON "CashCustodyEntry"
  FOR EACH ROW EXECUTE FUNCTION cash_custody_append_only();

-- Custody ledger: what may be written.
CREATE FUNCTION cash_custody_insert_guard() RETURNS trigger AS $$
DECLARE
  pay record;
  rev record;
  balance bigint;
BEGIN
  -- One writer at a time per (custodian, job), so the balance check below cannot race.
  PERFORM pg_advisory_xact_lock(hashtextextended('cash-custody:' || NEW."custodianId" || ':' || NEW."sourceJobSheetId", 0));

  IF NEW."kind" = 'COLLECTED' THEN
    SELECT p."method", p."cashCollectorId", p."amountSatang", p."status", p."saleId", s."sourceJobSheetId"
      INTO pay FROM "UpsellPayment" p JOIN "UpsellSale" s ON s."id" = p."saleId" WHERE p."id" = NEW."paymentId";
    IF NOT FOUND OR pay."method" <> 'CASH' THEN
      RAISE EXCEPTION 'UPSELL_CUSTODY_NOT_CASH: custody comes only from a cash payment';
    END IF;
    -- Cash is held by the guide who collected it — never handed to another guide.
    IF pay."cashCollectorId" IS DISTINCT FROM NEW."custodianId" THEN
      RAISE EXCEPTION 'UPSELL_CUSTODY_NOT_COLLECTOR: the custodian must be the guide who collected the cash';
    END IF;
    IF pay."status" NOT IN ('COLLECTED', 'CONFIRMED') THEN
      RAISE EXCEPTION 'UPSELL_CUSTODY_PAYMENT_STATUS: payment is %, not collected', pay."status";
    END IF;
    IF pay."amountSatang" <> NEW."amountSatang" THEN
      RAISE EXCEPTION 'UPSELL_CUSTODY_AMOUNT: custody % satang does not match the payment % satang', NEW."amountSatang", pay."amountSatang";
    END IF;
    IF pay."sourceJobSheetId" <> NEW."sourceJobSheetId" OR (NEW."saleId" IS NOT NULL AND NEW."saleId" <> pay."saleId") THEN
      RAISE EXCEPTION 'UPSELL_CUSTODY_JOB: custody belongs to the job the sale was made on';
    END IF;
  ELSIF NEW."kind" = 'REVERSAL' THEN
    SELECT "custodianId", "sourceJobSheetId", "amountSatang", "kind" INTO rev FROM "CashCustodyEntry" WHERE "id" = NEW."reversesId";
    IF NOT FOUND OR rev."kind" = 'REVERSAL' THEN
      RAISE EXCEPTION 'UPSELL_CUSTODY_REVERSAL: a reversal negates one existing, non-reversal entry';
    END IF;
    IF rev."custodianId" <> NEW."custodianId" OR rev."sourceJobSheetId" <> NEW."sourceJobSheetId" OR NEW."amountSatang" <> -rev."amountSatang" THEN
      RAISE EXCEPTION 'UPSELL_CUSTODY_REVERSAL: a reversal must negate the entry exactly, for the same guide and job';
    END IF;
  END IF;

  SELECT COALESCE(SUM("amountSatang"), 0) INTO balance FROM "CashCustodyEntry"
   WHERE "custodianId" = NEW."custodianId" AND "sourceJobSheetId" = NEW."sourceJobSheetId";
  IF balance + NEW."amountSatang" < 0 THEN
    RAISE EXCEPTION 'UPSELL_CUSTODY_NEGATIVE: guide % would hold % satang for job %', NEW."custodianId", balance + NEW."amountSatang", NEW."sourceJobSheetId";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER cash_custody_insert_guard BEFORE INSERT ON "CashCustodyEntry"
  FOR EACH ROW EXECUTE FUNCTION cash_custody_insert_guard();

-- Settlements: confirmed money is never edited; only a DRAFT may be deleted.
CREATE FUNCTION cash_settlement_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'UPSELL_SETTLEMENT_IMMUTABLE: settlement % is %; it cannot be deleted', OLD."settlementNo", OLD."status";
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" IN ('CONFIRMED', 'REVERSED') THEN
    IF NEW."guideId" IS DISTINCT FROM OLD."guideId" OR NEW."sourceJobSheetId" IS DISTINCT FROM OLD."sourceJobSheetId"
       OR NEW."expectedSatang" IS DISTINCT FROM OLD."expectedSatang" OR NEW."remittedSatang" IS DISTINCT FROM OLD."remittedSatang"
       OR NEW."method" IS DISTINCT FROM OLD."method" OR NEW."bankRefNormalized" IS DISTINCT FROM OLD."bankRefNormalized"
       OR NEW."bankAccountKey" IS DISTINCT FROM OLD."bankAccountKey" OR NEW."settlementNo" IS DISTINCT FROM OLD."settlementNo"
       OR NEW."confirmedAt" IS DISTINCT FROM OLD."confirmedAt" OR NEW."confirmedById" IS DISTINCT FROM OLD."confirmedById" THEN
      RAISE EXCEPTION 'UPSELL_SETTLEMENT_IMMUTABLE: settlement % is %; its money cannot change', OLD."settlementNo", OLD."status";
    END IF;
    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (OLD."status" = 'CONFIRMED' AND NEW."status" = 'REVERSED') THEN
      RAISE EXCEPTION 'UPSELL_SETTLEMENT_IMMUTABLE: settlement % cannot go from % to %', OLD."settlementNo", OLD."status", NEW."status";
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER cash_settlement_guard BEFORE UPDATE OR DELETE ON "CashSettlement"
  FOR EACH ROW EXECUTE FUNCTION cash_settlement_guard();
