-- Tour Upsell — Route Extension rules (PR3). Owner decisions of 19 Nov 2026 (plan v11, 00-B).
--
-- M1  A Route Extension is sold only on the tours an Admin lists for it (eligibleSourceTourIds,
--     the PR2 column, until now JOIN_SOURCE_TOUR only), and the guide remits its cash by bank
--     transfer only (remittanceMethod = BANK_TRANSFER, like Three Temples on-site).
-- M1b The guest pays a Route Extension in cash to the guide, nothing else
--     (allowedPaymentMethods = {CASH}). BANK_TRANSFER is how the guide hands the cash in — never
--     how the guest pays.
-- M1c A Route Extension is priced per guest (pricingBasis = PER_GUEST) and has no discount
--     (priceOverridePermission = NONE, "Not allowed") — owner, 19 Nov 2026. A sale under one
--     carries the version's own price, per guest, with no override (M3).
-- M2 / M2b  The seeded RTE-WPWA v1 still carries the old rules (remittance ANY, guest pays
--     CASH or BANK_TRANSFER). The owner approved changing it here, on one condition: the
--     migration stops — it never overwrites silently — unless RTE-WPWA is exactly what the
--     seed left (one unsold, inactive version, no tours, the old values). On a new database the
--     product does not exist yet (the seed runs after migrations) and there is nothing to change.
-- M3  The database refuses a Route Extension / on-site sale on a tour its version does not
--     list, and a payment by a method its version does not allow.
--
-- Nothing here sells anything; every feature switch stays off.

-- ─── M1 + M1b: the per-type rules ─────────────────────────────────────────────────────────
-- The same function as 20261118120000_upsell_products, with the Route Extension branch
-- rewritten. JOIN_SOURCE_TOUR and NEW_TOUR are unchanged.
CREATE OR REPLACE FUNCTION upsell_product_version_type_rules() RETURNS trigger AS $$
DECLARE
  t text;
  bad text := NULL;
