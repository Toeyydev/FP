-- Per-tour payment slip (e-slip) link, for paying one or several tours in a single transfer.
ALTER TABLE "TourPayment" ADD COLUMN "eslipUrl" TEXT;
