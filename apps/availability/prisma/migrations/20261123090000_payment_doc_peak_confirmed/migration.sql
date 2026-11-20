-- PEAK confirmed a document's payment, stamped before FolkOPS marks the jobs paid. A local
-- failure after it leaves the document PAYMENT_UNCERTAIN, and it can never be reset to
-- AWAITING_PAYMENT (that would offer a second payment).
ALTER TABLE "GuidePaymentDocument" ADD COLUMN "peakPaymentConfirmedAt" TIMESTAMP(3);

CREATE OR REPLACE FUNCTION guide_payment_document_peak_confirmed_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."peakPaymentConfirmedAt" IS NOT NULL THEN
    IF NEW."peakPaymentConfirmedAt" IS DISTINCT FROM OLD."peakPaymentConfirmedAt" THEN
      RAISE EXCEPTION 'PAYMENT_PEAK_CONFIRMED: PEAK confirmed this payment; the stamp is kept';
    END IF;
    IF NEW."status" = 'AWAITING_PAYMENT' THEN
      RAISE EXCEPTION 'PAYMENT_PEAK_CONFIRMED: PEAK confirmed this payment; it can never await payment again';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER guide_payment_document_peak_confirmed_guard
  BEFORE UPDATE ON "GuidePaymentDocument"
  FOR EACH ROW EXECUTE FUNCTION guide_payment_document_peak_confirmed_guard();