BEGIN
  SELECT "productType" INTO t FROM "UpsellProduct" WHERE "id" = NEW."productId";

  IF t = 'JOIN_SOURCE_TOUR' THEN
    IF NEW."allowedPaymentMethods" IS DISTINCT FROM ARRAY['CASH']::text[] THEN bad := 'is paid in cash to the guide only';
    ELSIF NEW."pricingBasis" <> 'PER_GUEST' THEN bad := 'is priced per guest';
    ELSIF NOT NEW."createsNewBooking" OR NEW."createsNewJob" OR NEW."serviceTourId" IS NOT NULL THEN
      bad := 'creates a booking on the guide''s existing job, never a new job or a tour of its own';
    ELSIF cardinality(NEW."eligibleSourceTourIds") = 0 THEN bad := 'needs at least one eligible tour';
    -- The owner's list (18 Nov 2026). A settings page may narrow it; nothing may widen it.
    ELSIF NOT (NEW."eligibleSourceTourIds" <@ ARRAY['T-001', 'T-002']::text[]) THEN bad := 'joins only T-001 or T-002';
    ELSIF EXISTS (SELECT 1 FROM unnest(NEW."eligibleSourceTourIds") x WHERE btrim(x) = '')
       OR cardinality(NEW."eligibleSourceTourIds") <> (SELECT count(DISTINCT x) FROM unnest(NEW."eligibleSourceTourIds") x) THEN
      bad := 'lists each eligible tour once, by id';
    ELSIF NOT NEW."allowsOtaMix" THEN bad := 'joins jobs that carry OTA guests';
    ELSIF NEW."remittanceMethod" <> 'BANK_TRANSFER' THEN bad := 'is remitted by bank transfer';
    ELSIF NEW."fixedCostPerGuestSatang" <> 0 OR NEW."fixedCostBasis" IS NOT NULL OR NEW."fixedCostCategory" IS NOT NULL THEN
      bad := 'has no fixed cost';
    ELSIF NEW."incentivePerGuestSatang" <> 0 OR NEW."incentiveTrigger" <> 'NONE' THEN bad := 'has no incentive';
    ELSIF NEW."serviceScope" <> 'EXISTING_GUIDE' THEN bad := 'is served by the guide who sold it';
    ELSIF NEW."capacityGroupKey" IS NOT NULL OR NEW."serviceValidityDays" IS NOT NULL OR NEW."checkoutLinkExpiryMinutes" IS NOT NULL THEN
      bad := 'is used on the job it was sold on — no seat group, validity period or payment link';
    END IF;

  ELSIF t = 'ROUTE_EXTENSION' THEN
    -- Sold by the guide on their own job, paid in cash to them, handed in by bank transfer.
    -- The tour list may be empty (then it is sold nowhere, and cannot be activated); every
    -- tour on it must exist, once.
    IF NEW."allowedPaymentMethods" IS DISTINCT FROM ARRAY['CASH']::text[] THEN bad := 'is paid in cash to the guide only';
    ELSIF NEW."pricingBasis" <> 'PER_GUEST' THEN bad := 'is priced per guest';
    ELSIF NEW."priceOverridePermission" <> 'NONE' THEN bad := 'has no discount: its price is never overridden';
    ELSIF NEW."createsNewBooking" OR NEW."createsNewJob" THEN bad := 'stays on the source job: no new booking or job';
    ELSIF EXISTS (SELECT 1 FROM unnest(NEW."eligibleSourceTourIds") x WHERE btrim(x) = '')
       OR cardinality(NEW."eligibleSourceTourIds") <> (SELECT count(DISTINCT x) FROM unnest(NEW."eligibleSourceTourIds") x) THEN
      bad := 'lists each eligible tour once, by id';
    ELSIF EXISTS (SELECT 1 FROM unnest(NEW."eligibleSourceTourIds") x WHERE NOT EXISTS (SELECT 1 FROM "Tour" WHERE "id" = x)) THEN
      bad := 'lists only tours that exist';
    ELSIF NEW."allowsOtaMix" THEN bad := 'never shares a job with OTA guests (JOIN_SOURCE_TOUR only)';
    ELSIF NEW."remittanceMethod" <> 'BANK_TRANSFER' THEN bad := 'is remitted by bank transfer';
    -- Delivered on the job it was sold on, with no service report or approval of its own:
    -- nothing could earn a fixed cost or an incentive on it, and nothing could expire.
    ELSIF NEW."fixedCostPerGuestSatang" <> 0 OR NEW."fixedCostBasis" IS NOT NULL OR NEW."fixedCostCategory" IS NOT NULL THEN
      bad := 'has no fixed cost';
    ELSIF NEW."incentivePerGuestSatang" <> 0 OR NEW."incentiveTrigger" <> 'NONE' THEN bad := 'has no incentive';
    ELSIF NEW."serviceValidityDays" IS NOT NULL OR NEW."checkoutLinkExpiryMinutes" IS NOT NULL
       OR NEW."capacityGroupKey" IS NOT NULL OR NEW."serviceScope" <> 'EXISTING_GUIDE' THEN
      bad := 'is used on the job it was sold on, by its guide — no validity period, payment link or seat group';
    END IF;

  ELSE
    -- NEW_TOUR: only a seat on an existing job joins one, mixes with OTA guests, or fixes the remittance.
    IF cardinality(NEW."eligibleSourceTourIds") <> 0 THEN bad := 'has no eligible source tours (JOIN_SOURCE_TOUR only)';
    ELSIF NEW."allowsOtaMix" THEN bad := 'never shares a job with OTA guests (JOIN_SOURCE_TOUR only)';
    ELSIF NEW."remittanceMethod" <> 'ANY' THEN bad := 'leaves the remittance method open (JOIN_SOURCE_TOUR only)';
    ELSIF t = 'NEW_TOUR' AND NOT (NEW."createsNewBooking" AND NEW."createsNewJob" AND NEW."serviceTourId" IS NOT NULL) THEN
      bad := 'creates a new booking and job on its own tour';
    END IF;
  END IF;

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'UPSELL_PRODUCT_RULE: a % product %', t, bad;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ─── M2 + M2b: the seeded RTE-WPWA ────────────────────────────────────────────────────────
DO $$
DECLARE
  p record;
  v record;
  n_versions int;
  n_sales int;
  methods text[];
