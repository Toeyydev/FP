-- Route Extension: which guests bought it (owner approved, 20 Nov 2026; mockup pr4e, simplified by
-- the owner: the guide ticks the guests buying it and presses ONE "ยืนยันเก็บเงินแล้ว" — no office
-- decision per package, no separate check step). Each allocation keeps the booking and how many of
-- its guests, the booking's original purchase (source, product, rate) as it was — context only, the
-- system never judges it — and the cash-received acknowledgement: the exact words of the button the
-- guide pressed, who and when. ACTIVE until the sale is reversed (RELEASED, once). Never deleted.
-- Sales made before this migration have none and keep counting against the job's guests.

CREATE TABLE "UpsellSaleAllocation" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "guests" INTEGER NOT NULL,
    "bookingRef" TEXT NOT NULL,
    "bookingPaxAtSale" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "packageKey" TEXT NOT NULL,
    "packageName" TEXT NOT NULL,
    "rateKey" TEXT NOT NULL,
    "rateName" TEXT NOT NULL,
    "cashAckText" TEXT NOT NULL,
    "cashAckById" TEXT NOT NULL,
    "cashAckAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "releasedAt" TIMESTAMP(3),
    "releasedByReversalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UpsellSaleAllocation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UpsellSaleAllocation_saleId_bookingId_key" ON "UpsellSaleAllocation"("saleId", "bookingId");
CREATE INDEX "UpsellSaleAllocation_bookingId_status_idx" ON "UpsellSaleAllocation"("bookingId", "status");
ALTER TABLE "UpsellSaleAllocation" ADD CONSTRAINT "UpsellSaleAllocation_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "UpsellSale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UpsellSaleAllocation" ADD CONSTRAINT "UpsellSaleAllocation_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UpsellSaleAllocation" ADD CONSTRAINT "UpsellSaleAllocation_guests_check" CHECK ("guests" > 0 AND "guests" <= "bookingPaxAtSale");
ALTER TABLE "UpsellSaleAllocation" ADD CONSTRAINT "UpsellSaleAllocation_status_check" CHECK ("status" IN ('ACTIVE', 'RELEASED'));
ALTER TABLE "UpsellSaleAllocation" ADD CONSTRAINT "UpsellSaleAllocation_released_check" CHECK (("status" = 'RELEASED') = ("releasedAt" IS NOT NULL));
ALTER TABLE "UpsellSaleAllocation" ADD CONSTRAINT "UpsellSaleAllocation_cash_ack_check" CHECK (length(btrim("cashAckText")) > 0 AND "cashAckById" <> '');

-- Born ACTIVE; then never edited but to be released once.
CREATE FUNCTION upsell_allocation_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'UPSELL_ALLOCATION_KEPT: an allocation is never deleted'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' THEN RAISE EXCEPTION 'UPSELL_ALLOCATION_KEPT: an allocation starts ACTIVE'; END IF;
    RETURN NEW;
  END IF;
  IF NEW."saleId" IS DISTINCT FROM OLD."saleId" OR NEW."bookingId" IS DISTINCT FROM OLD."bookingId" OR NEW."guests" IS DISTINCT FROM OLD."guests"
     OR NEW."bookingRef" IS DISTINCT FROM OLD."bookingRef" OR NEW."bookingPaxAtSale" IS DISTINCT FROM OLD."bookingPaxAtSale" OR NEW."source" IS DISTINCT FROM OLD."source"
     OR NEW."packageKey" IS DISTINCT FROM OLD."packageKey" OR NEW."packageName" IS DISTINCT FROM OLD."packageName" OR NEW."rateKey" IS DISTINCT FROM OLD."rateKey"
     OR NEW."rateName" IS DISTINCT FROM OLD."rateName" OR NEW."cashAckText" IS DISTINCT FROM OLD."cashAckText" OR NEW."cashAckById" IS DISTINCT FROM OLD."cashAckById"
     OR NEW."cashAckAt" IS DISTINCT FROM OLD."cashAckAt" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR OLD."status" = 'RELEASED' THEN
    RAISE EXCEPTION 'UPSELL_ALLOCATION_KEPT: an allocation is only released, once';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER upsell_allocation_guard BEFORE INSERT OR UPDATE OR DELETE ON "UpsellSaleAllocation" FOR EACH ROW EXECUTE FUNCTION upsell_allocation_guard();

-- A booking's ACTIVE allocations of one product never exceed its guests (the service also takes
-- reported no-shows off; this is the floor the database holds whatever the code does). The
-- booking row is locked first, so two transactions allocating the same booking are serialised
-- here too — a bare SELECT sum would not be.
CREATE FUNCTION upsell_allocation_capacity() RETURNS trigger AS $$
DECLARE used int; booking_pax int;
BEGIN
  SELECT coalesce(b."pax", 0) INTO booking_pax FROM "Booking" b WHERE b."id" = NEW."bookingId" FOR UPDATE;
  SELECT coalesce(sum(a."guests"), 0) INTO used FROM "UpsellSaleAllocation" a JOIN "UpsellSale" s ON s."id" = a."saleId" JOIN "UpsellProductVersion" v ON v."id" = s."productVersionId"
   WHERE a."bookingId" = NEW."bookingId" AND a."status" = 'ACTIVE'
     AND v."productId" = (SELECT v2."productId" FROM "UpsellSale" s2 JOIN "UpsellProductVersion" v2 ON v2."id" = s2."productVersionId" WHERE s2."id" = NEW."saleId");
  IF used > booking_pax THEN RAISE EXCEPTION 'UPSELL_ALLOCATION_OVER: booking % has % guests, % would have this extra', NEW."bookingId", booking_pax, used; END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER upsell_allocation_capacity AFTER INSERT ON "UpsellSaleAllocation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION upsell_allocation_capacity();

-- A Route Extension sold from now on names its guests: its allocations add up to its guests.
-- (Sales recorded before this migration are not touched — they have none.)
CREATE FUNCTION upsell_sale_allocated() RETURNS trigger AS $$
DECLARE t text; total int;
BEGIN
  SELECT p."productType" INTO t FROM "UpsellProductVersion" v JOIN "UpsellProduct" p ON p."id" = v."productId" WHERE v."id" = NEW."productVersionId";
  IF t <> 'ROUTE_EXTENSION' THEN RETURN NULL; END IF;
  SELECT coalesce(sum("guests"), 0) INTO total FROM "UpsellSaleAllocation" WHERE "saleId" = NEW."id";
  IF total <> NEW."guests" THEN RAISE EXCEPTION 'UPSELL_SALE_ALLOCATION: % guests sold, % chosen by booking', NEW."guests", total; END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER upsell_sale_allocated AFTER INSERT ON "UpsellSale" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION upsell_sale_allocated();
