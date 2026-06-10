-- Operator can block a guide from receiving job offers (stays active otherwise).
ALTER TABLE "User" ADD COLUMN "offerBlocked" BOOLEAN NOT NULL DEFAULT false;