BEGIN
  SELECT "id", "productType", "active" INTO p FROM "UpsellProduct" WHERE "productCode" = 'RTE-WPWA';
  IF NOT FOUND THEN
    RETURN; -- a new database: the seed creates RTE-WPWA with the new rules (lib/upsell/catalog)
  END IF;

  IF p."productType" <> 'ROUTE_EXTENSION' THEN
    RAISE EXCEPTION 'UPSELL_MIGRATION_STOP: RTE-WPWA is %, not ROUTE_EXTENSION — nothing changed', p."productType";
  END IF;
  IF p."active" THEN
    RAISE EXCEPTION 'UPSELL_MIGRATION_STOP: RTE-WPWA is active — deactivate it first; nothing changed';
  END IF;
  SELECT count(*) INTO n_sales FROM "UpsellSale" s JOIN "UpsellProductVersion" x ON x."id" = s."productVersionId" WHERE x."productId" = p."id";
  IF n_sales > 0 THEN
    RAISE EXCEPTION 'UPSELL_MIGRATION_STOP: RTE-WPWA has % sale(s) — its sold rules are never rewritten; nothing changed', n_sales;
  END IF;
  SELECT count(*) INTO n_versions FROM "UpsellProductVersion" WHERE "productId" = p."id";
  IF n_versions <> 1 THEN
    RAISE EXCEPTION 'UPSELL_MIGRATION_STOP: RTE-WPWA has % versions, expected only the seeded v1; nothing changed', n_versions;
  END IF;

  SELECT * INTO v FROM "UpsellProductVersion" WHERE "productId" = p."id";
  SELECT array_agg(m ORDER BY m) INTO methods FROM unnest(v."allowedPaymentMethods") m;
  IF v."version" <> 1 OR v."remittanceMethod" <> 'ANY' OR methods IS DISTINCT FROM ARRAY['BANK_TRANSFER', 'CASH']::text[]
     OR v."pricingBasis" <> 'PER_GUEST' OR v."priceOverridePermission" <> 'NONE'
     OR cardinality(v."eligibleSourceTourIds") <> 0 OR v."allowsOtaMix" OR v."createsNewBooking" OR v."createsNewJob"
     OR v."fixedCostPerGuestSatang" <> 0 OR v."incentivePerGuestSatang" <> 0 THEN
    RAISE EXCEPTION 'UPSELL_MIGRATION_STOP: RTE-WPWA v1 is not as the seed left it (remittance %, methods %, % tours) — nothing changed',
      v."remittanceMethod", v."allowedPaymentMethods", cardinality(v."eligibleSourceTourIds");
  END IF;

  UPDATE "UpsellProductVersion"
     SET "remittanceMethod" = 'BANK_TRANSFER', "allowedPaymentMethods" = ARRAY['CASH']::text[]
   WHERE "id" = v."id";
  UPDATE "UpsellProduct" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = p."id";
  INSERT INTO "AuditLog" ("id", "actorId", "actorRole", "action", "entityType", "entityId", "detail")
  VALUES ('mig-' || md5(random()::text || clock_timestamp()::text), NULL, 'MIGRATION', 'upsell.product.migrated', 'UpsellProduct', p."id",
          jsonb_build_object('productCode', 'RTE-WPWA', 'version', 1, 'migration', '20261120090000_upsell_route_extension_rules',
                             'remittanceMethod', jsonb_build_array('ANY', 'BANK_TRANSFER'),
                             'allowedPaymentMethods', jsonb_build_array(to_jsonb(v."allowedPaymentMethods"), to_jsonb(ARRAY['CASH'])),
                             'approvedBy', 'owner, 19 Nov 2026 (plan v11, Q7 + Q8)'));
END $$;

-- ─── M3: sales and payments follow their version ──────────────────────────────────────────

-- A Route Extension or on-site seat is sold only on a job whose tour its version lists; a Route
-- Extension sale is per guest, at its version's own price, never overridden.
CREATE FUNCTION upsell_sale_eligibility() RETURNS trigger AS $$
DECLARE
  t text;
  tours text[];
  price int;
  job_tour text;
BEGIN
  SELECT p."productType", v."eligibleSourceTourIds", v."unitPriceSatang" INTO t, tours, price
    FROM "UpsellProductVersion" v JOIN "UpsellProduct" p ON p."id" = v."productId" WHERE v."id" = NEW."productVersionId";
  IF t = 'ROUTE_EXTENSION' AND (NEW."pricingBasis" <> 'PER_GUEST' OR NEW."unitPriceSatang" <> price
       OR NEW."priceOverrideReason" IS NOT NULL OR NEW."priceOverrideApprovedById" IS NOT NULL) THEN
    RAISE EXCEPTION 'UPSELL_SALE_PRICE: a ROUTE_EXTENSION sale is per guest at its version''s price (% satang), with no discount', price;
  END IF;
  IF t IN ('ROUTE_EXTENSION', 'JOIN_SOURCE_TOUR') THEN
    SELECT "tourId" INTO job_tour FROM "JobSheet" WHERE "id" = NEW."sourceJobSheetId";
    IF job_tour IS NULL OR NOT (job_tour = ANY (tours)) THEN
      RAISE EXCEPTION 'UPSELL_SALE_NOT_ELIGIBLE: % is not sold on tour % (its version lists %)', t, job_tour, tours;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER upsell_sale_eligibility BEFORE INSERT ON "UpsellSale"
  FOR EACH ROW EXECUTE FUNCTION upsell_sale_eligibility();

-- A payment uses a method the sale's version allows.
CREATE FUNCTION upsell_payment_method_allowed() RETURNS trigger AS $$
DECLARE
  allowed text[];
BEGIN
  -- A method the table does not know at all is UpsellPayment_method_check's to refuse.
  IF NEW."method" NOT IN ('CASH', 'BANK_TRANSFER') THEN RETURN NEW; END IF;
  SELECT v."allowedPaymentMethods" INTO allowed
    FROM "UpsellSale" s JOIN "UpsellProductVersion" v ON v."id" = s."productVersionId" WHERE s."id" = NEW."saleId";
  IF allowed IS NULL OR NOT (NEW."method" = ANY (allowed)) THEN
    RAISE EXCEPTION 'UPSELL_PAYMENT_METHOD: this sale''s product takes % only, not %', allowed, NEW."method";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER upsell_payment_method_allowed BEFORE INSERT ON "UpsellPayment"
  FOR EACH ROW EXECUTE FUNCTION upsell_payment_method_allowed();
