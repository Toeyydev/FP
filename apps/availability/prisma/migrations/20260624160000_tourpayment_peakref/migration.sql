-- Per-payment PEAK ref: a transfer covers a batch of tours, each carries its ref
ALTER TABLE "TourPayment" ADD COLUMN "peakRef" TEXT;
