-- Operator-pinned booking date/slot: a rebooking made outside the OTA that the 30-min
-- Bokun/GYG sync must NOT drag back to the channel's date. Defaults false, so every
-- existing booking keeps syncing exactly as before.
ALTER TABLE "Booking" ADD COLUMN "datePinned" BOOLEAN NOT NULL DEFAULT false;
