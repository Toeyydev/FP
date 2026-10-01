-- The booking's Rate as Bókun names it ("Tour with all entrance tickets", "Standard rate", …).
-- It may SUGGEST the payer of a job's expense rows (lib/rate-payer) — a suggestion only,
-- never accounting evidence and never a confirmation.
--
-- Additive only: one nullable column. No UPDATE, DELETE or DROP, and no rows written by a
-- deploy — the value is filled in as bookings are next imported (webhook or autosync).

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN "rateTitle" TEXT;
