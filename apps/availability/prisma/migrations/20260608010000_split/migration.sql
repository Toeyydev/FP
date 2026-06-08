-- Over-capacity split: which guide a booking is split to
ALTER TABLE "Booking" ADD COLUMN "assignedGuideId" TEXT;
