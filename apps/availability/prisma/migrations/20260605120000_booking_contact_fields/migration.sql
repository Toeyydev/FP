-- Booking: manual-entry + contact fields (all additive, nullable / defaulted)
ALTER TABLE "Booking" ADD COLUMN "nationality" TEXT;
ALTER TABLE "Booking" ADD COLUMN "email" TEXT;
ALTER TABLE "Booking" ADD COLUMN "phone" TEXT;
ALTER TABLE "Booking" ADD COLUMN "specialRequests" TEXT;
ALTER TABLE "Booking" ADD COLUMN "notes" TEXT;
ALTER TABLE "Booking" ADD COLUMN "bookingDate" TEXT;
ALTER TABLE "Booking" ADD COLUMN "paymentStatus" TEXT NOT NULL DEFAULT 'unpaid';
