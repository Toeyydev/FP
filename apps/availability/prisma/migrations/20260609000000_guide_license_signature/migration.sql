-- Guide tour-guide licence number (manual) + signature image (encrypted), for the job order.
ALTER TABLE "User" ADD COLUMN "licenseNo" TEXT;
ALTER TABLE "User" ADD COLUMN "signature" TEXT;
