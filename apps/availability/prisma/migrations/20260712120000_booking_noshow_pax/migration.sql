-- Partial no-shows: track how many of a booking's pax didn't arrive (0..pax).
ALTER TABLE "Booking" ADD COLUMN "noShowPax" INTEGER NOT NULL DEFAULT 0;

-- Backfill: existing whole-booking no-shows count all of their pax as absent.
UPDATE "Booking" SET "noShowPax" = COALESCE("pax", 0) WHERE "noShow" = true;
