-- Who recorded a check-in. NULL means the guide did it themselves from their own
-- phone, which is every existing row — that is the GPS-verified case and its
-- meaning must not change. A value means an operator recorded it on the guide's
-- behalf, which carries no location proof and has to stay distinguishable.
ALTER TABLE "Checkin" ADD COLUMN "recordedById" TEXT;
ALTER TABLE "Checkin" ADD COLUMN "recordedByRole" TEXT;
